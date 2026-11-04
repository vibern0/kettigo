import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";

const DRAW_INTERVAL = 15n * 60n;
const WITHDRAWAL_BATCH_INTERVAL = 5n * 60n;

describe("ConfidentialPrizePool membership", function () {
  beforeEach(async function () {
    if (!fhevm.isMock) this.skip();
  });

  async function fixture() {
    const [owner, alice, bob] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const token = await (await ethers.getContractFactory("ConfidentialUSDC")).deploy(await usdc.getAddress());
    const pool = await (await ethers.getContractFactory("ConfidentialPrizePool")).deploy(
      await token.getAddress(), DRAW_INTERVAL, WITHDRAWAL_BATCH_INTERVAL,
    );
    for (const user of [owner, alice, bob]) {
      await usdc.faucet(user.address, 1_000_000n);
      await usdc.connect(user).approve(await token.getAddress(), 1_000_000n);
      await token.connect(user).wrap(user.address, 1_000_000n);
    }
    return { owner, alice, bob, usdc, token, pool };
  }

  async function deposit(token: any, pool: any, user: any, amount: bigint) {
    const input = await fhevm.createEncryptedInput(await token.getAddress(), user.address).add64(amount).encrypt();
    await token.connect(user)["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](
      await pool.getAddress(), input.handles[0], input.inputProof, "0x",
    );
  }

  async function admit(pool: any, account: string) {
    const pending = await pool.pendingAdmissionOf(account);
    const proof = await fhevm.publicDecrypt([pending.marker]);
    await pool.finalizeAdmission(account, pending.nonce, true, proof.decryptionProof);
  }

  async function configureWithdrawalAdapter(f: any) {
    const morpho = await (await ethers.getContractFactory("MockMorphoBlue")).deploy();
    const marketParams = {
      loanToken: await f.usdc.getAddress(), collateralToken: f.bob.address,
      oracle: ethers.ZeroAddress, irm: ethers.ZeroAddress, lltv: 945_000_000_000_000_000n,
    };
    await morpho.createMarket(marketParams);
    const adapter = await (await ethers.getContractFactory("MorphoYieldAdapter")).deploy(
      await f.usdc.getAddress(), await f.token.getAddress(), await f.pool.getAddress(), await morpho.getAddress(), marketParams,
    );
    await f.pool.setMorphoYieldAdapter(await adapter.getAddress(), 1n);
  }

  async function accounting(pool: any) {
    const [total, pending] = await Promise.all([
      pool.encryptedTotalPrincipal(), pool.encryptedPendingAdmissionPrincipal(),
    ]);
    const [, active] = await pool.membershipNode(32, 0);
    return {
      total: await fhevm.debugger.decryptEuint(FhevmType.euint64, total),
      pending: await fhevm.debugger.decryptEuint(FhevmType.euint64, pending),
      active: await fhevm.debugger.decryptEuint(FhevmType.euint64, active),
    };
  }

  it("admits33FundedUsers", async function () {
    const { usdc, token, pool } = await fixture();
    for (let i = 0; i < 33; ++i) {
      const address = ethers.getAddress(ethers.toBeHex(0x71000 + i, 20));
      await ethers.provider.send("hardhat_setBalance", [address, "0x56BC75E2D63100000"]);
      const user = await ethers.getImpersonatedSigner(address);
      await usdc.faucet(address, 1n);
      await usdc.connect(user).approve(await token.getAddress(), 1n);
      await token.connect(user).wrap(address, 1n);
      await deposit(token, pool, user, 1n);
      await admit(pool, address);
    }
    expect(await pool.activeMemberCount()).to.equal(33n);
  });

  it("rejectsZeroAndStaleAdmission", async function () {
    const { alice, token, pool } = await fixture();
    await deposit(token, pool, alice, 0n);
    const zero = await pool.pendingAdmissionOf(alice.address);
    const zeroProof = await fhevm.publicDecrypt([zero.marker]);
    await pool.finalizeAdmission(alice.address, zero.nonce, false, zeroProof.decryptionProof);
    expect(await pool.activeMemberCount()).to.equal(0n);
    await deposit(token, pool, alice, 2n);
    const stale = await pool.pendingAdmissionOf(alice.address);
    const staleProof = await fhevm.publicDecrypt([stale.marker]);
    await deposit(token, pool, alice, 1n);
    await expect(pool.finalizeAdmission(alice.address, stale.nonce, true, staleProof.decryptionProof))
      .to.be.revertedWithCustomError(pool, "StaleAdmission");
  });

  it("pendingWithdrawalInvalidatesAdmission", async function () {
    const f = await fixture(); const { alice, token, pool } = f;
    await configureWithdrawalAdapter(f);
    await deposit(token, pool, alice, 3n);
    const pending = await pool.pendingAdmissionOf(alice.address);
    const proof = await fhevm.publicDecrypt([pending.marker]);
    const input = await fhevm.createEncryptedInput(await pool.getAddress(), alice.address).add64(1n).encrypt();
    await pool.connect(alice).requestWithdrawal(input.handles[0], input.inputProof);
    await expect(pool.finalizeAdmission(alice.address, pending.nonce, true, proof.decryptionProof))
      .to.be.revertedWithCustomError(pool, "StaleAdmission");
  });

  it("exitReusesSlotWithNewGeneration", async function () {
    const f = await fixture(); const { alice, bob, token, pool } = f;
    await configureWithdrawalAdapter(f);
    await deposit(token, pool, alice, 1n); await admit(pool, alice.address);
    const slot = await pool.membershipIndexOf(alice.address);
    const generation = await pool.generationOf(slot - 1n);
    await pool.connect(alice).exitMembership();
    expect(await pool.hasWithdrawalClaim(await pool.currentWithdrawalBatchId(), alice.address)).to.equal(true);
    await deposit(token, pool, bob, 1n); await admit(pool, bob.address);
    expect(await pool.membershipIndexOf(bob.address)).to.equal(slot);
    expect(await pool.generationOf(slot - 1n)).to.equal(generation + 1n);
  });

  it("aggregateOverflowDoesNotCorruptBacking", async function () {
    const { alice, usdc, token, pool } = await fixture();
    await usdc.faucet(alice.address, 1_000_000_000n);
    await usdc.connect(alice).approve(await token.getAddress(), 1_000_000_000n);
    await token.connect(alice).wrap(alice.address, 1_000_000_000n);
    await deposit(token, pool, alice, 1_000_000_000n); await admit(pool, alice.address);
    await deposit(token, pool, alice, 1n);
    const principal = await pool.encryptedPrincipalOf(alice.address);
    expect(await fhevm.userDecryptEuint(FhevmType.euint64, principal, await pool.getAddress(), alice)).to.equal(1_000_000_000n);
  });

  it("keeps active plus pending equal to total through admission withdrawal and exit", async function () {
    const f = await fixture(); const { alice, token, pool } = f;
    await configureWithdrawalAdapter(f);
    await deposit(token, pool, alice, 3n);
    expect(await accounting(pool)).to.deep.equal({ total: 3n, pending: 3n, active: 0n });
    await admit(pool, alice.address);
    expect(await accounting(pool)).to.deep.equal({ total: 3n, pending: 0n, active: 3n });
    const input = await fhevm.createEncryptedInput(await pool.getAddress(), alice.address).add64(1n).encrypt();
    await pool.connect(alice).requestWithdrawal(input.handles[0], input.inputProof);
    expect(await accounting(pool)).to.deep.equal({ total: 2n, pending: 0n, active: 2n });
    await pool.connect(alice).exitMembership();
    expect(await accounting(pool)).to.deep.equal({ total: 0n, pending: 0n, active: 0n });
  });

  it("keeps the membership aggregate aligned when winnings are reinvested", async function () {
    const { owner, alice, token, pool } = await fixture();
    await deposit(token, pool, alice, 3n); await admit(pool, alice.address);
    const prize = await fhevm.createEncryptedInput(await token.getAddress(), owner.address).add64(2n).encrypt();
    await token.connect(owner)["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](
      await pool.getAddress(), prize.handles[0], prize.inputProof,
      ethers.concat([await pool.PRIZE_FUNDING_DATA(), ethers.AbiCoder.defaultAbiCoder().encode(["uint64"], [2n])]),
    );
    await ethers.provider.send("evm_increaseTime", [Number(DRAW_INTERVAL) + 1]); await ethers.provider.send("evm_mine", []);
    await pool.closeDraw(); await pool.connect(alice).claimPrizeToSavings();
    expect(await accounting(pool)).to.deep.equal({ total: 5n, pending: 0n, active: 5n });
  });

  it("synthetically rejects an aggregate uint64 overflow without moving callback tokens", async function () {
    const [owner, alice] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const token = await (await ethers.getContractFactory("ConfidentialUSDC")).deploy(await usdc.getAddress());
    const pool = await (await ethers.getContractFactory("ConfidentialPrizePoolHarness")).deploy(
      await token.getAddress(), DRAW_INTERVAL, WITHDRAWAL_BATCH_INTERVAL,
    );
    await usdc.faucet(alice.address, 2n);
    await usdc.connect(alice).approve(await token.getAddress(), 2n);
    await token.connect(alice).wrap(alice.address, 2n);
    const seed = await fhevm.createEncryptedInput(await pool.getAddress(), owner.address).add64((1n << 64n) - 1n).encrypt();
    await pool.seedTotalPrincipal(seed.handles[0], seed.inputProof);
    const before = await token.confidentialBalanceOf(alice.address);
    const attemptsBefore = await pool.morphoPendingDepositCount();
    const input = await fhevm.createEncryptedInput(await token.getAddress(), alice.address).add64(1n).encrypt();
    await token.connect(alice)["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](
      await pool.getAddress(), input.handles[0], input.inputProof, "0x",
    );
    const after = await token.confidentialBalanceOf(alice.address);
    expect(await fhevm.userDecryptEuint(FhevmType.euint64, after, await token.getAddress(), alice)).to.equal(
      await fhevm.userDecryptEuint(FhevmType.euint64, before, await token.getAddress(), alice),
    );
    expect(await fhevm.debugger.decryptEuint(FhevmType.euint64, await pool.encryptedTotalPrincipal())).to.equal((1n << 64n) - 1n);
    expect(await fhevm.debugger.decryptEuint(FhevmType.euint64, await pool.encryptedPendingMorphoPrincipal())).to.equal(0n);
    // This counter is intentionally a public scheduling-attempt count, not an acceptance bit.
    expect(await pool.morphoPendingDepositCount()).to.equal(attemptsBefore + 1n);
  });

  it("preserves backing and winnings when cap-rejected reinvestment adds only a scheduling attempt", async function () {
    const { owner, alice, usdc, token, pool } = await fixture();
    await usdc.faucet(alice.address, 1_000_000_000n);
    await usdc.connect(alice).approve(await token.getAddress(), 1_000_000_000n);
    await token.connect(alice).wrap(alice.address, 1_000_000_000n);
    await deposit(token, pool, alice, 1_000_000_000n); await admit(pool, alice.address);
    const prize = await fhevm.createEncryptedInput(await token.getAddress(), owner.address).add64(1n).encrypt();
    await token.connect(owner)["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](
      await pool.getAddress(), prize.handles[0], prize.inputProof,
      ethers.concat([await pool.PRIZE_FUNDING_DATA(), ethers.AbiCoder.defaultAbiCoder().encode(["uint64"], [1n])]),
    );
    await ethers.provider.send("evm_increaseTime", [Number(DRAW_INTERVAL) + 1]); await ethers.provider.send("evm_mine", []);
    await pool.closeDraw();
    const [principalBefore, totalBefore, pendingBefore, poolBalanceBefore, attemptsBefore] = await Promise.all([
      pool.encryptedPrincipalOf(alice.address), pool.encryptedTotalPrincipal(), pool.encryptedPendingMorphoPrincipal(),
      token.confidentialBalanceOf(await pool.getAddress()), pool.morphoPendingDepositCount(),
    ]);
    await pool.connect(alice).claimPrizeToSavings();
    for (const [after, before] of [
      [await pool.encryptedPrincipalOf(alice.address), principalBefore],
      [await pool.encryptedTotalPrincipal(), totalBefore],
      [await pool.encryptedPendingMorphoPrincipal(), pendingBefore],
      [await token.confidentialBalanceOf(await pool.getAddress()), poolBalanceBefore],
    ] as const) {
      expect(await fhevm.debugger.decryptEuint(FhevmType.euint64, after)).to.equal(
        await fhevm.debugger.decryptEuint(FhevmType.euint64, before),
      );
    }
    expect(await fhevm.userDecryptEuint(FhevmType.euint64, await pool.encryptedWinningsOf(alice.address), await pool.getAddress(), alice)).to.equal(1n);
    expect(await pool.morphoPendingDepositCount()).to.equal(attemptsBefore + 1n);
  });

  it("allows a keeper to clear a rejected-only scheduling attempt with a zero aggregate unwrap", async function () {
    const f = await fixture(); const { alice, usdc, token, pool } = f;
    await configureWithdrawalAdapter(f);
    await usdc.faucet(alice.address, 1_000_000_001n);
    await usdc.connect(alice).approve(await token.getAddress(), 1_000_000_001n);
    await token.connect(alice).wrap(alice.address, 1_000_000_001n);
    await deposit(token, pool, alice, 1_000_000_001n);
    expect(await fhevm.debugger.decryptEuint(FhevmType.euint64, await pool.encryptedPendingMorphoPrincipal())).to.equal(0n);
    expect(await pool.morphoPendingDepositCount()).to.equal(1n);
    await ethers.provider.send("evm_increaseTime", [2]); await ethers.provider.send("evm_mine", []);
    await expect(pool.requestMorphoPrincipalUnwrap()).to.emit(pool, "MorphoPrincipalUnwrapRequested");
    expect(await pool.morphoPendingDepositCount()).to.equal(0n);
  });
});
