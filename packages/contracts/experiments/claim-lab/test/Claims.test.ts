import { expect } from "chai";
import { rejects } from "node:assert/strict";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { fixture, deposit, withdraw, snapshot, merkleClaim, proveMembership, proveRange, clear, metrics, saveResults } from "./helpers";

describe("Funded claim experiments (local FHE backend, real Groth16)", function () {
  this.timeout(240_000);
  after(() => saveResults());

  it("A: reproduces a valid ZK proof of an unfunded ticket interval", async function () {
    const f = await fixture(0, 8);
    const [honest, attacker] = f.users;
    await deposit(f, honest, 100n, [0n, 100n, 11n]);
    await deposit(f, attacker, 1n, [0n, 101n, 22n]);
    await deposit(f, f.admin, 7n, undefined, true);
    const snap = await snapshot(f);
    await f.pool.closeAtForTest(0);
    await f.pool.publishRangeInputs(1);
    const draw = await f.pool.draws(1);
    const opening = await fhevm.publicDecrypt([draw.ticket, draw.sum]);
    await f.pool.revealRangeInputs(1, 0, 101, opening.decryptionProof);
    const p = await proveRange(f, snap, attacker, 0n, 101n, 22n, 0n, 101n);
    const before = await clear(await f.token.confidentialBalanceOf(attacker.address));
    await f.pool.claimRange(1, p.a, p.b, p.c, p.signals);
    const gain = (await clear(await f.token.confidentialBalanceOf(attacker.address))) - before;
    // EXPECT_RANGE_SECURE=1 is the explicit failing security acceptance test.
    expect(gain).to.equal(process.env.EXPECT_RANGE_SECURE ? 0n : 7n);
    expect(await clear(await f.pool.principalOf(attacker.address))).to.equal(1n);
    metrics.rangeCounterexample = { actualDeposit: "1", honestDeposit: "100", forgedRange: ["0", "101"], ticket: "0", stolenPrize: gain.toString(), cryptographicProofVerified: true };
  });

  for (const mode of [1, 2]) {
    const name = mode === 1 ? "B: ZK membership + FHE" : "C: Merkle membership + FHE";
    it(`${name} binds old eligibility to actual transfers, permits withdrawal, pays once`, async function () {
      const f = await fixture(mode, 32);
      const [alice, bob, carol] = f.users;
      metrics[`${mode}-deposit`] = await f.measure(await deposit(f, alice, 5n));
      await deposit(f, bob, 9n);
      // A request larger than the token balance actually transfers zero.
      await deposit(f, carol, 1_000_001n);
      expect(await clear(await f.pool.principalOf(carol.address))).to.equal(0n);
      await deposit(f, f.admin, 13n, undefined, true);
      const old = await snapshot(f);
      metrics[`${mode}-close`] = await f.measure(await f.pool.closeDraw());
      const draw = await f.pool.draws(1);
      const ticket = await clear(draw.ticket);
      expect(ticket).to.be.lessThan(14n);
      // Withdrawal never depends on the historical indexer, even after a draw.
      metrics[`${mode}-withdraw`] = await f.measure(await withdraw(f, alice, 100n));
      await deposit(f, bob, 2n);
      expect(await clear(await f.pool.principalOf(alice.address))).to.equal(0n);
      expect(await clear(await f.pool.total())).to.equal(11n);
      const winner = ticket < 5n ? alice : bob;
      for (const user of [alice, bob, carol]) {
        const before = await clear(await f.token.confidentialBalanceOf(user.address));
        const tx = mode === 1
          ? await (async () => { const p = await proveMembership(f, old, user, 1); return f.pool.connect(carol).claimZk(1, p.a, p.b, p.c, p.signals); })()
          : await merkleClaim(f, old, user, 1, carol);
        metrics[`${mode}-claim-${user === alice ? "alice" : user === bob ? "bob" : "zero"}`] = await f.measure(tx);
        expect((await clear(await f.token.confidentialBalanceOf(user.address))) - before).to.equal(user === winner ? 13n : 0n);
        const award = await f.pool.awardOf(1, user.address);
        expect(await fhevm.userDecryptEuint(FhevmType.euint64, award, f.address, user)).to.equal(user === winner ? 13n : 0n);
        await rejects(fhevm.userDecryptEuint(FhevmType.euint64, award, f.address, f.admin));
      }
      await rejects(fhevm.userDecryptEuint(FhevmType.euint64, draw.ticket, f.address, winner));
      const outstanding = await clear((await f.pool.draws(1)).remaining);
      expect(outstanding).to.equal(0n);
      expect(await clear(await f.token.confidentialBalanceOf(f.address))).to.equal(11n);
      await withdraw(f, bob, 11n);
      expect(await clear(await f.token.confidentialBalanceOf(f.address))).to.equal(0n);
      if (mode === 2) await expect(merkleClaim(f, old, winner, 1)).to.be.revertedWithCustomError(f.pool, "AlreadyChecked");
      else {
        const p = await proveMembership(f, old, winner, 1);
        await expect(f.pool.claimZk(1, p.a, p.b, p.c, p.signals)).to.be.revertedWithCustomError(f.pool, "AlreadyChecked");
      }
    });
  }

  it("C rejects forged handles, paths, beneficiaries, future participants, and wrong rounds", async function () {
    const f = await fixture(2, 20);
    const [alice, bob, carol] = f.users;
    await deposit(f, alice, 3n);
    await deposit(f, bob, 7n);
    await deposit(f, f.admin, 5n, undefined, true);
    const old = await snapshot(f);
    await f.pool.closeAtForTest(4);
    await deposit(f, bob, 2n);
    await deposit(f, carol, 1n);
    const current = await snapshot(f);
    await f.pool.closeAtForTest(4);
    for (const kind of ["balance", "siblingHash", "siblingSum", "parentSum", "beneficiary", "index"]) {
      await expect(merkleClaim(f, old, bob, 1, undefined, kind)).to.be.reverted;
    }
    await expect(merkleClaim(f, current, bob, 1)).to.be.reverted;
    await expect(merkleClaim(f, old, bob, 2)).to.be.reverted;
    await expect(merkleClaim(f, current, carol, 1)).to.be.reverted;
    await merkleClaim(f, old, bob, 1);
    await merkleClaim(f, current, bob, 2);
  });

  it("B verifies a real Groth16 proof onchain and rejects altered public statements", async function () {
    const f = await fixture(1, 32);
    const [alice, bob] = f.users;
    await deposit(f, alice, 3n);
    await deposit(f, bob, 7n);
    await deposit(f, f.admin, 5n, undefined, true);
    const old = await snapshot(f);
    await f.pool.closeAtForTest(4);
    await f.pool.closeAtForTest(4);
    const p = await proveMembership(f, old, bob, 1);
    // public signals: nullifier, root hash, root handle limbs, scope, owner,
    // leaf index, balance limbs, 32 low + 32 high sibling handle limbs.
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 41, 72]) {
      const bad = [...p.signals]; bad[index] = (BigInt(bad[index]) + 1n).toString();
      await expect(f.pool.claimZk(1, p.a, p.b, p.c, bad)).to.be.reverted;
    }
    await expect(f.pool.claimZk(2, p.a, p.b, p.c, p.signals)).to.be.reverted;
    await f.pool.claimZk(1, p.a, p.b, p.c, p.signals);
    expect(await clear(await f.pool.awardOf(1, bob.address))).to.equal(5n);
  });

  it("B: the circuit rejects attempts to prove forged receipt handles and intermediate sums", async function () {
    const f = await fixture(1, 32);
    const [alice, bob] = f.users;
    await deposit(f, alice, 3n);
    await deposit(f, bob, 7n);
    const old = await snapshot(f);
    const path = await old.path(bob);
    await f.pool.closeAtForTest(4);
    const h = BigInt(await f.pool.principalOf(alice.address));
    await rejects(proveMembership(f, old, bob, 1, { balanceLo: h & ((1n << 128n) - 1n), balanceHi: h >> 128n }), /Assert Failed/);
    const lo = path.parents.map((n: any) => BigInt(n.sum) & ((1n << 128n) - 1n));
    lo[0] ^= 1n;
    await rejects(proveMembership(f, old, bob, 1, { parentLo: lo }), /Assert Failed/);
    await rejects(proveMembership(f, old, bob, 1, { account: BigInt(alice.address) }), /Assert Failed/);
  });

  it("C supports 65 actual funded participants, constant draw work, and bounded current-node storage", async function () {
    const f = await fixture(2, 32);
    for (let i = 0; i < 65; i++) {
      const address = ethers.getAddress(ethers.toBeHex(0x10000 + i, 20));
      await ethers.provider.send("hardhat_setBalance", [address, "0x56BC75E2D63100000"]);
      const user = await ethers.getImpersonatedSigner(address);
      await f.wrap(user);
      const tx = await deposit(f, user, BigInt(i + 1));
      if (i === 0 || i === 32 || i === 64) {
        metrics[`scale-deposit-${i + 1}`] = await f.measure(tx);
        metrics[`scale-close-${i + 1}`] = await f.measure(await f.pool.closeDraw());
      }
    }
    expect(await f.pool.participantCount()).to.equal(65n);
    expect(await clear(await f.pool.total())).to.equal(2145n);
    const nodes = await f.pool.storedNodeCount();
    for (let i = 0; i < 5; i++) await deposit(f, f.users[0], 1n);
    const afterFirst = await f.pool.storedNodeCount();
    await deposit(f, f.users[0], 1n);
    expect(await f.pool.storedNodeCount()).to.equal(afterFirst);
    expect(afterFirst - nodes).to.be.lessThan(34n);
    const snap = await snapshot(f);
    const last = await ethers.getImpersonatedSigner(ethers.getAddress(ethers.toBeHex(0x10040, 20)));
    await f.pool.closeDraw();
    metrics["scale-claim-65"] = await f.measure(await merkleClaim(f, snap, last, Number(await f.pool.drawCount())));
    metrics.scale = { actualParticipants: "65 plus 1", totalBeforeAdditionalDeposits: "2145", treeDepth: 32, storedNodesBeforeAdditionalAccount: nodes.toString(), storedNodesAfterRepeatedDeposit: afterFirst.toString() };
  });

  it("C: every ticket selects exactly one funded interval, including zeros and boundary tickets", async function () {
    const f = await fixture(2, 8);
    const users = f.users.slice(0, 3);
    await deposit(f, users[0], 2n);
    await deposit(f, users[1], 0n);
    await deposit(f, users[2], 3n);
    const snap = await snapshot(f);
    for (let ticket = 0; ticket < 5; ticket++) {
      await deposit(f, f.admin, 7n, undefined, true);
      await f.pool.closeAtForTest(ticket);
      const id = ticket + 1;
      for (let i = 0; i < 3; i++) {
        await merkleClaim(f, snap, users[i], id);
        const expected = (ticket < 2 ? i === 0 : i === 2) ? 7n : 0n;
        expect(await clear(await f.pool.awardOf(id, users[i].address))).to.equal(expected);
      }
      expect(await clear((await f.pool.draws(id)).remaining)).to.equal(0n);
      expect(await clear(await f.token.confidentialBalanceOf(f.address))).to.equal(5n);
    }
  });

  it("C: withdrawn principal has zero future odds; an empty draw carries its prize", async function () {
    const f = await fixture(2, 8);
    const alice = f.users[0];
    await deposit(f, alice, 5n);
    await withdraw(f, alice, 5n);
    await deposit(f, f.admin, 7n, undefined, true);
    const empty = await snapshot(f);
    await f.pool.closeDraw();
    expect(await clear(await f.pool.reserve())).to.equal(7n);
    await merkleClaim(f, empty, alice, 1);
    expect(await clear(await f.pool.awardOf(1, alice.address))).to.equal(0n);
    await deposit(f, alice, 1n);
    const funded = await snapshot(f);
    await f.pool.closeDraw();
    await merkleClaim(f, funded, alice, 2);
    expect(await clear(await f.pool.awardOf(2, alice.address))).to.equal(7n);
    expect(await clear(await f.token.confidentialBalanceOf(f.address))).to.equal(1n);
  });

  it("C: callback authentication, input ownership, and deposit cap preserve backing", async function () {
    const f = await fixture(2, 8);
    const [alice, bob] = f.users;
    await expect(f.pool.onConfidentialTransferReceived(alice.address, alice.address, ethers.ZeroHash, "0x")).to.be.revertedWithCustomError(f.pool, "OnlyToken");
    await f.usdc.faucet(alice.address, 1_000_000_000n);
    await f.usdc.connect(alice).approve(await f.token.getAddress(), 1_000_000_000n);
    await f.token.connect(alice).wrap(alice.address, 1_000_000_000n);
    await deposit(f, alice, 1_000_000_000n);
    await deposit(f, alice, 1n);
    expect(await clear(await f.pool.principalOf(alice.address))).to.equal(1_000_000_000n);
    expect(await clear(await f.token.confidentialBalanceOf(f.address))).to.equal(1_000_000_000n);
    const input = await fhevm.createEncryptedInput(f.address, alice.address).add64(1n).encrypt();
    await expect(f.pool.connect(bob).withdraw(input.handles[0], input.inputProof)).to.be.reverted;
    await withdraw(f, alice, 1_000_000_001n);
    expect(await clear(await f.token.confidentialBalanceOf(f.address))).to.equal(0n);
  });

  it("C: exercises the maximum 32-term prefix with two actual funded accounts in sparse test slots", async function () {
    const f = await fixture(2, 32);
    const [alice, bob] = f.users;
    await deposit(f, alice, 2n);
    await f.pool.assignSparseIndexForTest(bob.address, (1n << 32n) - 1n);
    await deposit(f, bob, 3n);
    await deposit(f, f.admin, 7n, undefined, true);
    const snap = await snapshot(f);
    await f.pool.closeAtForTest(4);
    metrics.worstPrefix32 = await f.measure(await merkleClaim(f, snap, bob, 1));
    expect(await clear(await f.pool.awardOf(1, bob.address))).to.equal(7n);
  });
});
