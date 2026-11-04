import { expect } from "chai";
import { rejects } from "node:assert/strict";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { fixture, deposit, withdraw, snapshot, merkleClaim, clear } from "./helpers";

describe("Merkle + FHE adversarial validation", function () {
  it("recovers a frozen draw from a fresh event replay after later balance changes", async function () {
    const f = await fixture(2, 32), [alice, bob] = f.users;
    await deposit(f, alice, 5n); await deposit(f, bob, 7n);
    await deposit(f, f.admin, 11n, undefined, true);
    await f.pool.closeAtForTest(6);
    await withdraw(f, bob, 7n); await deposit(f, alice, 3n);
    // No snapshot is retained before close. Reconstruct round 1 now.
    const recovered = await (snapshot as any)(f, 1, { pageSize: 7 });
    await merkleClaim(f, recovered, bob, 1);
    expect(await clear(await f.pool.awardOf(1, bob.address))).to.equal(11n);
    expect(await clear(await f.token.confidentialBalanceOf(f.address))).to.equal(8n);
  });

  it("rejects public handle reuse through empty-proof withdrawals and raw token transfers", async function () {
    const f = await fixture(2, 20), [alice, bob] = f.users;
    await deposit(f, alice, 5n); await deposit(f, bob, 7n);
    await deposit(f, f.admin, 11n, undefined, true);
    const old = await snapshot(f); await f.pool.closeAtForTest(6);
    await merkleClaim(f, old, bob, 1, alice);
    const d = await f.pool.draws(1);
    const handles = [await f.pool.principalOf(bob.address), await f.pool.awardOf(1, bob.address), d.ticket, d.sum, await f.pool.reserve(), (await old.path(alice)).siblings[0].sum];
    for (const h of new Set<string>(handles)) {
      await expect(f.pool.connect(alice).withdraw(h, "0x")).to.be.reverted;
      await expect(f.token.connect(alice)["confidentialTransfer(address,bytes32)"](alice.address, h)).to.be.reverted;
    }
    await rejects(fhevm.userDecryptEuint(FhevmType.euint64, d.sum, f.address, alice));
    const wrongContract = await fhevm.createEncryptedInput(await f.token.getAddress(), alice.address).add64(1n).encrypt();
    await expect(f.pool.connect(alice).withdraw(wrongContract.handles[0], wrongContract.inputProof)).to.be.reverted;
    expect(await clear(await f.pool.principalOf(alice.address))).to.equal(5n);
    expect(await clear(await f.token.confidentialBalanceOf(f.address))).to.equal(12n);
  });

  it("new aggregate handles do not inherit a singleton depositor's decryption allowance", async function () {
    const f = await fixture(2, 20), [alice, bob] = f.users;
    await deposit(f, alice, 5n);
    await deposit(f, bob, 7n);
    await rejects(fhevm.userDecryptEuint(FhevmType.euint64, await f.pool.total(), f.address, alice));
    await withdraw(f, alice, 5n); await deposit(f, bob, 3n);
    await rejects(fhevm.userDecryptEuint(FhevmType.euint64, await f.pool.total(), f.address, alice));
    expect(await clear(await f.pool.total())).to.equal(10n);
  });

  it("reproduces zero-value slot exhaustion at a reduced depth without stealing principal", async function () {
    const f = await fixture(2, 4);
    for (let i = 0; i < 16; i++) {
      const address = ethers.getAddress(ethers.toBeHex(0x30000 + i, 20));
      await ethers.provider.send("hardhat_setBalance", [address, "0x56BC75E2D63100000"]);
      const user = await ethers.getImpersonatedSigner(address);
      await deposit(f, user, 0n);
    }
    const alice = f.users[0];
    expect(await f.pool.participantCount()).to.equal(16n);
    await expect(deposit(f, alice, 1n)).to.be.reverted;
    expect(await clear(await f.token.confidentialBalanceOf(alice.address))).to.equal(1_000_000n);
    expect(await clear(await f.pool.total())).to.equal(0n);
  });

  it("reproduces immediate reserve capture allowed by end-of-draw eligibility and unrestricted closing", async function () {
    const f = await fixture(2, 20), alice = f.users[0];
    await deposit(f, f.admin, 11n, undefined, true);
    await deposit(f, alice, 1n); const old = await snapshot(f);
    await f.pool.connect(alice).closeDraw(); // genuine FHE RNG, no deterministic helper
    await withdraw(f, alice, 1n);
    await merkleClaim(f, old, alice, 1);
    expect(await clear(await f.pool.awardOf(1, alice.address))).to.equal(11n);
    expect(await clear(await f.pool.principalOf(alice.address))).to.equal(0n);
  });

  it("rebuilds from shuffled duplicate logs and rejects missing or removed historical data", async function () {
    const f = await fixture(2, 8), [alice, bob] = f.users;
    await deposit(f, alice, 3n); await deposit(f, bob, 7n);
    await deposit(f, f.admin, 11n, undefined, true); await f.pool.closeAtForTest(6);
    await withdraw(f, bob, 7n); await deposit(f, alice, 1n);
    const logs = await f.pool.queryFilter(f.pool.filters.NodeUpdated());
    const restored = await snapshot(f, 1, { logs: [...logs].reverse().concat(logs) });
    await merkleClaim(f, restored, bob, 1);
    expect(await clear(await f.pool.awardOf(1, bob.address))).to.equal(11n);
    await rejects(snapshot(f, 1, { logs: [] }), /Incomplete/);
    const missingLeaf = await snapshot(f, 1, { logs: logs.filter((l: any) => !(l.args.level === 0n && l.args.index === 1n)) });
    await rejects(missingLeaf.path(bob), /Incomplete/);
    await rejects(snapshot(f, 1, { logs: [{ ...logs[0], args: logs[0].args, removed: true }] }), /removed log/);
  });

  it("recovers canonical eligibility after an orphaned branch is rolled back", async function () {
    const f = await fixture(2, 8), [alice, bob] = f.users;
    await deposit(f, alice, 3n); await deposit(f, bob, 7n);
    await deposit(f, f.admin, 11n, undefined, true);
    const checkpoint = await ethers.provider.send("evm_snapshot", []);
    await f.pool.closeAtForTest(6); const orphaned = await snapshot(f, 1);
    await ethers.provider.send("evm_revert", [checkpoint]);
    await deposit(f, alice, 2n); await f.pool.closeAtForTest(6);
    await expect(merkleClaim(f, orphaned, bob, 1)).to.be.revertedWithCustomError(f.pool, "InvalidProof");
    const canonical = await snapshot(f, 1, { pageSize: 3 });
    expect(canonical.root.hash).to.not.equal(orphaned.root.hash);
    await merkleClaim(f, canonical, bob, 1);
    expect(await clear(await f.pool.awardOf(1, bob.address))).to.equal(11n);
  });

  it("uses exact close log position when balances change before and after close in one block", async function () {
    const f = await fixture(2, 8), [alice, bob] = f.users;
    await deposit(f, alice, 3n); await deposit(f, bob, 7n);
    await deposit(f, f.admin, 11n, undefined, true);
    const inputs = [];
    for (const [user, amount] of [[alice, 1n], [bob, 2n]] as const) inputs.push(await fhevm.createEncryptedInput(await f.token.getAddress(), user.address).add64(amount).encrypt());
    const options = { gasLimit: 5_000_000, gasPrice: 1n };
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["bool", "uint256"], [false, 0]);
    await ethers.provider.send("evm_setAutomine", [false]);
    try {
      await ethers.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);
      const before = await f.token.connect(alice)["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](f.address, inputs[0].handles[0], inputs[0].inputProof, data, options);
      const close = await f.pool.closeAtForTest(6, options);
      const after = await f.token.connect(bob)["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](f.address, inputs[1].handles[0], inputs[1].inputProof, data, options);
      await ethers.provider.send("evm_mine", []);
      const receipts = await Promise.all([before.wait(), close.wait(), after.wait()]);
      expect(receipts[0].blockNumber).to.equal(receipts[2].blockNumber);
      expect(receipts[0].index).to.be.lessThan(receipts[1].index);
      expect(receipts[1].index).to.be.lessThan(receipts[2].index);
    } finally { await ethers.provider.send("evm_setAutomine", [true]); }
    const old = await snapshot(f, 1, { pageSize: 5 });
    expect(await clear(old.root.sum)).to.equal(11n);
    expect(await clear(await f.pool.total())).to.equal(13n);
    await merkleClaim(f, old, bob, 1);
    expect(await clear(await f.pool.awardOf(1, bob.address))).to.equal(11n);
  });

  it("finds the depth-32 two-deposit transaction batch limit and rolls back an oversized batch", async function () {
    const f = await fixture(2, 32), alice = f.users[0];
    const input = await fhevm.createEncryptedInput(await f.token.getAddress(), alice.address).add64(1n).encrypt();
    const call = f.token.interface.encodeFunctionData("confidentialTransferAndCall(address,bytes32,bytes,bytes)", [f.address, input.handles[0], input.inputProof, ethers.AbiCoder.defaultAbiCoder().encode(["bool", "uint256"], [false, 0])]);
    await f.token.connect(alice).multicall([call, call]);
    expect(await clear(await f.pool.principalOf(alice.address))).to.equal(2n);
    const hcu = new ethers.Contract("0x594BB474275918AF9609814E68C61B1587c5F838", ["error HCUTransactionLimitExceeded()"], ethers.provider);
    await expect(f.token.connect(alice).multicall([call, call, call])).to.be.revertedWithCustomError(hcu, "HCUTransactionLimitExceeded");
    expect(await clear(await f.pool.principalOf(alice.address))).to.equal(2n);
    expect(await clear(await f.token.confidentialBalanceOf(f.address))).to.equal(2n);
  });
});
