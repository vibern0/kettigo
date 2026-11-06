import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { captureMembershipProof, checkCapturedPrize } from "./proofHelper";

const USDC = (value: number) => BigInt(value) * 1_000_000n;
const DRAW_INTERVAL = 15n * 60n;
const WITHDRAWAL_BATCH_INTERVAL = 5n * 60n;
const MORPHO_UNWRAP_INTERVAL = 5n * 60n;

function readUint64(clearValues: Readonly<Record<`0x${string}`, unknown>>, handle: string): bigint {
  const value = clearValues[handle as `0x${string}`];
  if (typeof value !== "bigint") throw new Error("Expected an euint64 clear value");
  return value;
}

describe("v1 to v2 voluntary migration", function () {
  beforeEach(async function () {
    if (!fhevm.isMock) this.skip();
  });

  async function deployNamespace(poolFactoryName: string, wrapper: any, usdc: any, owner: any) {
    const Pool = await ethers.getContractFactory(poolFactoryName);
    const pool: any = await Pool.deploy(
      await wrapper.getAddress(),
      DRAW_INTERVAL,
      WITHDRAWAL_BATCH_INTERVAL,
    );
    await pool.waitForDeployment();
    const MockMorphoBlue = await ethers.getContractFactory("MockMorphoBlue");
    const morpho = await MockMorphoBlue.deploy();
    await morpho.waitForDeployment();
    const marketParams = {
      loanToken: await usdc.getAddress(),
      collateralToken: owner.address,
      oracle: ethers.ZeroAddress,
      irm: ethers.ZeroAddress,
      lltv: 945_000_000_000_000_000n,
    };
    await morpho.createMarket(marketParams);
    const Adapter = await ethers.getContractFactory("MorphoYieldAdapter");
    const adapter = await Adapter.deploy(
      await usdc.getAddress(),
      await wrapper.getAddress(),
      await pool.getAddress(),
      await morpho.getAddress(),
      marketParams,
    );
    await adapter.waitForDeployment();
    await pool.setMorphoYieldAdapter(await adapter.getAddress(), MORPHO_UNWRAP_INTERVAL);
    return { pool, wrapper, morpho, adapter };
  }

  async function deployFixture() {
    const [owner, alice, bob] = await ethers.getSigners();
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();
    const Wrapper = await ethers.getContractFactory("ConfidentialUSDC");
    const oldWrapper = await Wrapper.deploy(await usdc.getAddress());
    const newWrapper = await Wrapper.deploy(await usdc.getAddress());
    await oldWrapper.waitForDeployment();
    await newWrapper.waitForDeployment();
    const old = await deployNamespace(
      "contracts/test/fixtures/legacy-v1/ConfidentialPrizePoolV1.sol:LegacyConfidentialPrizePoolV1",
      oldWrapper,
      usdc,
      owner,
    );
    const fresh = await deployNamespace("ConfidentialPrizePool", newWrapper, usdc, owner);
    for (const user of [alice, bob]) {
      await usdc.connect(user).faucet(user.address, USDC(20));
      await usdc.connect(user).approve(await oldWrapper.getAddress(), USDC(20));
      await oldWrapper.connect(user).wrap(user.address, USDC(20));
    }
    await usdc.connect(owner).faucet(owner.address, USDC(40));
    await usdc.connect(owner).approve(await oldWrapper.getAddress(), USDC(20));
    await oldWrapper.connect(owner).wrap(owner.address, USDC(20));
    await usdc.connect(owner).approve(await newWrapper.getAddress(), USDC(20));
    await newWrapper.connect(owner).wrap(owner.address, USDC(20));
    return {
      owner,
      alice,
      bob,
      usdc,
      old: { ...old, wrapper: oldWrapper },
      fresh: { ...fresh, wrapper: newWrapper },
    };
  }

  async function deposit(wrapper: any, pool: any, user: any, amount: bigint, data = "0x") {
    const input = await fhevm
      .createEncryptedInput(await wrapper.getAddress(), user.address)
      .add64(amount)
      .encrypt();
    const userWrapper = wrapper.connect(user);
    await userWrapper["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](
      await pool.getAddress(),
      input.handles[0],
      input.inputProof,
      data,
    );
  }

  async function fundPrize(wrapper: any, pool: any, owner: any, amount: bigint) {
    const input = await fhevm
      .createEncryptedInput(await wrapper.getAddress(), owner.address)
      .add64(amount)
      .encrypt();
    const data = ethers.concat([
      await pool.PRIZE_FUNDING_DATA(),
      ethers.AbiCoder.defaultAbiCoder().encode(["uint64"], [amount]),
    ]);
    const ownerWrapper = wrapper.connect(owner);
    await ownerWrapper["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](
      await pool.getAddress(),
      input.handles[0],
      input.inputProof,
      data,
    );
  }

  async function admit(pool: any, account: string) {
    const pending = await pool.pendingAdmissionOf(account);
    const decrypted = await fhevm.publicDecrypt([pending.marker]);
    await pool.finalizeAdmission(account, pending.nonce, true, decrypted.decryptionProof);
  }

  async function requestWithdrawal(pool: any, user: any, amount: bigint) {
    const input = await fhevm
      .createEncryptedInput(await pool.getAddress(), user.address)
      .add64(amount)
      .encrypt();
    await pool.connect(user).requestWithdrawal(input.handles[0], input.inputProof);
    return pool.currentWithdrawalBatchId();
  }

  async function settle(pool: any, batchId: bigint) {
    await ethers.provider.send("evm_increaseTime", [Number(WITHDRAWAL_BATCH_INTERVAL)]);
    await ethers.provider.send("evm_mine", []);
    await pool.closeWithdrawalBatch(batchId);
    const total = await pool.encryptedWithdrawalBatchTotal(batchId);
    const restore = await pool.encryptedWithdrawalBatchMorphoRestore(batchId);
    const decrypted = await fhevm.publicDecrypt([total, restore]);
    await pool.settleWithdrawalBatch(
      batchId,
      readUint64(decrypted.clearValues, total),
      readUint64(decrypted.clearValues, restore),
      decrypted.decryptionProof,
    );
  }

  async function finalizeWithdrawal(pool: any, wrapper: any, batchId: bigint, user: any) {
    await pool.connect(user).claimWithdrawalToUsdc(batchId, user.address);
    const requestId = await pool.withdrawalUnwrapRequest(batchId, user.address);
    const decrypted = await fhevm.publicDecrypt([requestId]);
    await wrapper.finalizeUnwrap(
      requestId,
      readUint64(decrypted.clearValues, requestId),
      decrypted.decryptionProof,
    );
  }

  async function winnings(pool: any, user: any) {
    return fhevm.userDecryptEuint(
      FhevmType.euint64,
      await pool.encryptedWinningsOf(user.address),
      await pool.getAddress(),
      user,
    );
  }

  async function closeDraw(pool: any) {
    await ethers.provider.send("evm_increaseTime", [Number(DRAW_INTERVAL)]);
    await ethers.provider.send("evm_mine", []);
    await pool.closeDraw();
    return pool.drawId();
  }

  it("settles an old queued withdrawal before explicit v2 admission while preserving old eager credit", async function () {
    const { owner, alice, bob, usdc, old, fresh } = await deployFixture();
    await deposit(old.wrapper, old.pool, alice, USDC(3));
    await deposit(old.wrapper, old.pool, bob, USDC(2));
    await fundPrize(old.wrapper, old.pool, owner, USDC(1));
    await closeDraw(old.pool);
    expect(await old.pool.MAX_PARTICIPANTS()).to.equal(32n);
    const oldWins = [await winnings(old.pool, alice), await winnings(old.pool, bob)];
    expect(oldWins.filter((value) => value === USDC(1))).to.have.length(1);
    const oldWinner = oldWins[0] === USDC(1) ? alice : bob;
    const absentChecked = new ethers.Interface([
      "function checked(uint256,address) view returns (bool)",
    ]);
    await expect(
      ethers.provider.call({
        to: await old.pool.getAddress(),
        data: absentChecked.encodeFunctionData("checked", [1n, alice.address]),
      }),
    ).to.be.rejected;

    const batchId = await requestWithdrawal(old.pool, alice, USDC(3));
    await settle(old.pool, batchId);
    const before = await usdc.balanceOf(alice.address);
    await finalizeWithdrawal(old.pool, old.wrapper, batchId, alice);
    const received = (await usdc.balanceOf(alice.address)) - before;
    expect(received).to.equal(USDC(3));

    await usdc.connect(alice).approve(await fresh.wrapper.getAddress(), received);
    await fresh.wrapper.connect(alice).wrap(alice.address, received);
    expect(before + received - (await usdc.balanceOf(alice.address))).to.equal(received);
    await deposit(fresh.wrapper, fresh.pool, alice, received);
    expect(await fresh.pool.membershipIndexOf(alice.address)).to.equal(0n);
    await admit(fresh.pool, alice.address);
    expect(await fresh.pool.membershipIndexOf(alice.address)).to.be.greaterThan(0n);

    const freshPrincipal = await fresh.pool.encryptedPrincipalOf(alice.address);
    await old.pool.connect(oldWinner).claimPrize();
    expect(await winnings(old.pool, oldWinner)).to.equal(0n);
    expect(await fresh.pool.encryptedPrincipalOf(alice.address)).to.equal(freshPrincipal);
    const proof = await captureMembershipProof(fresh.pool, alice.address);
    await fundPrize(fresh.wrapper, fresh.pool, owner, USDC(1));
    const drawId = await closeDraw(fresh.pool);
    expect(await fresh.pool.checked(drawId, alice.address)).to.equal(false);
    expect(await fresh.pool.encryptedWinningsOf(alice.address)).to.equal(ethers.ZeroHash);
    await checkCapturedPrize(fresh.pool, drawId, alice.address, proof);
    expect(await fresh.pool.checked(drawId, alice.address)).to.equal(true);
    expect(await winnings(fresh.pool, alice)).to.equal(USDC(1));
  });

  it("settles old liabilities while an admitted v2 position has an unchecked historical draw", async function () {
    const { owner, alice, bob, old, fresh } = await deployFixture();
    await deposit(old.wrapper, old.pool, alice, USDC(2));
    await fundPrize(old.wrapper, old.pool, owner, USDC(1));
    await closeDraw(old.pool);
    expect(await winnings(old.pool, alice)).to.equal(USDC(1));
    const batchId = await requestWithdrawal(old.pool, alice, USDC(2));
    await ethers.provider.send("evm_increaseTime", [Number(WITHDRAWAL_BATCH_INTERVAL)]);
    await ethers.provider.send("evm_mine", []);
    await old.pool.closeWithdrawalBatch(batchId);
    expect(await old.pool.withdrawalBatchStatus(batchId)).to.equal(1n);
    await expect(
      old.pool.connect(alice).claimWithdrawalToUsdc(batchId, alice.address),
    ).to.be.revertedWithCustomError(old.pool, "WithdrawalBatchNotFunded");

    await usdcDepositForV2(fresh, bob, USDC(2));
    const proof = await captureMembershipProof(fresh.pool, bob.address);
    await fundPrize(fresh.wrapper, fresh.pool, owner, USDC(1));
    const drawId = await closeDraw(fresh.pool);
    expect(await fresh.pool.checked(drawId, bob.address)).to.equal(false);
    await settleClosed(old.pool, batchId);
    await finalizeWithdrawal(old.pool, old.wrapper, batchId, alice);
    await old.pool.connect(alice).claimPrize();
    expect(await fresh.pool.checked(drawId, bob.address)).to.equal(false);
    await checkCapturedPrize(fresh.pool, drawId, bob.address, proof);
    expect(await fresh.pool.checked(drawId, bob.address)).to.equal(true);
  });

  it("keeps both bound namespaces payable when prospective v2 onboarding is disabled", async function () {
    const { owner, alice, bob, old, fresh } = await deployFixture();
    await deposit(old.wrapper, old.pool, alice, USDC(2));
    await fundPrize(old.wrapper, old.pool, owner, USDC(1));
    await closeDraw(old.pool);
    expect(await winnings(old.pool, alice)).to.equal(USDC(1));
    const oldBatch = await requestWithdrawal(old.pool, alice, USDC(2));
    await ethers.provider.send("evm_increaseTime", [Number(WITHDRAWAL_BATCH_INTERVAL)]);
    await ethers.provider.send("evm_mine", []);
    await old.pool.closeWithdrawalBatch(oldBatch);

    await usdcDepositForV2(fresh, bob, USDC(2));
    const uncheckedProof = await captureMembershipProof(fresh.pool, bob.address);
    await fundPrize(fresh.wrapper, fresh.pool, owner, USDC(1));
    const uncheckedDraw = await closeDraw(fresh.pool);
    const checkedProof = await captureMembershipProof(fresh.pool, bob.address);
    await fundPrize(fresh.wrapper, fresh.pool, owner, USDC(1));
    const checkedDraw = await closeDraw(fresh.pool);
    await checkCapturedPrize(fresh.pool, checkedDraw, bob.address, checkedProof);
    expect(await winnings(fresh.pool, bob)).to.equal(USDC(1));
    const bound = {
      oldPool: await old.pool.getAddress(),
      oldWrapper: await old.wrapper.getAddress(),
      v2Pool: await fresh.pool.getAddress(),
      v2Wrapper: await fresh.wrapper.getAddress(),
    };
    let onboardingEnabled = false;
    const depositProspective = async () => {
      if (!onboardingEnabled)
        throw new Error("explicit-bound fallback: prospective onboarding disabled");
      await usdcDepositForV2(fresh, alice, USDC(1));
    };
    await expect(depositProspective()).to.be.rejectedWith("prospective onboarding disabled");
    expect(bound.v2Pool).to.equal(await fresh.pool.getAddress());
    await settleClosed(old.pool, oldBatch);
    await finalizeWithdrawal(old.pool, old.wrapper, oldBatch, alice);
    await old.pool.connect(alice).claimPrize();
    await checkCapturedPrize(fresh.pool, uncheckedDraw, bob.address, uncheckedProof);
    await fresh.pool.connect(bob).claimPrize();
    const v2Batch = await requestWithdrawal(fresh.pool, bob, USDC(2));
    await settle(fresh.pool, v2Batch);
    await finalizeWithdrawal(fresh.pool, fresh.wrapper, v2Batch, bob);
    onboardingEnabled = true;
    expect(onboardingEnabled).to.equal(true);
    expect(bound.oldPool).to.equal(await old.pool.getAddress());
    expect(bound.oldWrapper).to.equal(await old.wrapper.getAddress());
    expect(bound.v2Wrapper).to.equal(await fresh.wrapper.getAddress());
  });

  async function usdcDepositForV2(fresh: any, user: any, amount: bigint) {
    const usdc = await ethers.getContractAt("MockUSDC", await fresh.wrapper.underlying());
    await usdc.connect(user).faucet(user.address, amount);
    await usdc.connect(user).approve(await fresh.wrapper.getAddress(), amount);
    await fresh.wrapper.connect(user).wrap(user.address, amount);
    await deposit(fresh.wrapper, fresh.pool, user, amount);
    await admit(fresh.pool, user.address);
  }

  async function settleClosed(pool: any, batchId: bigint) {
    const total = await pool.encryptedWithdrawalBatchTotal(batchId);
    const restore = await pool.encryptedWithdrawalBatchMorphoRestore(batchId);
    const decrypted = await fhevm.publicDecrypt([total, restore]);
    await pool.settleWithdrawalBatch(
      batchId,
      readUint64(decrypted.clearValues, total),
      readUint64(decrypted.clearValues, restore),
      decrypted.decryptionProof,
    );
  }
});
