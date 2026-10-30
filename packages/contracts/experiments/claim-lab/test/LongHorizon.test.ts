import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fixture, deposit, clear } from "./helpers";
import { ArchiveLog, ArchivedProof, ProofArchive } from "../indexer/ProofArchive";

const DAY = 86_400;
type Entitlement = { account: string; index: bigint; generation: bigint; balance: bigint };
type Round = { id: number; prize: bigint; ticket: bigint; rootHash: string; rootSum: string;
  entries: Entitlement[]; awards: Map<string, bigint> };

async function setup() {
  const f = await fixture(2, 2);
  f.pool = await (await ethers.getContractFactory("ReusableMerkleProbe")).deploy(await f.token.getAddress(), f.depth);
  f.address = await f.pool.getAddress();
  return f;
}

async function admit(f: any, user: any, amount: bigint) {
  await deposit(f, user, amount);
  const request = await f.pool.pendingAdmissionOf(user.address);
  const proof = await fhevm.publicDecrypt([request.marker]);
  await f.pool.finalizeAdmission(user.address, request.nonce, true, proof.decryptionProof);
}

async function options(f: any, file: string) {
  return { path: file, chainId: "31337", pool: f.address, depth: f.depth, zero: await f.pool.zero(),
    emptyHashes: await Promise.all(Array.from({ length: f.depth + 1 }, (_, level) => f.pool.emptyHash(level))) };
}

async function events(f: any): Promise<ArchiveLog[]> {
  const deployed = await f.pool.deploymentTransaction().wait();
  const logs = await ethers.provider.getLogs({ address: f.address, fromBlock: deployed.blockNumber, toBlock: "latest" });
  const supported = new Set(["SlotAssigned", "SlotReleased", "NodeUpdated", "Closed"]);
  return logs.flatMap(log => {
    const parsed = f.pool.interface.parseLog(log);
    if (!parsed || !supported.has(parsed.name)) return [];
    return [{ blockNumber: log.blockNumber, blockHash: log.blockHash, logIndex: log.index, name: parsed.name,
      args: Object.fromEntries(parsed.fragment.inputs.map((p: any, i: number) => [p.name, parsed.args[i]])) }];
  });
}

function check(f: any, proof: ArchivedProof, overrides: Partial<ArchivedProof> = {}) {
  const p = { ...proof, ...overrides };
  return f.pool.claimMerkle(p.drawId, p.account, p.index, p.generation, p.balance,
    p.siblingHashes, p.siblingSums, p.parentSums);
}

// The oracle uses explicit test deposits and slot ownership, never archive paths
// or contract award state. Only the random ticket is read from the FHE debugger.
async function close(f: any, id: number, prize: bigint, entries: Entitlement[], timestamp?: number): Promise<Round> {
  await deposit(f, f.admin, prize, undefined, true);
  if (timestamp !== undefined) await ethers.provider.send("evm_setNextBlockTimestamp", [timestamp]);
  const receipt = await (await f.pool.closeDraw()).wait();
  if (timestamp !== undefined) expect((await ethers.provider.getBlock(receipt.blockNumber))!.timestamp).to.equal(timestamp);
  const draw = await f.pool.draws(id);
  const sum = entries.reduce((total, entry) => total + entry.balance, 0n);
  // The local mock has one mutable coprocessor event cursor; all decrypts are serial.
  expect(await clear(draw.sum)).to.equal(sum);
  expect(await clear(draw.prize)).to.equal(prize);
  expect(await clear(draw.remaining)).to.equal(prize);
  const ticket = await clear(draw.ticket);
  expect(ticket).to.be.greaterThanOrEqual(0n).and.lessThan(sum);
  const awards = new Map<string, bigint>();
  let prefix = 0n;
  for (const entry of [...entries].sort((a, b) => a.index < b.index ? -1 : 1)) {
    awards.set(entry.account, ticket >= prefix && ticket < prefix + entry.balance ? prize : 0n);
    prefix += entry.balance;
  }
  expect([...awards.values()].reduce((total, value) => total + value, 0n)).to.equal(prize);
  return { id, prize, ticket, rootHash: draw.rootHash, rootSum: draw.sum, entries: entries.map(e => ({ ...e })), awards };
}

async function backing(f: any, principal: bigint, reserve: bigint, remaining: bigint) {
  expect(await clear(await f.pool.totalPrincipal())).to.equal(principal);
  expect(await clear(await f.pool.totalPending())).to.equal(0n);
  expect(await clear(await f.pool.activeTotal())).to.equal(principal);
  expect(await clear(await f.pool.reserve())).to.equal(reserve);
  expect(await clear(await f.token.confidentialBalanceOf(f.address))).to.equal(principal + reserve + remaining);
}

function historical(archive: ProofArchive, round: Round, entry: Entitlement) {
  const proof = archive.proof(round.id, entry.account, { rootHash: round.rootHash, rootSum: round.rootSum });
  expect(proof.account).to.equal(entry.account);
  expect(proof.index).to.equal(entry.index);
  expect(proof.generation).to.equal(entry.generation);
  expect(proof.rootHash).to.equal(round.rootHash);
  expect(proof.rootSum).to.equal(round.rootSum);
  return proof;
}

