import { expect } from "chai";
import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";
import { fixture, deposit, withdraw, snapshot, merkleClaim, clear } from "./helpers";

(process.env.MERKLE_STRESS === "1" ? describe : describe.skip)("Merkle + FHE funded-population stress", function () {
  this.timeout(1_200_000);
  it("funds 4,096 actual accounts and settles every historical eligibility check", async function () {
    const count = Number(process.env.STRESS_PARTICIPANTS ?? 4096);
    if (!Number.isInteger(count) || count < 2048 || count > 8192) throw new Error("Stress count must be 2048..8192");
    const start = performance.now(), f = await fixture(2, 32);
    const candidate = process.env.STRESS_CANDIDATE === "1";
    if (candidate) {
      f.pool = await (await ethers.getContractFactory("SepoliaMerkleProbe")).deploy(await f.token.getAddress(), 32);
      f.address = await f.pool.getAddress();
    }
    const result: any = { contract: candidate ? "SepoliaMerkleProbe" : "ClaimLabPool mode 2", population: count, treeDepth: 32, backend: "local Hardhat FHE mock; actual ERC7984 callbacks", checkpoints: [], passed: false };
    const file = path.resolve(__dirname, candidate ? "../stress-candidate-results.json" : "../stress-results.json");
    const save = () => fs.writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
    const users: any[] = [], weights: bigint[] = [];
    let total = 0n, peakRss = 0;
    const points = new Set([1, 32, 33, 256, 1024, 2048, count]);
    for (let i = 0; i < count; i++) {
      const address = ethers.getAddress(ethers.toBeHex(0x100000 + i, 20));
      await ethers.provider.send("hardhat_setBalance", [address, "0x56BC75E2D63100000"]);
      const user = await ethers.getImpersonatedSigner(address);
      await f.wrap(user);
      const amount = BigInt(i % 97 + 1);
      const tx = await deposit(f, user, amount);
      users.push(user); weights.push(amount); total += amount;
      if (points.has(i + 1)) {
        const item = { participants: i + 1, deposit: await f.measure(tx), close: await f.measure(await f.pool.closeDraw()), total: total.toString(), storedNodes: String(await f.pool.storedNodeCount()) };
        expect(await clear(await f.pool.total())).to.equal(total);
        expect(await clear(await f.token.confidentialBalanceOf(f.address))).to.equal(total);
        result.checkpoints.push(item); save();
      }
      if ((i + 1) % 256 === 0) {
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
        console.log(JSON.stringify({ stage: "funded", accounts: i + 1, elapsedMs: Math.round(performance.now() - start), rssMiB: Math.round(peakRss / 2 ** 20) }));
      }
    }
    expect(await f.pool.participantCount()).to.equal(BigInt(count));
    result.onboardingMs = Math.round(performance.now() - start);
    await deposit(f, f.admin, 13n, undefined, true);
    result.fundedClose = await f.measure(await f.pool.closeDraw());
    const id = Number(await f.pool.drawCount()), d = await f.pool.draws(id);
    // Plaintext is an independent local test oracle, never a claim input.
    const ticket = await clear(d.ticket);
    let prefix = 0n, winner = -1;
    for (let i = 0; i < count; i++) { if (ticket >= prefix && ticket < prefix + weights[i]) winner = i; prefix += weights[i]; }
    expect(winner).to.be.at.least(0);
    result.snapshotTotal = total.toString(); result.localOracleTicket = ticket.toString();
    for (let i = 0; i < 64; i++) {
      const j = (i * 61) % count;
      await withdraw(f, users[j], weights[j]); total -= weights[j];
      const returned = weights[j] / 2n;
      await deposit(f, users[j], returned); total += returned;
    }
    expect(await clear(await f.pool.total())).to.equal(total);
    const recoverStart = performance.now();
    const archived = await snapshot(f, id, { pageSize: 512 });
    result.archiveRecoveryMs = Math.round(performance.now() - recoverStart);
    result.archivedNodeEvents = archived.logs.length;
    result.archivedNodeLogJsonBytes = Buffer.byteLength(JSON.stringify(archived.logs, (_, v) => typeof v === "bigint" ? v.toString() : v));
    const claimsStart = performance.now();
    let minGas: bigint | undefined, maxGas = 0n, sumGas = 0n, paid = 0n;
    for (let i = 0; i < count; i++) {
      const tx = await merkleClaim(f, archived, users[i], id, f.admin);
      const receipt = await tx.wait();
      const gas = receipt.gasUsed;
      minGas = minGas === undefined || gas < minGas ? gas : minGas; maxGas = gas > maxGas ? gas : maxGas; sumGas += gas;
      const award = await clear(await f.pool.awardOf(id, users[i].address));
      expect(award).to.equal(i === winner ? 13n : 0n); paid += award;
      if (i === 0 || i === count - 1 || i === winner) (result.claimSamples ??= []).push({ index: i, ...(await f.measure(tx)) });
      if ((i + 1) % 256 === 0) {
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
        console.log(JSON.stringify({ stage: "claims", accounts: i + 1, elapsedMs: Math.round(performance.now() - claimsStart), rssMiB: Math.round(peakRss / 2 ** 20) }));
      }
    }
    expect(paid).to.equal(13n);
    expect(await clear((await f.pool.draws(id)).remaining)).to.equal(0n);
    expect(await clear(await f.token.confidentialBalanceOf(f.address))).to.equal(total);
    await expect(merkleClaim(f, archived, users[winner], id)).to.be.revertedWithCustomError(f.pool, "AlreadyChecked");
    result.claims = { count, winnerIndex: winner, totalGas: sumGas.toString(), minGas: minGas!.toString(), maxGas: maxGas.toString(), elapsedMs: Math.round(performance.now() - claimsStart) };
    result.backedPrincipalAfterMutationsAndClaims = total.toString();
    result.peakRssMiB = Math.round(peakRss / 2 ** 20);
    result.elapsedMs = Math.round(performance.now() - start); result.passed = true; save();
  });
});
