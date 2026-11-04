import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { fixture, deposit, withdraw, clear } from "./helpers";
import { ProofArchive, ArchivedProof } from "../indexer/ProofArchive";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { rejects } from "node:assert/strict";
import { FhevmType } from "@fhevm/hardhat-plugin";

async function reusable(depth = 2) {
  const f = await fixture(2, depth);
  f.pool = await (await ethers.getContractFactory("ReusableMerkleProbe")).deploy(await f.token.getAddress(), depth);
  f.address = await f.pool.getAddress();
  return f;
}
async function admission(f: any, user: any, positive: boolean) {
  const request = await f.pool.pendingAdmissionOf(user.address);
  const p = await fhevm.publicDecrypt([request.marker]);
  return f.pool.finalizeAdmission(user.address, request.nonce, positive, p.decryptionProof);
}
async function archiveOptions(f: any, file: string) {
  return { path: file, chainId: "31337", pool: f.address, depth: f.depth, zero: await f.pool.zero(),
    emptyHashes: await Promise.all(Array.from({ length: f.depth + 1 }, (_, l) => f.pool.emptyHash(l))) };
}
async function ingestPool(f: any, archive: ProofArchive) {
  const receipt = await f.pool.deploymentTransaction().wait();
  const raw = await ethers.provider.getLogs({ address: f.address, fromBlock: receipt.blockNumber, toBlock: "latest" });
  const supported = new Set(["SlotAssigned", "SlotReleased", "NodeUpdated", "Closed"]);
  archive.ingest(raw.flatMap(log => {
    const parsed = f.pool.interface.parseLog(log);
    if (!parsed || !supported.has(parsed.name)) return [];
    const args = Object.fromEntries(parsed.fragment.inputs.map((p: any, i: number) => [p.name, parsed.args[i]]));
    return [{ blockNumber: log.blockNumber, blockHash: log.blockHash, logIndex: log.index, name: parsed.name, args }];
  }));
}
function claim(f: any, p: ArchivedProof, overrides: Partial<ArchivedProof> = {}) {
  const v = { ...p, ...overrides };
  return f.pool.claimMerkle(v.drawId, v.account, v.index, v.generation, v.balance, v.siblingHashes, v.siblingSums, v.parentSums);
}

