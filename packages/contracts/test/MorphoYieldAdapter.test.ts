import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { captureMembershipProof, checkCapturedPrize } from "./proofHelper";

const USDC = (n: number) => BigInt(n) * 1_000_000n;
const DRAW_INTERVAL = 15n * 60n;
const MORPHO_UNWRAP_INTERVAL = 5n * 60n;
const WITHDRAWAL_BATCH_INTERVAL = 5n * 60n;

describe("MorphoYieldAdapter", function () {
  beforeEach(async function () {
    if (!fhevm.isMock) {
      this.skip();
    }
  });

  async function deployFixture() {
    const [owner, keeper] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();

    const ConfidentialUSDC = await ethers.getContractFactory("ConfidentialUSDC");
    const confidentialUsdc = await ConfidentialUSDC.deploy(await usdc.getAddress());
    await confidentialUsdc.waitForDeployment();

    const ConfidentialPrizePool = await ethers.getContractFactory("ConfidentialPrizePool");
    const pool = await ConfidentialPrizePool.deploy(
      await confidentialUsdc.getAddress(),
      DRAW_INTERVAL,
      WITHDRAWAL_BATCH_INTERVAL,
    );
    await pool.waitForDeployment();

    const MockMorphoBlue = await ethers.getContractFactory("MockMorphoBlue");
    const morpho = await MockMorphoBlue.deploy();
    await morpho.waitForDeployment();

    const marketParams = {
      loanToken: await usdc.getAddress(),
      collateralToken: keeper.address,
      oracle: ethers.ZeroAddress,
      irm: ethers.ZeroAddress,
      lltv: 945_000_000_000_000_000n,
    };
    await morpho.createMarket(marketParams);

    const MorphoYieldAdapter = await ethers.getContractFactory("MorphoYieldAdapter");
    const adapter = await MorphoYieldAdapter.deploy(
      await usdc.getAddress(),
      await confidentialUsdc.getAddress(),
      await pool.getAddress(),
      await morpho.getAddress(),
      marketParams,
    );
    await adapter.waitForDeployment();

    await usdc.faucet(owner.address, USDC(1_500));
    await usdc.faucet(keeper.address, USDC(50));
    await pool.setMorphoYieldAdapter(await adapter.getAddress(), MORPHO_UNWRAP_INTERVAL);

    return {
      owner,
      keeper,
      usdc,
      confidentialUsdc,
      pool,
      morpho,
      adapter,
      marketParams,
    };
  }

  async function encryptedDeposit(
    confidentialUsdc: any,
    confidentialUsdcAddress: string,
    poolAddress: string,
    user: any,
    amount: bigint,
  ) {
    const encryptedAmount = await fhevm
      .createEncryptedInput(confidentialUsdcAddress, user.address)
      .add64(amount)
      .encrypt();

    const connectedUsdc = confidentialUsdc.connect(user);
    await connectedUsdc["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](
      poolAddress,
      encryptedAmount.handles[0],
      encryptedAmount.inputProof,
      "0x",
    );
  }

  async function finalizeAdmission(pool: any, account: string) {
    const pending = await pool.pendingAdmissionOf(account);
    const decrypted = await fhevm.publicDecrypt([pending.marker]);
    await pool.finalizeAdmission(account, pending.nonce, true, decrypted.decryptionProof);
  }

  async function closeAndCheck(pool: any, drawId: bigint, account: string, proof: any) {
    await ethers.provider.send("evm_increaseTime", [Number(DRAW_INTERVAL)]);
    await ethers.provider.send("evm_mine", []);
    const close = await pool.closeDraw();
    await checkCapturedPrize(pool, drawId, account, proof);
    return close;
  }

  async function requestWithdrawal(pool: any, poolAddress: string, user: any, amount: bigint) {
    const encryptedAmount = await fhevm
      .createEncryptedInput(poolAddress, user.address)
      .add64(amount)
      .encrypt();
    await pool
      .connect(user)
      .requestWithdrawal(encryptedAmount.handles[0], encryptedAmount.inputProof);
  }

  async function prepareYieldingDraw(firstDrawIsLazy: boolean) {
    const f = await deployFixture();
    const poolAddress = await f.pool.getAddress();
    const confidentialUsdcAddress = await f.confidentialUsdc.getAddress();
    await f.usdc.approve(confidentialUsdcAddress, USDC(1));
    await f.confidentialUsdc.wrap(f.owner.address, USDC(1));
    await encryptedDeposit(
      f.confidentialUsdc,
      confidentialUsdcAddress,
      poolAddress,
      f.owner,
      USDC(1),
    );
    await finalizeAdmission(f.pool, f.owner.address);
    const ownerProof = await captureMembershipProof(f.pool, f.owner.address);
    await f.usdc.transfer(await f.adapter.getAddress(), USDC(1_000));
    await f.pool.supplyFinalizedMorphoPrincipal(USDC(1_000));
    await f.usdc.connect(f.keeper).approve(await f.morpho.getAddress(), USDC(50));
    if (firstDrawIsLazy) {
      await f.morpho.connect(f.keeper).queueYield(f.marketParams, USDC(25));
    } else {
      await f.morpho.connect(f.keeper).accrueYield(f.marketParams, USDC(25));
    }
    expect(await f.adapter.accruedYieldAssets()).to.equal(firstDrawIsLazy ? 0n : USDC(25) - 1n);
    return { ...f, poolAddress, ownerProof };
  }

  async function assertFirstDrawHarvest(f: any) {
    const firstClose = await closeAndCheck(f.pool, 1n, f.owner.address, f.ownerProof);
    const encryptedWinnings = await f.pool.encryptedWinningsOf(f.owner.address);
    const firstDrawWinnings = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedWinnings,
      f.poolAddress,
      f.owner,
    );
    expect(firstDrawWinnings).to.equal(USDC(25) - 1n);
    await expect(firstClose)
      .to.emit(f.pool, "MorphoYieldHarvested")
      .withArgs(USDC(25) - 1n);
    expect(await f.adapter.suppliedPrincipal()).to.equal(USDC(1_000));
    expect(await f.adapter.suppliedAssets()).to.equal(USDC(1_000));
    expect(await f.pool.publicPrizeReserve()).to.equal(0n);
    expect(await f.pool.morphoAccruedYieldAssets()).to.equal(0n);
    return firstDrawWinnings;
  }

  async function assertSecondDrawHarvest(f: any, firstDrawWinnings: bigint) {
    await f.morpho.connect(f.keeper).accrueYield(f.marketParams, USDC(7));
    const observableYield = await f.adapter.accruedYieldAssets();
    expect(observableYield).to.be.greaterThan(0n);
    await f.morpho.connect(f.keeper).queueYield(f.marketParams, USDC(10));
    expect(await f.adapter.accruedYieldAssets()).to.equal(observableYield);
    const secondClose = await closeAndCheck(f.pool, 2n, f.owner.address, f.ownerProof);
    const updatedEncryptedWinnings = await f.pool.encryptedWinningsOf(f.owner.address);
    const secondDrawWinnings = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      updatedEncryptedWinnings,
      f.poolAddress,
      f.owner,
    );
    expect(secondDrawWinnings).to.equal(USDC(42) - 1n);
    expect(secondDrawWinnings - firstDrawWinnings).to.equal(USDC(17));
    await expect(secondClose).to.emit(f.pool, "MorphoYieldHarvested").withArgs(USDC(17));
    expect(await f.adapter.suppliedPrincipal()).to.equal(USDC(1_000));
    expect(await f.adapter.suppliedAssets()).to.equal(USDC(1_000));
    expect(await f.pool.publicPrizeReserve()).to.equal(0n);
    expect(await f.pool.morphoAccruedYieldAssets()).to.equal(0n);
  }

  async function prepareCallbackMatrix() {
    const f = await deployFixture();
    const confidentialUsdcAddress = await f.confidentialUsdc.getAddress();
    const poolAddress = await f.pool.getAddress();
    await f.usdc.approve(confidentialUsdcAddress, USDC(1));
    await f.confidentialUsdc.wrap(f.owner.address, USDC(1));
    await encryptedDeposit(
      f.confidentialUsdc,
      confidentialUsdcAddress,
      poolAddress,
      f.owner,
      USDC(1),
    );
    await finalizeAdmission(f.pool, f.owner.address);
    await f.usdc.transfer(await f.adapter.getAddress(), USDC(100));
    await f.pool.supplyFinalizedMorphoPrincipal(USDC(100));

    const Callback = await ethers.getContractFactory("RestoreCallbackAttacker");
    const callback = await Callback.deploy(await f.pool.getAddress(), await f.adapter.getAddress());
    const withdrawalInput = await fhevm
      .createEncryptedInput(await f.pool.getAddress(), await callback.getAddress())
      .add64(USDC(1))
      .encrypt();
    await callback.configureWithdrawal(withdrawalInput.handles[0], withdrawalInput.inputProof);
    await f.morpho.configureWithdrawCallback(await callback.getAddress(), USDC(1));
    return { ...f, callback };
  }

  async function assertCallbackRejections(f: any) {
    expect(await f.callback.poolRestoreSucceeded()).to.equal(false);
    expect(await f.callback.adapterRestoreSucceeded()).to.equal(false);
    expect(await f.callback.adapterHarvestSucceeded()).to.equal(false);
    expect(await f.callback.closeDrawSucceeded()).to.equal(false);
    expect(await f.callback.settleWithdrawalSucceeded()).to.equal(false);
    expect(await f.callback.poolRestoreRevertData()).to.equal(
      f.pool.interface.getError("OnlyOwner")!.selector,
    );
    expect(await f.callback.adapterRestoreRevertData()).to.equal(
      f.adapter.interface.getError("OnlyPrizePool")!.selector,
    );
    expect(await f.callback.adapterHarvestRevertData()).to.equal(
      f.adapter.interface.getError("OnlyPrizePool")!.selector,
    );
    expect(await f.callback.closeDrawRevertData()).to.equal(
      f.adapter.interface.getError("ReentrancyGuardReentrantCall")!.selector,
    );
    expect(await f.callback.settleWithdrawalRevertData()).to.equal(
      f.pool.interface.encodeErrorResult("WithdrawalBatchNotClosed", [0n]),
    );
  }

  async function assertCallbackWithdrawalAndOuterAccounting(f: any, before: any) {
    expect(await f.callback.requestWithdrawalSucceeded()).to.equal(true);
    expect(await f.adapter.suppliedPrincipal()).to.equal(USDC(75));
    expect(await f.adapter.suppliedAssets()).to.equal(USDC(75));
    expect(await f.pool.morphoPendingDepositCount()).to.equal(before.pendingDepositCount + 1n);
    expect(await f.pool.participantCount()).to.equal(1n);
    const callbackRequestBatchId = before.batchId + 1n;
    expect(await f.pool.currentWithdrawalBatchId()).to.equal(callbackRequestBatchId);
    expect(await f.pool.withdrawalAccounts(callbackRequestBatchId)).to.deep.equal([
      await f.callback.getAddress(),
    ]);
    expect(await fhevm.debugger.decryptEuint(FhevmType.euint64, before.ownerPrincipal)).to.equal(
      await fhevm.debugger.decryptEuint(
        FhevmType.euint64,
        await f.pool.encryptedPrincipalOf(f.owner.address),
      ),
    );
    expect(await fhevm.debugger.decryptEuint(FhevmType.euint64, before.total)).to.equal(
      await fhevm.debugger.decryptEuint(FhevmType.euint64, await f.pool.encryptedTotalPrincipal()),
    );
    expect(
      await fhevm.debugger.decryptEuint(
        FhevmType.euint64,
        await f.pool.encryptedWithdrawalBatchTotal(callbackRequestBatchId),
      ),
    ).to.equal(0n);
  }

  it("lets a keeper request one timed principal unwrap", async function () {
    const { owner, keeper, usdc, confidentialUsdc, pool, adapter } = await deployFixture();
    const users = [owner, keeper];
    const confidentialUsdcAddress = await confidentialUsdc.getAddress();
    const poolAddress = await pool.getAddress();

    for (const user of users) {
      await usdc.connect(user).approve(confidentialUsdcAddress, USDC(4));
      await confidentialUsdc.connect(user).wrap(user.address, USDC(4));
    }

    await encryptedDeposit(confidentialUsdc, confidentialUsdcAddress, poolAddress, owner, USDC(1));
    await encryptedDeposit(confidentialUsdc, confidentialUsdcAddress, poolAddress, keeper, USDC(2));
    await encryptedDeposit(confidentialUsdc, confidentialUsdcAddress, poolAddress, owner, USDC(3));

    await expect(pool.connect(keeper).requestMorphoPrincipalUnwrap()).to.be.revertedWithCustomError(
      pool,
      "MorphoUnwrapNotReady",
    );

    await ethers.provider.send("evm_increaseTime", [Number(MORPHO_UNWRAP_INTERVAL)]);
    await ethers.provider.send("evm_mine", []);

    const tx = await pool.connect(keeper).requestMorphoPrincipalUnwrap();
    const receipt = await tx.wait();
    const parsedLogs = receipt?.logs
      .map((log: any) => {
        try {
          return confidentialUsdc.interface.parseLog(log);
        } catch {
          return undefined;
        }
      })
      .filter(Boolean);
    const unwrapRequestId = parsedLogs?.find((log: any) => log.name === "UnwrapRequested")?.args
      .unwrapRequestId;

    expect(unwrapRequestId).to.not.equal(undefined);
    expect(await confidentialUsdc.unwrapRequester(unwrapRequestId)).to.equal(
      await adapter.getAddress(),
    );
    expect(await pool.morphoPendingDepositCount()).to.equal(0n);
    expect(await pool.lastMorphoUnwrapAt()).to.be.greaterThan(0n);

    const pending = await pool.encryptedPendingMorphoPrincipal();
    expect(await fhevm.debugger.decryptEuint(FhevmType.euint64, pending)).to.equal(0n);
  });

  it("removes withdrawals from pending Morpho principal before a batch unwrap", async function () {
    const { owner, usdc, confidentialUsdc, pool } = await deployFixture();
    const confidentialUsdcAddress = await confidentialUsdc.getAddress();
    const poolAddress = await pool.getAddress();

    await usdc.connect(owner).approve(confidentialUsdcAddress, USDC(4));
    await confidentialUsdc.connect(owner).wrap(owner.address, USDC(4));

    await encryptedDeposit(confidentialUsdc, confidentialUsdcAddress, poolAddress, owner, USDC(4));
    await requestWithdrawal(pool, poolAddress, owner, USDC(1));

    const pending = await pool.encryptedPendingMorphoPrincipal();
    expect(await fhevm.debugger.decryptEuint(FhevmType.euint64, pending)).to.equal(USDC(3));
  });

  it("supplies available finalized principal from the adapter to Morpho", async function () {
    const { usdc, pool, adapter } = await deployFixture();

    await usdc.transfer(await adapter.getAddress(), USDC(125));
    await pool.supplyAvailableMorphoPrincipal();

    expect(await adapter.suppliedPrincipal()).to.equal(USDC(125));
    expect(await adapter.suppliedAssets()).to.equal(USDC(125));
    expect(await usdc.balanceOf(await adapter.getAddress())).to.equal(1n);
    expect(await adapter.availablePrincipalAssets()).to.equal(0n);
  });

  it("supplies finalized batch principal to Morpho and can restore it to the pool", async function () {
    const { usdc, confidentialUsdc, pool, adapter } = await deployFixture();

    await usdc.transfer(await adapter.getAddress(), USDC(1_000));
    await pool.supplyFinalizedMorphoPrincipal(USDC(1_000));

    expect(await adapter.suppliedPrincipal()).to.equal(USDC(1_000));
    expect(await adapter.suppliedAssets()).to.equal(USDC(1_000));

    await pool.restoreMorphoPrincipal(USDC(250));

    expect(await adapter.suppliedPrincipal()).to.equal(USDC(750));
    expect(await adapter.suppliedAssets()).to.equal(USDC(750));
    const encryptedPoolBalance = await confidentialUsdc.confidentialBalanceOf(
      await pool.getAddress(),
    );
    expect(await fhevm.debugger.decryptEuint(FhevmType.euint64, encryptedPoolBalance)).to.equal(
      USDC(250),
    );
  });

  it("keeps enough idle principal to cover Morpho virtual-share rounding", async function () {
    const { keeper, usdc, confidentialUsdc, pool, morpho, adapter, marketParams } =
      await deployFixture();

    await usdc.connect(keeper).approve(await morpho.getAddress(), USDC(50));
    await morpho.connect(keeper).supply(marketParams, USDC(50), 0, keeper.address, "0x");

    const principal = 900_000n;
    await usdc.transfer(await adapter.getAddress(), principal);
    await pool.supplyAvailableMorphoPrincipal();

    expect(await adapter.suppliedPrincipal()).to.equal(principal);
    expect(await usdc.balanceOf(await adapter.getAddress())).to.equal(1n);
    expect(await adapter.availablePrincipalAssets()).to.equal(0n);
    await pool.restoreMorphoPrincipal(principal);

    const encryptedPoolBalance = await confidentialUsdc.confidentialBalanceOf(
      await pool.getAddress(),
    );
    expect(await fhevm.debugger.decryptEuint(FhevmType.euint64, encryptedPoolBalance)).to.equal(
      principal,
    );
  });

  it("restores a full Morpho position by shares and routes surplus as prizes", async function () {
    const { keeper, usdc, confidentialUsdc, pool, morpho, adapter, marketParams } =
      await deployFixture();

    await usdc.transfer(await adapter.getAddress(), USDC(1_000));
    await pool.supplyFinalizedMorphoPrincipal(USDC(1_000));

    await usdc.connect(keeper).approve(await morpho.getAddress(), USDC(50));
    await morpho.connect(keeper).accrueYield(marketParams, USDC(25));

    await pool.restoreMorphoPrincipal(USDC(1_000));

    expect(await adapter.suppliedPrincipal()).to.equal(0n);
    expect(await adapter.suppliedAssets()).to.equal(0n);
    expect(await pool.publicPrizeReserve()).to.equal(USDC(25) - 1n);

    const encryptedReserve = await pool.encryptedPrizeReserve();
    const encryptedPoolBalance = await confidentialUsdc.confidentialBalanceOf(
      await pool.getAddress(),
    );
    expect(await fhevm.debugger.decryptEuint(FhevmType.euint64, encryptedReserve)).to.equal(
      USDC(25) - 1n,
    );
    expect(await fhevm.debugger.decryptEuint(FhevmType.euint64, encryptedPoolBalance)).to.equal(
      USDC(1_025) - 1n,
    );
  });

  it("contains every reachable callback action during principal restoration", async function () {
    const f = await prepareCallbackMatrix();
    const before = {
      ownerPrincipal: await f.pool.encryptedPrincipalOf(f.owner.address),
      total: await f.pool.encryptedTotalPrincipal(),
      batchId: await f.pool.currentWithdrawalBatchId(),
      pendingDepositCount: await f.pool.morphoPendingDepositCount(),
    };
    await ethers.provider.send("evm_increaseTime", [Number(DRAW_INTERVAL)]);
    await ethers.provider.send("evm_mine", []);
    await f.pool.restoreMorphoPrincipal(USDC(25));
    await assertCallbackRejections(f);
    await assertCallbackWithdrawalAndOuterAccounting(f, before);
  });

  it("does not expose a standalone Morpho yield harvest", async function () {
    const { pool } = await deployFixture();

    expect(pool.interface.getFunction("harvestMorphoYield")).to.equal(null);
  });

  for (const firstDrawIsLazy of [true, false]) {
    it(`accrues lazy interest at each draw close with ${firstDrawIsLazy ? "zero" : "recorded"} initial surplus`, async function () {
      const f = await prepareYieldingDraw(firstDrawIsLazy);
      const firstDrawWinnings = await assertFirstDrawHarvest(f);
      await assertSecondDrawHarvest(f, firstDrawWinnings);
    });
  }

  for (const principal of [0n, USDC(1_000)]) {
    it(`refreshes Morpho accounting on a zero-yield close with ${principal} principal without withdrawing`, async function () {
      const { usdc, pool, morpho, adapter } = await deployFixture();
      const adapterAddress = await adapter.getAddress();
      const marketId = await adapter.marketId();
      if (principal > 0n) {
        await usdc.transfer(adapterAddress, principal);
        await pool.supplyFinalizedMorphoPrincipal(principal);
      }
      const shares = (await morpho.position(marketId, adapterAddress)).supplyShares;

      await ethers.provider.send("evm_increaseTime", [Number(DRAW_INTERVAL)]);
      const close = await pool.closeDraw();
      const receipt = await close.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);

      expect((await morpho.market(marketId)).lastUpdate).to.equal(BigInt(block!.timestamp));
      expect(await pool.drawId()).to.equal(1n);
      expect(await adapter.suppliedPrincipal()).to.equal(principal);
      expect(await adapter.suppliedAssets()).to.equal(principal);
      expect((await morpho.position(marketId, adapterAddress)).supplyShares).to.equal(shares);
      expect(await adapter.accruedYieldAssets()).to.equal(0n);
      expect(await pool.publicPrizeReserve()).to.equal(0n);
      await expect(close).not.to.emit(pool, "MorphoYieldHarvested");
      await expect(close).not.to.emit(adapter, "YieldHarvested");
      await expect(close).not.to.emit(usdc, "Transfer");
    });
  }

  it("protects principal and owner controls", async function () {
    const { keeper, usdc, pool, adapter } = await deployFixture();

    await usdc.transfer(await adapter.getAddress(), USDC(100));
    await pool.supplyFinalizedMorphoPrincipal(USDC(100));

    await expect(
      pool.connect(keeper).supplyFinalizedMorphoPrincipal(USDC(1)),
    ).to.be.revertedWithCustomError(pool, "OnlyOwner");
    await expect(adapter.supplyPoolPrincipal.staticCall(USDC(1))).to.be.revertedWithCustomError(
      adapter,
      "OnlyPrizePool",
    );
    await expect(pool.restoreMorphoPrincipal(USDC(101))).to.be.revertedWithCustomError(
      adapter,
      "PrincipalWithdrawalExceedsSupply",
    );
    await expect(adapter.harvestYieldToPrizePool.staticCall(0)).to.be.revertedWithCustomError(
      adapter,
      "OnlyPrizePool",
    );
  });
});
