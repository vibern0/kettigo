import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";

const USDC = (n: number) => BigInt(n) * 1_000_000n;
const DRAW_INTERVAL = 15n * 60n;
const MORPHO_UNWRAP_INTERVAL = 5n * 60n;
const WITHDRAWAL_BATCH_INTERVAL = 5n * 60n;

describe("Withdrawal batches", function () {
  beforeEach(async function () {
    if (!fhevm.isMock) {
      this.skip();
    }
  });

  async function deployFixture() {
    const [owner, alice, bob] = await ethers.getSigners();

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

    for (const user of [alice, bob]) {
      await usdc.connect(user).faucet(user.address, USDC(10));
      await usdc.connect(user).approve(await confidentialUsdc.getAddress(), USDC(10));
      await confidentialUsdc.connect(user).wrap(user.address, USDC(10));
    }

    return { owner, alice, bob, usdc, confidentialUsdc, pool };
  }

  async function deployMorphoFixture(seedSupplied = true) {
    const fixture = await deployFixture();
    const { owner, bob, usdc, confidentialUsdc, pool } = fixture;

    const MockMorphoBlue = await ethers.getContractFactory("MockMorphoBlue");
    const morpho = await MockMorphoBlue.deploy();
    await morpho.waitForDeployment();

    const marketParams = {
      loanToken: await usdc.getAddress(),
      collateralToken: bob.address,
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

    await pool.setMorphoYieldAdapter(await adapter.getAddress(), MORPHO_UNWRAP_INTERVAL);
    if (seedSupplied) {
      await usdc.connect(owner).faucet(owner.address, USDC(10));
      await usdc.connect(owner).transfer(await adapter.getAddress(), USDC(3));
      await pool.supplyAvailableMorphoPrincipal();
    }

    return { ...fixture, morpho, adapter, marketParams };
  }

  async function encryptedDeposit(
    confidentialUsdc: any,
    poolAddress: string,
    user: any,
    amount: bigint,
  ) {
    const encryptedAmount = await fhevm
      .createEncryptedInput(await confidentialUsdc.getAddress(), user.address)
      .add64(amount)
      .encrypt();

    await confidentialUsdc
      .connect(user)
      ["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](
        poolAddress,
        encryptedAmount.handles[0],
        encryptedAmount.inputProof,
        "0x",
      );
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

  async function decryptMorphoBatch(confidentialUsdc: any, pool: any, adapter: any) {
    const tx = await pool.requestMorphoPrincipalUnwrap();
    const receipt = await tx.wait();
    const unwrapRequestId = receipt!.logs
      .map((log: any) => {
        try {
          return confidentialUsdc.interface.parseLog(log);
        } catch {
          return undefined;
        }
      })
      .find((log: any) => log?.name === "UnwrapRequested")!.args.unwrapRequestId;
    const decrypted = await fhevm.publicDecrypt([unwrapRequestId]);
    await confidentialUsdc.finalizeUnwrap(
      unwrapRequestId,
      decrypted.clearValues[unwrapRequestId],
      decrypted.decryptionProof,
    );
    await pool.supplyAvailableMorphoPrincipal();
    expect(await adapter.suppliedPrincipal()).to.be.greaterThan(0n);
  }

  async function finalizeMorphoBatchWithoutSupply(confidentialUsdc: any, pool: any) {
    const tx = await pool.requestMorphoPrincipalUnwrap();
    const receipt = await tx.wait();
    const unwrapRequestId = receipt!.logs
      .map((log: any) => {
        try {
          return confidentialUsdc.interface.parseLog(log);
        } catch {
          return undefined;
        }
      })
      .find((log: any) => log?.name === "UnwrapRequested")!.args.unwrapRequestId;
    const decrypted = await fhevm.publicDecrypt([unwrapRequestId]);
    await confidentialUsdc.finalizeUnwrap(
      unwrapRequestId,
      decrypted.clearValues[unwrapRequestId],
      decrypted.decryptionProof,
    );
  }

  async function closeAndSettleBatch(pool: any, batchId: bigint) {
    await ethers.provider.send("evm_increaseTime", [Number(WITHDRAWAL_BATCH_INTERVAL)]);
    await ethers.provider.send("evm_mine", []);
    await pool.closeWithdrawalBatch(batchId);
    const total = await pool.encryptedWithdrawalBatchTotal(batchId);
    const restore = await pool.encryptedWithdrawalBatchMorphoRestore(batchId);
    const decrypted = await fhevm.publicDecrypt([total, restore]);
    await pool.settleWithdrawalBatch(
      batchId,
      decrypted.clearValues[total],
      decrypted.clearValues[restore],
      decrypted.decryptionProof,
    );
    return { total, restore, decrypted };
  }

  it("never consumes principal through a legacy immediate withdrawal", async function () {
    const { alice, confidentialUsdc, pool, adapter } = await deployMorphoFixture();
    const poolAddress = await pool.getAddress();

    await encryptedDeposit(confidentialUsdc, poolAddress, alice, USDC(3));
    await ethers.provider.send("evm_increaseTime", [Number(MORPHO_UNWRAP_INTERVAL)]);
    await ethers.provider.send("evm_mine", []);
    await decryptMorphoBatch(confidentialUsdc, pool, adapter);

    const request = await fhevm
      .createEncryptedInput(poolAddress, alice.address)
      .add64(USDC(3))
      .encrypt();
    const principalBefore = await pool.encryptedPrincipalOf(alice.address);
    const suppliedBefore = await adapter.suppliedPrincipal();

    await expect(
      pool.connect(alice).withdrawToUsdc(request.handles[0], request.inputProof, alice.address),
    ).to.be.revertedWithCustomError(pool, "QueuedWithdrawalsOnly");

    const principalAfter = await pool.encryptedPrincipalOf(alice.address);
    expect(
      await fhevm.userDecryptEuint(FhevmType.euint64, principalAfter, poolAddress, alice),
    ).to.equal(
      await fhevm.userDecryptEuint(FhevmType.euint64, principalBefore, poolAddress, alice),
    );
    expect(await adapter.suppliedPrincipal()).to.equal(suppliedBefore);
  });

  it("queues encrypted withdrawal claims and removes them from active principal", async function () {
    const { alice, bob, confidentialUsdc, pool } = await deployMorphoFixture();
    const poolAddress = await pool.getAddress();

    await encryptedDeposit(confidentialUsdc, poolAddress, alice, USDC(3));
    await encryptedDeposit(confidentialUsdc, poolAddress, bob, USDC(2));

    await requestWithdrawal(pool, poolAddress, alice, USDC(1));
    await requestWithdrawal(pool, poolAddress, bob, USDC(9));

    const batchId = await pool.currentWithdrawalBatchId();
    expect(batchId).to.equal(1n);
    expect(await pool.withdrawalBatchRequestCount(batchId)).to.equal(2n);

    const alicePrincipal = await pool.encryptedPrincipalOf(alice.address);
    const bobPrincipal = await pool.encryptedPrincipalOf(bob.address);
    const totalPrincipal = await pool.encryptedTotalPrincipal();
    const batchTotal = await pool.encryptedWithdrawalBatchTotal(batchId);

    expect(
      await fhevm.userDecryptEuint(FhevmType.euint64, alicePrincipal, poolAddress, alice),
    ).to.equal(USDC(2));
    expect(
      await fhevm.userDecryptEuint(FhevmType.euint64, bobPrincipal, poolAddress, bob),
    ).to.equal(0n);
    expect(await fhevm.debugger.decryptEuint(FhevmType.euint64, totalPrincipal)).to.equal(USDC(2));
    expect(await fhevm.debugger.decryptEuint(FhevmType.euint64, batchTotal)).to.equal(USDC(3));
  });

  it("blocks claims until a queued batch is funded, then pays each encrypted claim once", async function () {
    const { alice, confidentialUsdc, pool } = await deployMorphoFixture();
    const poolAddress = await pool.getAddress();

    await encryptedDeposit(confidentialUsdc, poolAddress, alice, USDC(3));
    await requestWithdrawal(pool, poolAddress, alice, USDC(1));

    const batchId = await pool.currentWithdrawalBatchId();
    await expect(
      pool.connect(alice).claimWithdrawalToUsdc(batchId, alice.address),
    ).to.be.revertedWithCustomError(pool, "WithdrawalBatchNotFunded");

    await closeAndSettleBatch(pool, batchId);
    await pool.connect(alice).claimWithdrawalToUsdc(batchId, alice.address);

    const aliceClaim = await pool.encryptedWithdrawalClaimOf(batchId, alice.address);

    expect(await fhevm.debugger.decryptEuint(FhevmType.euint64, aliceClaim)).to.equal(0n);
    await expect(
      pool.connect(alice).claimWithdrawalToUsdc(batchId, alice.address),
    ).to.be.revertedWithCustomError(pool, "NoWithdrawalClaim");
  });

  it("restores queued withdrawal liquidity from Morpho before claims", async function () {
    const { alice, usdc, confidentialUsdc, pool, adapter } = await deployMorphoFixture();
    const poolAddress = await pool.getAddress();

    await encryptedDeposit(confidentialUsdc, poolAddress, alice, USDC(3));
    await ethers.provider.send("evm_increaseTime", [Number(MORPHO_UNWRAP_INTERVAL)]);
    await ethers.provider.send("evm_mine", []);
    await decryptMorphoBatch(confidentialUsdc, pool, adapter);

    await requestWithdrawal(pool, poolAddress, alice, USDC(2));

    const batchId = await pool.currentWithdrawalBatchId();
    await closeAndSettleBatch(pool, batchId);

    expect(await pool.withdrawalBatchStatus(batchId)).to.equal(2n);
    expect(await pool.withdrawalBatchRestoredAmount(batchId)).to.equal(USDC(2));
    expect(await adapter.suppliedPrincipal()).to.equal(USDC(4));

    const claimTx = await pool.processWithdrawal(batchId, alice.address);
    const receipt = await claimTx.wait();
    const unwrapRequestId = receipt!.logs
      .map((log: any) => {
        try {
          return confidentialUsdc.interface.parseLog(log);
        } catch {
          return undefined;
        }
      })
      .find((log: any) => log?.name === "UnwrapRequested")!.args.unwrapRequestId;
    const unwrapped = await fhevm.publicDecrypt([unwrapRequestId]);
    await confidentialUsdc.finalizeUnwrap(
      unwrapRequestId,
      unwrapped.clearValues[unwrapRequestId],
      unwrapped.decryptionProof,
    );

    expect(await usdc.balanceOf(alice.address)).to.equal(USDC(2));
    expect(await pool.hasWithdrawalClaim(batchId, alice.address)).to.equal(false);
  });

  it("settles an idle finalized adapter balance without first supplying Morpho", async function () {
    const { alice, usdc, confidentialUsdc, pool, adapter } = await deployMorphoFixture(false);
    const poolAddress = await pool.getAddress();
    await encryptedDeposit(confidentialUsdc, poolAddress, alice, USDC(3));
    await ethers.provider.send("evm_increaseTime", [Number(MORPHO_UNWRAP_INTERVAL)]);
    await ethers.provider.send("evm_mine", []);
    await finalizeMorphoBatchWithoutSupply(confidentialUsdc, pool);
    expect(await adapter.availablePrincipalAssets()).to.equal(USDC(3));
    expect(await adapter.suppliedPrincipal()).to.equal(0n);

    await requestWithdrawal(pool, poolAddress, alice, USDC(2));
    const batchId = await pool.currentWithdrawalBatchId();
    await closeAndSettleBatch(pool, batchId);
    expect(await adapter.suppliedPrincipal()).to.equal(0n);
    await pool.processWithdrawal(batchId, alice.address);
    const requestId = await pool.withdrawalUnwrapRequest(batchId, alice.address);
    const decrypted = await fhevm.publicDecrypt([requestId]);
    await confidentialUsdc.finalizeUnwrap(
      requestId,
      decrypted.clearValues[requestId],
      decrypted.decryptionProof,
    );
    expect(await usdc.balanceOf(alice.address)).to.equal(USDC(2));
  });

  it("uses idle adapter principal before restoring only a mixed residual from Morpho", async function () {
    const { owner, alice, confidentialUsdc, pool, adapter } = await deployMorphoFixture(false);
    const poolAddress = await pool.getAddress();
    await encryptedDeposit(confidentialUsdc, poolAddress, alice, USDC(3));
    await ethers.provider.send("evm_increaseTime", [Number(MORPHO_UNWRAP_INTERVAL)]);
    await ethers.provider.send("evm_mine", []);
    await finalizeMorphoBatchWithoutSupply(confidentialUsdc, pool);
    await pool.connect(owner).supplyFinalizedMorphoPrincipal(USDC(2));
    expect(await adapter.availablePrincipalAssets()).to.equal(USDC(1));
    await requestWithdrawal(pool, poolAddress, alice, USDC(2));
    const batchId = await pool.currentWithdrawalBatchId();
    await closeAndSettleBatch(pool, batchId);
    expect(await adapter.suppliedPrincipal()).to.equal(USDC(1));
  });

  it("uses manual restored liquidity for a later queued withdrawal without another adapter pull", async function () {
    const { owner, alice, confidentialUsdc, pool, adapter } = await deployMorphoFixture(false);
    const poolAddress = await pool.getAddress();
    await encryptedDeposit(confidentialUsdc, poolAddress, alice, USDC(3));
    await ethers.provider.send("evm_increaseTime", [Number(MORPHO_UNWRAP_INTERVAL)]);
    await ethers.provider.send("evm_mine", []);
    await finalizeMorphoBatchWithoutSupply(confidentialUsdc, pool);
    await pool.connect(owner).supplyFinalizedMorphoPrincipal(USDC(3));
    await pool.connect(owner).restoreMorphoPrincipal(USDC(2));
    await requestWithdrawal(pool, poolAddress, alice, USDC(2));
    const batchId = await pool.currentWithdrawalBatchId();
    const { restore } = await closeAndSettleBatch(pool, batchId);
    expect(await fhevm.debugger.decryptEuint(FhevmType.euint64, restore)).to.equal(0n);
    expect(await adapter.suppliedPrincipal()).to.equal(USDC(1));
  });

  it("rejects manual Morpho restoration while a withdrawal batch is unfunded", async function () {
    const { owner, alice, confidentialUsdc, pool } = await deployMorphoFixture();
    const poolAddress = await pool.getAddress();
    await encryptedDeposit(confidentialUsdc, poolAddress, alice, USDC(3));
    await requestWithdrawal(pool, poolAddress, alice, USDC(1));
    await expect(pool.connect(owner).restoreMorphoPrincipal(USDC(1))).to.be.reverted;
    const batchId = await pool.currentWithdrawalBatchId();
    await ethers.provider.send("evm_increaseTime", [Number(WITHDRAWAL_BATCH_INTERVAL)]);
    await ethers.provider.send("evm_mine", []);
    await pool.closeWithdrawalBatch(batchId);
    await expect(pool.connect(owner).restoreMorphoPrincipal(USDC(1))).to.be.reverted;
    const total = await pool.encryptedWithdrawalBatchTotal(batchId);
    const restore = await pool.encryptedWithdrawalBatchMorphoRestore(batchId);
    const decrypted = await fhevm.publicDecrypt([total, restore]);
    await pool.settleWithdrawalBatch(
      batchId,
      decrypted.clearValues[total],
      decrypted.clearValues[restore],
      decrypted.decryptionProof,
    );
    await expect(pool.connect(owner).restoreMorphoPrincipal(USDC(1))).to.not.be.reverted;
  });

  it("closes only expired batches and rejects mismatched settlement values", async function () {
    const { alice, confidentialUsdc, pool } = await deployMorphoFixture();
    const poolAddress = await pool.getAddress();
    await encryptedDeposit(confidentialUsdc, poolAddress, alice, USDC(3));
    await requestWithdrawal(pool, poolAddress, alice, USDC(2));

    await expect(pool.closeWithdrawalBatch(1n)).to.be.revertedWithCustomError(
      pool,
      "WithdrawalBatchNotReady",
    );
    await ethers.provider.send("evm_increaseTime", [Number(WITHDRAWAL_BATCH_INTERVAL)]);
    await ethers.provider.send("evm_mine", []);
    await pool.closeWithdrawalBatch(1n);

    const total = await pool.encryptedWithdrawalBatchTotal(1n);
    const restore = await pool.encryptedWithdrawalBatchMorphoRestore(1n);
    const decrypted = await fhevm.publicDecrypt([total, restore]);
    expect(decrypted.clearValues[total]).to.equal(USDC(2));

    await expect(
      pool.settleWithdrawalBatch(
        1n,
        USDC(1),
        decrypted.clearValues[restore],
        decrypted.decryptionProof,
      ),
    ).to.be.reverted;
    expect(await pool.withdrawalBatchStatus(1n)).to.equal(1n);
  });

  it("delivers USDC without another user transaction and cannot redirect or replay a payout", async function () {
    const { alice, bob, usdc, confidentialUsdc, pool } = await deployMorphoFixture();
    const poolAddress = await pool.getAddress();
    await encryptedDeposit(confidentialUsdc, poolAddress, alice, USDC(3));
    await requestWithdrawal(pool, poolAddress, alice, USDC(1));
    await requestWithdrawal(pool, poolAddress, alice, USDC(1));
    expect(await pool.withdrawalAccounts(1n)).to.deep.equal([alice.address]);
    await expect(
      pool.connect(bob).processWithdrawal(1n, alice.address),
    ).to.be.revertedWithCustomError(pool, "WithdrawalBatchNotFunded");
    await closeAndSettleBatch(pool, 1n);
    await expect(
      pool.connect(bob).claimWithdrawalToUsdc(1n, bob.address),
    ).to.be.revertedWithCustomError(pool, "NoWithdrawalClaim");
    await pool.connect(bob).processWithdrawal(1n, alice.address);
    const requestId = await pool.withdrawalUnwrapRequest(1n, alice.address);
    expect(await confidentialUsdc.unwrapRequester(requestId)).to.equal(alice.address);
    await expect(
      pool.connect(bob).processWithdrawal(1n, alice.address),
    ).to.be.revertedWithCustomError(pool, "NoWithdrawalClaim");
    const decrypted = await fhevm.publicDecrypt([requestId]);
    await confidentialUsdc
      .connect(bob)
      .finalizeUnwrap(requestId, decrypted.clearValues[requestId], decrypted.decryptionProof);
    expect(await usdc.balanceOf(alice.address)).to.equal(USDC(2));
    expect(await usdc.balanceOf(bob.address)).to.equal(0n);
    await expect(
      confidentialUsdc
        .connect(bob)
        .finalizeUnwrap(requestId, decrypted.clearValues[requestId], decrypted.decryptionProof),
    ).to.be.revertedWithCustomError(confidentialUsdc, "InvalidUnwrapRequest");
  });
});