describe("Reusable Merkle admission and lifecycle", function () {
  it("zero token transfers never allocate a tree slot; funded pending balance stays withdrawable", async function () {
    const f = await reusable(1), [alice, bob] = f.users;
    for (let i = 0; i < 5; i++) {
      await deposit(f, alice, 0n);
      await admission(f, alice, false);
    }
    expect(await f.pool.activeCount()).to.equal(0n);
    expect(await f.pool.nextIndex()).to.equal(0n);
    await deposit(f, bob, 7n);
    expect(await f.pool.indexPlusOne(bob.address)).to.equal(0n);
    expect(await clear(await f.pool.principalOf(bob.address))).to.equal(7n);
    await f.pool.connect(bob).withdrawAllAndExit();
    expect(await clear(await f.pool.principalOf(bob.address))).to.equal(0n);
    expect(await clear(await f.pool.totalPrincipal())).to.equal(0n);
    expect(await clear(await f.token.confidentialBalanceOf(bob.address))).to.equal(1_000_000n);
  });

  it("admits only a verified positive actual balance and rejects fabricated, stale and replayed admission", async function () {
    const f = await reusable(), [alice] = f.users;
    await deposit(f, alice, 1_000_001n); // insufficient wrapper balance: actual transfer zero
    let request = await f.pool.pendingAdmissionOf(alice.address);
    const zero = await fhevm.publicDecrypt([request.marker]);
    await expect(f.pool.finalizeAdmission(alice.address, request.nonce, true, zero.decryptionProof)).to.be.reverted;
    await admission(f, alice, false);
    expect(await f.pool.nextIndex()).to.equal(0n);
    await deposit(f, alice, 3n);
    request = await f.pool.pendingAdmissionOf(alice.address);
    const old = await fhevm.publicDecrypt([request.marker]);
    await f.pool.connect(alice).withdrawAllAndExit();
    await expect(f.pool.finalizeAdmission(alice.address, request.nonce, true, old.decryptionProof)).to.be.revertedWithCustomError(f.pool, "StaleAdmission");
    await deposit(f, alice, 5n);
    const current = await f.pool.pendingAdmissionOf(alice.address);
    await expect(f.pool.finalizeAdmission(alice.address, current.nonce, true, old.decryptionProof)).to.be.reverted;
    const proof = await fhevm.publicDecrypt([current.marker]);
    await f.pool.finalizeAdmission(alice.address, current.nonce, true, proof.decryptionProof);
    await expect(f.pool.finalizeAdmission(alice.address, current.nonce, true, proof.decryptionProof)).to.be.revertedWithCustomError(f.pool, "StaleAdmission");
    expect(await f.pool.activeCount()).to.equal(1n);
    expect(await clear(await f.pool.totalPrincipal())).to.equal(5n);
    expect(await clear(await f.pool.activeTotal())).to.equal(5n);
  });

  it("recycles slots through more lifetime accounts than the tree's capacity", async function () {
    const f = await reusable(1);
    for (let i = 0; i < 9; i++) {
      const address = ethers.getAddress(ethers.toBeHex(0x51000 + i, 20));
      await ethers.provider.send("hardhat_setBalance", [address, "0x56BC75E2D63100000"]);
      const user = await ethers.getImpersonatedSigner(address);
      await f.wrap(user); await deposit(f, user, 1n); await admission(f, user, true);
      expect(await f.pool.indexPlusOne(user.address)).to.equal(1n);
      expect(await f.pool.generationOf(0)).to.equal(BigInt(i + 1));
      await f.pool.connect(user).withdrawAllAndExit();
    }
    expect(await f.pool.nextIndex()).to.equal(1n);
    expect(await f.pool.activeCount()).to.equal(0n);
    expect(await f.pool.freeSlotCount()).to.equal(1n);
    expect(await clear(await f.pool.totalPrincipal())).to.equal(0n);
    expect(await clear(await f.token.confidentialBalanceOf(f.address))).to.equal(0n);
  });

  it("keeps principal accessible when admission is full and invalidates proofs on every pending change", async function () {
    const f = await reusable(1), [alice, bob, carol] = f.users;
    await deposit(f, alice, 2n); await admission(f, alice, true);
    await deposit(f, bob, 3n); await admission(f, bob, true);
    await deposit(f, carol, 0n);
    const empty = await f.pool.pendingAdmissionOf(carol.address);
    const falseProof = await fhevm.publicDecrypt([empty.marker]);
    await deposit(f, carol, 7n);
    const positive = await f.pool.pendingAdmissionOf(carol.address);
    await expect(f.pool.finalizeAdmission(carol.address, empty.nonce, false, falseProof.decryptionProof)).to.be.revertedWithCustomError(f.pool, "StaleAdmission");
    await expect(f.pool.finalizeAdmission(carol.address, positive.nonce, false, falseProof.decryptionProof)).to.be.reverted;
    expect(await clear(await f.pool.principalOf(carol.address))).to.equal(7n);
    const proof = await fhevm.publicDecrypt([positive.marker]);
    await expect(f.pool.finalizeAdmission(carol.address, positive.nonce, true, proof.decryptionProof)).to.be.revertedWithCustomError(f.pool, "TreeFull");
    await withdraw(f, carol, 2n);
    await expect(f.pool.finalizeAdmission(carol.address, positive.nonce, true, proof.decryptionProof)).to.be.revertedWithCustomError(f.pool, "StaleAdmission");
    expect(await clear(await f.pool.totalPending())).to.equal(5n);
    expect(await clear(await f.pool.totalPrincipal())).to.equal(10n);
    await f.pool.closeDraw();
    expect(await clear((await f.pool.draws(1)).sum)).to.equal(5n); // pending Carol excluded
    await f.pool.connect(carol).withdrawAllAndExit(); // requires no indexer/admission proof
    expect(await clear(await f.pool.totalPrincipal())).to.equal(5n);
    expect(await clear(await f.token.confidentialBalanceOf(carol.address))).to.equal(1_000_000n);
    await f.pool.connect(alice).withdrawAllAndExit();
    await deposit(f, carol, 4n); await admission(f, carol, true);
    expect(await f.pool.indexPlusOne(carol.address)).to.equal(1n);
    expect(await clear(await f.pool.totalPending())).to.equal(0n);
    expect(await clear(await f.pool.totalPrincipal())).to.equal(7n);
    expect(await clear(await f.pool.activeTotal())).to.equal(7n);
    const current = await f.pool.pendingAdmissionOf(carol.address);
    expect(current.requested).to.equal(false);
    expect(await clear(current.balance)).to.equal(0n); // cannot withdraw admitted principal twice
  });

  it("refunds deposits above the cap without slots and makes full exit explicit after a zeroing partial withdrawal", async function () {
    const f = await reusable(), [alice] = f.users;
    await f.usdc.faucet(alice.address, 1_000_000_001n);
    await f.usdc.connect(alice).approve(await f.token.getAddress(), 1_000_000_001n);
    await f.token.connect(alice).wrap(alice.address, 1_000_000_001n);
    await deposit(f, alice, 1_000_000_001n); await admission(f, alice, false);
    expect(await f.pool.nextIndex()).to.equal(0n);
    expect(await clear(await f.token.confidentialBalanceOf(f.address))).to.equal(0n);
    await deposit(f, alice, 1_000_000_000n); await admission(f, alice, true);
    await deposit(f, alice, 1n); // cap rejection refunds real token transfer
    expect(await clear(await f.pool.totalPrincipal())).to.equal(1_000_000_000n);
    expect(await clear(await f.token.confidentialBalanceOf(f.address))).to.equal(1_000_000_000n);
    await withdraw(f, alice, 1_000_000_000n);
    expect(await clear(await f.pool.activeTotal())).to.equal(0n);
    expect(await f.pool.activeCount()).to.equal(1n); // no plaintext branch on encrypted zero
    await f.pool.connect(alice).withdrawAllAndExit();
    await f.pool.connect(alice).withdrawAllAndExit(); // repeated exit cannot duplicate the free slot
    expect(await f.pool.freeSlotCount()).to.equal(1n);
    expect(await clear(await f.token.confidentialBalanceOf(alice.address))).to.equal(1_001_000_001n);
  });

  it("recovers old user-only claims after exit, slot reuse, rejoining and an archive restart", async function () {
    const f = await reusable(), [alice, bob, carol] = f.users;
    const directory = mkdtempSync(path.join(tmpdir(), "kettigo-history-"));
    let archive: ProofArchive | undefined;
    try {
      await deposit(f, alice, 3n); await admission(f, alice, true);
      await deposit(f, bob, 7n); await admission(f, bob, true);
      await deposit(f, f.admin, 11n, undefined, true); await f.pool.closeDraw();
      await f.pool.connect(alice).withdrawAllAndExit();
      await deposit(f, carol, 5n); await admission(f, carol, true); // reuses Alice's index
      await deposit(f, alice, 4n); await admission(f, alice, true); // Alice now at index 2
      await deposit(f, f.admin, 13n, undefined, true); await f.pool.closeDraw();
      for (const user of [bob, carol, alice]) await f.pool.connect(user).withdrawAllAndExit();
      expect(await f.pool.activeCount()).to.equal(0n);
      expect(await f.pool.nextIndex()).to.equal(3n); // historical upper bound survives all exits
      expect(await f.pool.freeSlotCount()).to.equal(3n);
      const options = await archiveOptions(f, path.join(directory, "archive.sqlite"));
      archive = new ProofArchive(options); await ingestPool(f, archive);
      const original = archive.proof(1, alice.address);
      archive.close(); archive = new ProofArchive(options);
      const d1 = await f.pool.draws(1), d2 = await f.pool.draws(2);
      const a1 = archive.proof(1, alice.address, { rootHash: d1.rootHash, rootSum: d1.sum });
      const a2 = archive.proof(2, alice.address, { rootHash: d2.rootHash, rootSum: d2.sum });
      const c2 = archive.proof(2, carol.address);
      expect(a1).to.deep.equal(original);
      expect([a1.index, a1.generation, a2.index, c2.index, c2.generation]).to.deep.equal([0n, 1n, 2n, 0n, 2n]);
      await expect(claim(f, a1, { generation: 2n })).to.be.revertedWithCustomError(f.pool, "InvalidProof");
      await expect(claim(f, a1, { account: carol.address })).to.be.revertedWithCustomError(f.pool, "InvalidProof");
      await expect(claim(f, c2, { drawId: 1 })).to.be.revertedWithCustomError(f.pool, "InvalidProof");
      await expect(claim(f, a2, { parentSums: [a2.parentSums[0], await f.pool.zero()] })).to.be.revertedWithCustomError(f.pool, "InvalidProof");
      await claim(f, a1);
      expect(await f.pool.checked(1, alice.address)).to.equal(true);
      expect(await f.pool.checked(1, bob.address)).to.equal(false); // no scan, no required checks for others
      expect(await f.pool.checked(2, alice.address)).to.equal(false);
      expect(await clear(await f.pool.awardOf(1, alice.address))).to.equal(await clear(d1.ticket) < 3n ? 11n : 0n);
      // The remaining users choose to check later; exactly one prize is paid in each draw.
      await claim(f, archive.proof(1, bob.address));
      await claim(f, a2); await claim(f, c2); await claim(f, archive.proof(2, bob.address));
      for (let id = 1; id <= 2; id++) {
        // The installed mock coprocessor has one mutable event cursor: decrypt serially.
        const awards: bigint[] = [];
        for (const u of [alice, bob, carol]) {
          const h = await f.pool.awardOf(id, u.address); awards.push(h === ethers.ZeroHash ? 0n : await clear(h));
        }
        expect(awards.reduce((a, b) => a + b, 0n)).to.equal(id === 1 ? 11n : 13n);
        expect(await clear((await f.pool.draws(id)).remaining)).to.equal(0n);
      }
      await expect(claim(f, a1)).to.be.revertedWithCustomError(f.pool, "AlreadyChecked");
      expect(await clear(await f.pool.totalPrincipal())).to.equal(0n);
      expect(await clear(await f.token.confidentialBalanceOf(f.address))).to.equal(0n);
    } finally { archive?.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("isolates pending balances and historical awards while allowing public admission proofs", async function () {
    const f = await reusable(), [alice, bob] = f.users;
    await deposit(f, alice, 3n);
    const request = await f.pool.pendingAdmissionOf(alice.address);
    expect(await fhevm.userDecryptEuint(FhevmType.euint64, request.balance, f.address, alice)).to.equal(3n);
    await rejects(fhevm.userDecryptEuint(FhevmType.euint64, request.balance, f.address, bob));
    const proof = await fhevm.publicDecrypt([request.marker]);
    await expect(f.pool.finalizeAdmission(bob.address, request.nonce, true, proof.decryptionProof)).to.be.revertedWithCustomError(f.pool, "StaleAdmission");
    await admission(f, alice, true);
    await deposit(f, bob, 7n); await admission(f, bob, true);
    await deposit(f, f.admin, 11n, undefined, true); await f.pool.closeDraw();
    const archive = new ProofArchive(await archiveOptions(f, ":memory:"));
    try {
      await ingestPool(f, archive); await claim(f, archive.proof(1, alice.address));
      const award = await f.pool.awardOf(1, alice.address), d = await f.pool.draws(1);
      expect(await fhevm.userDecryptEuint(FhevmType.euint64, award, f.address, alice)).to.equal(await clear(d.ticket) < 3n ? 11n : 0n);
      await rejects(fhevm.userDecryptEuint(FhevmType.euint64, award, f.address, bob));
      for (const handle of [d.sum, d.ticket]) await rejects(fhevm.userDecryptEuint(FhevmType.euint64, handle, f.address, alice));
    } finally { archive.close(); }
  });

  it("preserves liquid backing through mixed pending, admitted, recycled and claimed balances", async function () {
    const f = await reusable(), [alice, bob, carol] = f.users;
    const check = async (principal: bigint, pending: bigint, reserve: bigint, outstanding: bigint) => {
      expect(await clear(await f.pool.totalPrincipal())).to.equal(principal);
      expect(await clear(await f.pool.totalPending())).to.equal(pending);
      expect(await clear(await f.pool.activeTotal())).to.equal(principal - pending);
      expect(await clear(await f.pool.reserve())).to.equal(reserve);
      expect(await clear(await f.token.confidentialBalanceOf(f.address))).to.equal(principal + reserve + outstanding);
    };
    await deposit(f, alice, 9n); await deposit(f, bob, 6n); await check(15n, 15n, 0n, 0n);
    await deposit(f, f.admin, 11n, undefined, true); await f.pool.closeDraw(); // pending-only: reserve carries
    expect(await clear((await f.pool.draws(1)).prize)).to.equal(0n); await check(15n, 15n, 11n, 0n);
    const before = await f.pool.pendingAdmissionOf(alice.address), stale = await fhevm.publicDecrypt([before.marker]);
    await withdraw(f, alice, 4n); await check(11n, 11n, 11n, 0n);
    await expect(f.pool.finalizeAdmission(alice.address, before.nonce, true, stale.decryptionProof)).to.be.revertedWithCustomError(f.pool, "StaleAdmission");
    await admission(f, alice, true); await check(11n, 6n, 11n, 0n);
    await f.pool.closeDraw(); await check(11n, 6n, 0n, 11n);
    await f.pool.connect(alice).withdrawAllAndExit(); await check(6n, 6n, 0n, 11n);
    await deposit(f, carol, 8n); await admission(f, carol, true); await check(14n, 6n, 0n, 11n);
    await f.pool.connect(bob).withdrawAllAndExit(); await check(8n, 0n, 0n, 11n);
    const archive = new ProofArchive(await archiveOptions(f, ":memory:"));
    try { await ingestPool(f, archive); await claim(f, archive.proof(2, alice.address)); }
    finally { archive.close(); }
    await check(8n, 0n, 0n, 0n);
    await f.pool.connect(carol).withdrawAllAndExit(); await check(0n, 0n, 0n, 0n);
  });

  it("admits 65 funded accounts across the old 32-user boundary and checks only the requested user", async function () {
    const f = await reusable(32), users: any[] = [], closes: any[] = [];
    for (let i = 0; i < 65; i++) {
      const address = ethers.getAddress(ethers.toBeHex(0x61000 + i, 20));
      await ethers.provider.send("hardhat_setBalance", [address, "0x56BC75E2D63100000"]);
      const user = await ethers.getImpersonatedSigner(address);
      await f.wrap(user); await deposit(f, user, 1n); await admission(f, user, true); users.push(user);
      if (i === 31 || i === 32) closes.push(await f.measure(await f.pool.closeDraw()));
    }
    expect(await f.pool.activeCount()).to.equal(65n);
    expect(await clear(await f.pool.activeTotal())).to.equal(65n);
    expect(await clear(await f.token.confidentialBalanceOf(f.address))).to.equal(65n);
    expect(closes[0].globalHCU).to.equal(closes[1].globalHCU);
    expect(closes[0].maxHCUDepth).to.equal(closes[1].maxHCUDepth);
    await deposit(f, f.admin, 11n, undefined, true); await f.pool.closeDraw();
    const archive = new ProofArchive(await archiveOptions(f, ":memory:"));
    try {
      await ingestPool(f, archive);
      await claim(f, archive.proof(3, users[64].address));
      expect(await f.pool.checked(3, users[64].address)).to.equal(true);
      for (const u of users.slice(0, 64)) expect(await f.pool.checked(3, u.address)).to.equal(false);
    } finally { archive.close(); }
  });

  it("bounds a depth-32 user-only check and measures admission and exit HCU", async function () {
    const f = await reusable(32), [alice, bob] = f.users;
    const measured: any = { contract: "ReusableMerkleProbe", backend: "local Hardhat FHE mock", depth: 32, passed: false };
    measured.pendingDeposit = await f.measure(await deposit(f, alice, 3n));
    measured.positiveAdmission = await f.measure(await admission(f, alice, true));
    await deposit(f, bob, 7n); await admission(f, bob, true);
    await deposit(f, f.admin, 11n, undefined, true);
    measured.close = await f.measure(await f.pool.closeDraw());
    measured.fullExit = await f.measure(await f.pool.connect(alice).withdrawAllAndExit());
    const archive = new ProofArchive(await archiveOptions(f, ":memory:"));
    try {
      await ingestPool(f, archive);
      const proof = archive.proof(1, alice.address);
      expect(proof.siblingHashes).to.have.length(32);
      measured.userOnlyCheck = await f.measure(await claim(f, proof));
      expect(await f.pool.checked(1, bob.address)).to.equal(false);
      expect(BigInt(measured.positiveAdmission.globalHCU)).to.be.lessThan(20_000_000n);
      expect(BigInt(measured.fullExit.globalHCU)).to.be.lessThan(20_000_000n);
      expect(BigInt(measured.userOnlyCheck.maxHCUDepth)).to.be.lessThan(5_000_000n);
      measured.passed = true;
      writeFileSync(path.resolve(__dirname, "../on-demand-results.json"), JSON.stringify(measured, null, 2) + "\n");
    } finally { archive.close(); }
  });
});
