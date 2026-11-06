import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { captureMembershipProof, checkCapturedPrize } from "./proofHelper";
import {
  expectNamespaceUnchanged,
  readUint64,
  settleClosed,
  snapshotNamespace,
  usdcDepositForV2,
  wrapperBalance,
} from "./MigrationV1V2.helpers";

const USDC = (value: number) => BigInt(value) * 1_000_000n;
const DRAW_INTERVAL = 15n * 60n;
const WITHDRAWAL_BATCH_INTERVAL = 5n * 60n;
const MORPHO_UNWRAP_INTERVAL = 5n * 60n;

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
    const adapter = await deployAdapter(pool, wrapper, usdc, morpho, marketParams);
    return { pool, wrapper, morpho, adapter };
  }

  async function deployAdapter(pool: any, wrapper: any, usdc: any, morpho: any, marketParams: any) {
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
    return adapter;
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
    const fixture = await deployFixture();
    const { oldWinner, batchId } = await prepareOldEagerCreditAndBatch(fixture);
    const received = await explicitMigrationAndAdmission(fixture, batchId);
    await claimOldAndAssertFreshUnchanged(fixture, oldWinner);
    await v2CreditClaim(fixture, received);
  });

  async function prepareOldEagerCreditAndBatch({ owner, alice, bob, old }: any) {
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
    return { oldWinner, batchId };
  }

  async function explicitMigrationAndAdmission({ alice, usdc, old, fresh }: any, batchId: bigint) {
    const freshBeforeOldFinalization = await snapshotNamespace(usdc, fresh, alice.address, {
      tree: true,
    });
    const freshPendingBefore = await fresh.pool.pendingAdmissionOf(alice.address);
    expect(freshPendingBefore.requested).to.equal(false);
    expect(await fresh.pool.membershipIndexOf(alice.address)).to.equal(0n);
    const before = await usdc.balanceOf(alice.address);
    await finalizeWithdrawal(old.pool, old.wrapper, batchId, alice);
    const received = BigInt(await usdc.balanceOf(alice.address)) - BigInt(before);
    expect(received).to.equal(USDC(3));
    expectNamespaceUnchanged(
      freshBeforeOldFinalization,
      await snapshotNamespace(usdc, fresh, alice.address, { tree: true }),
    );

    await usdc.connect(alice).approve(await fresh.wrapper.getAddress(), received);
    await fresh.wrapper.connect(alice).wrap(alice.address, received);
    expect(await usdc.balanceOf(await fresh.wrapper.getAddress())).to.equal(
      freshBeforeOldFinalization.wrapperUsdc + received,
    );
    expect(before + received - (await usdc.balanceOf(alice.address))).to.equal(received);
    await deposit(fresh.wrapper, fresh.pool, alice, received);
    expect(await fresh.pool.membershipIndexOf(alice.address)).to.equal(0n);
    const pending = await fresh.pool.pendingAdmissionOf(alice.address);
    expect(pending.requested).to.equal(true);
    expect(pending.nonce).to.be.greaterThan(0n);
    expect(pending.marker).to.not.equal(ethers.ZeroHash);
    expect(pending.balance).to.not.equal(ethers.ZeroHash);
    await admit(fresh.pool, alice.address);
    expect(await fresh.pool.membershipIndexOf(alice.address)).to.be.greaterThan(0n);
    return received;
  }

  async function claimOldAndAssertFreshUnchanged({ alice, usdc, old, fresh }: any, oldWinner: any) {
    const freshBeforeOldPrizeClaim = await snapshotNamespace(usdc, fresh, alice.address, {
      tree: true,
    });
    await old.pool.connect(oldWinner).claimPrize();
    expect(await winnings(old.pool, oldWinner)).to.equal(0n);
    expectNamespaceUnchanged(
      freshBeforeOldPrizeClaim,
      await snapshotNamespace(usdc, fresh, alice.address, { tree: true }),
    );
  }

  async function v2CreditClaim({ owner, alice, fresh }: any, received: bigint) {
    expect(received).to.equal(USDC(3));
    const proof = await captureMembershipProof(fresh.pool, alice.address);
    await fundPrize(fresh.wrapper, fresh.pool, owner, USDC(1));
    const drawId = await closeDraw(fresh.pool);
    expect(await fresh.pool.checked(drawId, alice.address)).to.equal(false);
    expect(await fresh.pool.encryptedWinningsOf(alice.address)).to.equal(ethers.ZeroHash);
    await checkCapturedPrize(fresh.pool, drawId, alice.address, proof);
    expect(await fresh.pool.checked(drawId, alice.address)).to.equal(true);
    expect(await winnings(fresh.pool, alice)).to.equal(USDC(1));
  }

  it("settles old liabilities while an admitted v2 position has an unchecked historical draw", async function () {
    const fixture = await deployFixture();
    const { batchId, oldBeforeV2Activity } = await prepareClosedOldLiability(fixture);
    const { drawId, proof, freshBeforeOldSettlement } = await prepareUncheckedV2Draw(
      fixture,
      oldBeforeV2Activity,
      batchId,
    );
    await settleOldAndAssertFreshUnchanged(fixture, batchId, drawId, freshBeforeOldSettlement);
    await v2CreditClaimAndAssertOldUnchanged(fixture, batchId, drawId, proof);
  });

  async function prepareClosedOldLiability({ owner, alice, old, usdc }: any) {
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
    const oldBeforeV2Activity = await snapshotNamespace(usdc, old, alice.address, { batchId });
    return { batchId, oldBeforeV2Activity };
  }

  async function prepareUncheckedV2Draw(
    { owner, alice, bob, fresh, old, usdc }: any,
    oldBeforeV2Activity: any,
    batchId: bigint,
  ) {
    await usdcDepositForV2(fresh, bob, USDC(2));
    const proof = await captureMembershipProof(fresh.pool, bob.address);
    await fundPrize(fresh.wrapper, fresh.pool, owner, USDC(1));
    const drawId = await closeDraw(fresh.pool);
    expect(await fresh.pool.checked(drawId, bob.address)).to.equal(false);
    expect(await fresh.pool.encryptedWinningsOf(bob.address)).to.equal(ethers.ZeroHash);
    expect(await fresh.pool.encryptedAwardOf(drawId, bob.address)).to.equal(ethers.ZeroHash);
    expectNamespaceUnchanged(
      oldBeforeV2Activity,
      await snapshotNamespace(usdc, old, alice.address, { batchId }),
    );
    const freshBeforeOldSettlement = await snapshotNamespace(usdc, fresh, bob.address, {
      drawId,
      tree: true,
    });
    return { drawId, proof, freshBeforeOldSettlement };
  }

  async function settleOldAndAssertFreshUnchanged(
    { alice, bob, usdc, old, fresh }: any,
    batchId: bigint,
    drawId: bigint,
    freshBeforeOldSettlement: any,
  ) {
    const oldUsdcBefore = await usdc.balanceOf(alice.address);
    await settleClosed(old.pool, batchId);
    await finalizeWithdrawal(old.pool, old.wrapper, batchId, alice);
    expect((await usdc.balanceOf(alice.address)) - oldUsdcBefore).to.equal(USDC(2));
    await old.pool.connect(alice).claimPrize();
    expect(await old.pool.withdrawalBatchStatus(batchId)).to.equal(2n);
    expect(await old.pool.hasWithdrawalClaim(batchId, alice.address)).to.equal(false);
    expect(await winnings(old.pool, alice)).to.equal(0n);
    expectNamespaceUnchanged(
      freshBeforeOldSettlement,
      await snapshotNamespace(usdc, fresh, bob.address, { drawId, tree: true }),
    );
    expect(await fresh.pool.checked(drawId, bob.address)).to.equal(false);
  }

  async function v2CreditClaimAndAssertOldUnchanged(
    { alice, bob, usdc, old, fresh }: any,
    batchId: bigint,
    drawId: bigint,
    proof: any,
  ) {
    await checkCapturedPrize(fresh.pool, drawId, bob.address, proof);
    expect(await fresh.pool.checked(drawId, bob.address)).to.equal(true);
    expect(await winnings(fresh.pool, bob)).to.equal(USDC(1));
    const oldAfterSettlement = await snapshotNamespace(usdc, old, alice.address, { batchId });
    await fresh.pool.connect(bob).claimPrize();
    expect(await winnings(fresh.pool, bob)).to.equal(0n);
    expect(await wrapperBalance(fresh.wrapper, bob)).to.equal(USDC(1));
    expectNamespaceUnchanged(
      oldAfterSettlement,
      await snapshotNamespace(usdc, old, alice.address, { batchId }),
    );
  }

  it("keeps both bound namespaces payable when prospective v2 onboarding is disabled", async function () {
    const fixture = await deployFixture();
    const rollback = await rollbackPrepare(fixture);
    await assertProspectiveOnboardingIsDisabled(fixture, rollback);
    const oldAfterOldLiability = await settleOldLiability(fixture, rollback);
    const freshAfterLiabilities = await settleFreshLiabilities(
      fixture,
      rollback,
      oldAfterOldLiability,
    );
    await reenableAndAssertBoundNamespaces(fixture, rollback, freshAfterLiabilities);
  });

  async function rollbackPrepare({ owner, alice, bob, usdc, old, fresh }: any) {
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
    const oldBeforeDisabled = await snapshotNamespace(usdc, old, alice.address, {
      batchId: oldBatch,
    });
    const freshBeforeDisabled = await snapshotNamespace(usdc, fresh, bob.address, {
      drawId: uncheckedDraw,
      tree: true,
    });
    expect(freshBeforeDisabled.draw.checked).to.equal(false);
    expect(freshBeforeDisabled.draw.award).to.equal(ethers.ZeroHash);
    const bound = {
      oldPool: await old.pool.getAddress(),
      oldWrapper: await old.wrapper.getAddress(),
      v2Pool: await fresh.pool.getAddress(),
      v2Wrapper: await fresh.wrapper.getAddress(),
    };
    return {
      oldBatch,
      uncheckedDraw,
      uncheckedProof,
      oldBeforeDisabled,
      freshBeforeDisabled,
      bound,
      onboarding: { enabled: false },
    };
  }

  async function assertProspectiveOnboardingIsDisabled(
    fixture: any,
    { oldBatch, uncheckedDraw, oldBeforeDisabled, freshBeforeDisabled, bound, onboarding }: any,
  ) {
    const { alice, bob, old, fresh, usdc } = fixture;
    const depositProspective = async () => {
      if (!onboarding.enabled)
        throw new Error("explicit-bound fallback: prospective onboarding disabled");
      await usdcDepositForV2(fresh, alice, USDC(1));
    };
    await expect(depositProspective()).to.be.rejectedWith("prospective onboarding disabled");
    expect(bound.v2Pool).to.equal(await fresh.pool.getAddress());
    expectNamespaceUnchanged(
      oldBeforeDisabled,
      await snapshotNamespace(usdc, old, alice.address, { batchId: oldBatch }),
    );
    expectNamespaceUnchanged(
      freshBeforeDisabled,
      await snapshotNamespace(usdc, fresh, bob.address, { drawId: uncheckedDraw, tree: true }),
    );
  }

  async function settleOldLiability(
    { alice, bob, usdc, old, fresh }: any,
    { oldBatch, uncheckedDraw, freshBeforeDisabled }: any,
  ) {
    const oldUsdcBefore = await usdc.balanceOf(alice.address);
    await settleClosed(old.pool, oldBatch);
    await finalizeWithdrawal(old.pool, old.wrapper, oldBatch, alice);
    expect((await usdc.balanceOf(alice.address)) - oldUsdcBefore).to.equal(USDC(2));
    await old.pool.connect(alice).claimPrize();
    expect(await winnings(old.pool, alice)).to.equal(0n);
    expect(await old.pool.hasWithdrawalClaim(oldBatch, alice.address)).to.equal(false);
    expect(await old.pool.withdrawalBatchStatus(oldBatch)).to.equal(2n);
    expectNamespaceUnchanged(
      freshBeforeDisabled,
      await snapshotNamespace(usdc, fresh, bob.address, { drawId: uncheckedDraw, tree: true }),
    );
    const oldAfterOldLiability = await snapshotNamespace(usdc, old, alice.address, {
      batchId: oldBatch,
    });
    return oldAfterOldLiability;
  }

  async function settleFreshLiabilities(
    fixture: any,
    { oldBatch, uncheckedDraw, uncheckedProof }: any,
    oldAfterOldLiability: any,
  ) {
    const { alice, bob, usdc, old, fresh } = fixture;
    await checkCapturedPrize(fresh.pool, uncheckedDraw, bob.address, uncheckedProof);
    expect(await winnings(fresh.pool, bob)).to.equal(USDC(2));
    await fresh.pool.connect(bob).claimPrize();
    expect(await winnings(fresh.pool, bob)).to.equal(0n);
    expect(await wrapperBalance(fresh.wrapper, bob)).to.equal(USDC(2));
    const v2Batch = await requestWithdrawal(fresh.pool, bob, USDC(2));
    const freshUsdcBefore = await usdc.balanceOf(bob.address);
    await settle(fresh.pool, v2Batch);
    await finalizeWithdrawal(fresh.pool, fresh.wrapper, v2Batch, bob);
    expect((await usdc.balanceOf(bob.address)) - freshUsdcBefore).to.equal(USDC(2));
    expect(await fresh.pool.hasWithdrawalClaim(v2Batch, bob.address)).to.equal(false);
    expect(await fresh.pool.withdrawalBatchStatus(v2Batch)).to.equal(2n);
    expectNamespaceUnchanged(
      oldAfterOldLiability,
      await snapshotNamespace(usdc, old, alice.address, { batchId: oldBatch }),
    );
    const freshAfterLiabilities = await snapshotNamespace(usdc, fresh, bob.address, {
      drawId: uncheckedDraw,
      tree: true,
    });
    return freshAfterLiabilities;
  }

  async function reenableAndAssertBoundNamespaces(
    fixture: any,
    { uncheckedDraw, bound, onboarding }: any,
    freshAfterLiabilities: any,
  ) {
    const { bob, old, fresh, usdc } = fixture;
    onboarding.enabled = true;
    expect(onboarding.enabled).to.equal(true);
    expect(bound.oldPool).to.equal(await old.pool.getAddress());
    expect(bound.oldWrapper).to.equal(await old.wrapper.getAddress());
    expect(bound.v2Wrapper).to.equal(await fresh.wrapper.getAddress());
    expect(await old.adapter.prizePool()).to.equal(bound.oldPool);
    expect(await fresh.adapter.prizePool()).to.equal(bound.v2Pool);
    expectNamespaceUnchanged(
      freshAfterLiabilities,
      await snapshotNamespace(usdc, fresh, bob.address, { drawId: uncheckedDraw, tree: true }),
    );
  }
});