describe("Long-horizon historical prize recovery (local FHE mock)", function () {
  this.timeout(600_000);

  it("rebuilds exact historical proofs from chain events after SQLite restart and complete slot replacement", async function () {
    const f = await setup(), [alice, bob] = f.users;
    const directory = mkdtempSync(path.join(tmpdir(), "kettigo-cold-history-"));
    const opened: ProofArchive[] = [];
    try {
      await admit(f, alice, 3n);
      const first = await close(f, 1, 23n, [{ account: alice.address, index: 0n, generation: 1n, balance: 3n }]);
      const config = await options(f, path.join(directory, "live.sqlite"));
      let live = new ProofArchive(config); opened.push(live); live.ingest(await events(f));
      const original = historical(live, first, first.entries[0]);
      await f.pool.connect(alice).withdrawAllAndExit();
      await admit(f, bob, 7n);
      const second = await close(f, 2, 29n, [{ account: bob.address, index: 0n, generation: 2n, balance: 7n }]);
      await f.pool.connect(bob).withdrawAllAndExit();
      live.ingest(await events(f)); live.close();
      live = new ProofArchive(config); opened.push(live);
      const cold = new ProofArchive({ ...config, path: path.join(directory, "cold.sqlite") }); opened.push(cold);
      const logs = await events(f);
      cold.ingest([...logs].reverse()); cold.ingest(logs); // cold replay, shuffled input and duplicate delivery
      expect(live.proof(1, alice.address)).to.deep.equal(original);
      expect(cold.proof(1, alice.address)).to.deep.equal(original);
      expect(cold.proof(2, bob.address)).to.deep.equal(live.proof(2, bob.address));
      expect(() => cold.proof(1, bob.address)).to.throw("Account had no eligible slot");
      expect(() => cold.proof(2, alice.address)).to.throw("Account had no eligible slot");
      expect(() => cold.proof(1, alice.address, { rootHash: second.rootHash, rootSum: second.rootSum })).to.throw("Onchain root mismatch");
      expect(await f.pool.indexPlusOne(alice.address)).to.equal(0n);
      expect(await f.pool.indexPlusOne(bob.address)).to.equal(0n);
      expect(await f.pool.generationOf(0)).to.equal(2n);
      await backing(f, 0n, 0n, 52n);
      for (const round of [first, second]) {
        const entry = round.entries[0], proof = historical(cold, round, entry);
        expect(await f.pool.checked(round.id, entry.account)).to.equal(false);
        expect(await clear(proof.balance)).to.equal(entry.balance);
        await check(f, proof);
        expect(await clear(await f.pool.awardOf(round.id, entry.account))).to.equal(round.awards.get(entry.account));
        expect(await clear((await f.pool.draws(round.id)).remaining)).to.equal(0n);
        await expect(check(f, proof)).to.be.revertedWithCustomError(f.pool, "AlreadyChecked");
      }
      await backing(f, 0n, 0n, 0n);
      expect(await clear(await f.token.confidentialBalanceOf(alice.address))).to.equal(1_000_023n);
      expect(await clear(await f.token.confidentialBalanceOf(bob.address))).to.equal(1_000_029n);
      console.log("    cold recovery: 2 rounds, 2 exact-once checks; reopened SQLite and independent cold event rebuild agree");
    } finally { for (const archive of opened) archive.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("recovers every entitlement after 60 unattended daily rounds, exit/reuse/rejoin, and more than 60 simulated days", async function () {
    const f = await setup(), [alice, bob] = f.users;
    const directory = mkdtempSync(path.join(tmpdir(), "kettigo-sixty-days-"));
    const opened: ProofArchive[] = [];
    try {
      await admit(f, alice, 3n);
      const epoch = (await ethers.provider.getBlock("latest"))!.timestamp;
      const rounds: Round[] = [];
      rounds.push(await close(f, 1, 17n, [{ account: alice.address, index: 0n, generation: 1n, balance: 3n }], epoch + DAY));
      await f.pool.connect(alice).withdrawAllAndExit();
      await admit(f, bob, 7n); // Alice's old slot is now a different owner and generation.
      rounds.push(await close(f, 2, 19n, [{ account: bob.address, index: 0n, generation: 2n, balance: 7n }], epoch + 2 * DAY));
      await admit(f, alice, 4n); // New index; round 1 must retain her old index/generation/balance.
      const absentSince = (await ethers.provider.getBlock("latest"))!.timestamp;
      const eligible = [
        { account: bob.address, index: 0n, generation: 2n, balance: 7n },
        { account: alice.address, index: 1n, generation: 1n, balance: 4n },
      ];
      const config = await options(f, path.join(directory, "archive.sqlite"));
      let archive = new ProofArchive(config); opened.push(archive); archive.ingest(await events(f));
      for (let id = 3; id <= 62; id++) {
        rounds.push(await close(f, id, BigInt(3 + id % 5), eligible, epoch + id * DAY));
        if (id === 32) { // A real SQLite connection restart in the middle of the absence.
          archive.ingest(await events(f)); archive.close(); archive = new ProofArchive(config); opened.push(archive);
        }
        const funded = rounds.reduce((total, round) => total + round.prize, 0n);
        await backing(f, 11n, 0n, funded);
      }
      // No expiry branch is assumed: explicitly leave the oldest funded prize untouched
      // until the user has been inactive for at least 60 full days in EVM time.
      await ethers.provider.send("evm_setNextBlockTimestamp", [epoch + 63 * DAY]);
      await ethers.provider.send("evm_mine", []);
      const returnedAt = (await ethers.provider.getBlock("latest"))!.timestamp;
      expect(returnedAt - absentSince).to.be.at.least(60 * DAY);
      expect(await f.pool.drawCount()).to.equal(62n);
      const states = await Promise.all(rounds.flatMap(round => [alice, bob].map(user => f.pool.checked(round.id, user.address))));
      expect(states.every(value => value === false)).to.equal(true);
      const totalFunded = rounds.reduce((total, round) => total + round.prize, 0n);
      expect(totalFunded).to.equal(336n);
      expect(await clear((await f.pool.draws(1)).remaining)).to.equal(17n);
      expect(await clear((await f.pool.draws(2)).remaining)).to.equal(19n);
      await deposit(f, f.admin, 7n, undefined, true); // Unallocated reserve must survive all historical claims.
      await f.pool.connect(alice).withdrawAllAndExit();
      await f.pool.connect(bob).withdrawAllAndExit();
      expect(await f.pool.activeCount()).to.equal(0n);
      expect(await f.pool.indexPlusOne(alice.address)).to.equal(0n);
      expect(await f.pool.indexPlusOne(bob.address)).to.equal(0n);
      expect(await f.pool.nextIndex()).to.equal(2n);
      expect(await f.pool.freeSlotCount()).to.equal(2n);
      await backing(f, 0n, 7n, totalFunded);
      archive.ingest(await events(f)); archive.close(); archive = new ProofArchive(config); opened.push(archive);
      const cold = new ProofArchive({ ...config, path: path.join(directory, "rebuilt.sqlite") }); opened.push(cold);
      cold.ingest(await events(f));
      expect(cold.listDraws(undefined, 100)).to.deep.equal(archive.listDraws(undefined, 100));
      const oldest = historical(cold, rounds[0], rounds[0].entries[0]);
      await expect(check(f, oldest, { drawId: 2 })).to.be.revertedWithCustomError(f.pool, "InvalidProof");
      await expect(check(f, oldest, { generation: 2n })).to.be.revertedWithCustomError(f.pool, "InvalidProof");
      await expect(check(f, oldest, { siblingHashes: [ethers.ZeroHash, ...oldest.siblingHashes.slice(1)] })).to.be.revertedWithCustomError(f.pool, "InvalidProof");
      await expect(check(f, oldest, { account: bob.address })).to.be.revertedWithCustomError(f.pool, "InvalidProof");
      expect(() => cold.proof(2, alice.address)).to.throw("Account had no eligible slot");
      let outstanding = totalFunded, count = 0;
      const paid = new Map([[alice.address, 0n], [bob.address, 0n]]);
      for (const round of rounds) {
        let roundRemaining = round.prize;
        for (const entry of round.entries) {
          const proof = historical(cold, round, entry);
          expect(proof).to.deep.equal(historical(archive, round, entry));
          expect(await clear(proof.balance)).to.equal(entry.balance);
          const expected = round.awards.get(entry.account)!;
          await check(f, proof); count++;
          expect(await f.pool.checked(round.id, entry.account)).to.equal(true);
          expect(await clear(await f.pool.awardOf(round.id, entry.account))).to.equal(expected);
          roundRemaining -= expected; outstanding -= expected;
          paid.set(entry.account, paid.get(entry.account)! + expected);
          expect(await clear((await f.pool.draws(round.id)).remaining)).to.equal(roundRemaining);
          expect(await clear(await f.token.confidentialBalanceOf(f.address))).to.equal(7n + outstanding);
          await expect(check(f, proof)).to.be.revertedWithCustomError(f.pool, "AlreadyChecked");
        }
        expect(roundRemaining).to.equal(0n);
      }
      expect(count).to.equal(122); // Alice: 1 + 60; Bob: 1 + 60.
      expect(outstanding).to.equal(0n);
      expect(paid.get(alice.address)! + paid.get(bob.address)!).to.equal(totalFunded);
      expect(paid.get(alice.address)!).to.be.at.least(17n);
      expect(paid.get(bob.address)!).to.be.at.least(19n);
      await backing(f, 0n, 7n, 0n);
      for (const user of [alice, bob]) {
        expect(await clear(await f.token.confidentialBalanceOf(user.address))).to.equal(1_000_000n + paid.get(user.address)!);
      }
      console.log(`    long recovery: 62 daily rounds, 60 unattended rounds, 63 simulated days, ${returnedAt - absentSince}s inactivity, ${count} exact-once checks, 336 prize units paid, 7 reserve units retained`);
      console.log("    limitation: EVM time travel with the local FHE mock does not establish actual 60-day Zama ciphertext/ACL retention");
    } finally { for (const archive of opened) archive.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
