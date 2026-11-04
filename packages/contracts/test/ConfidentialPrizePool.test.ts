import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { captureMembershipProof, checkCapturedPrize } from "./proofHelper";

const DRAW_INTERVAL = 15n * 60n;
const WITHDRAWAL_BATCH_INTERVAL = 5n * 60n;

describe("ConfidentialPrizePool", function () {
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let admin: HardhatEthersSigner;

  before(async function () {
    const signers = await ethers.getSigners();
    admin = signers[0];
    alice = signers[1];
    bob = signers[2];
  });

  beforeEach(async function () {
    if (!fhevm.isMock) {
      this.skip();
    }
  });

  async function deployFixture() {
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();

    const ConfidentialUSDC = await ethers.getContractFactory("ConfidentialUSDC");
    const confidentialUsdc = await ConfidentialUSDC.deploy(await usdc.getAddress());
    await confidentialUsdc.waitForDeployment();
    const confidentialUsdcAddress = await confidentialUsdc.getAddress();

    const ConfidentialPrizePool = await ethers.getContractFactory("ConfidentialPrizePool");
    const pool = await ConfidentialPrizePool.deploy(
      confidentialUsdcAddress,
      DRAW_INTERVAL,
      WITHDRAWAL_BATCH_INTERVAL,
    );
    await pool.waitForDeployment();
    const poolAddress = await pool.getAddress();

    for (const user of [alice, bob]) {
      await usdc.connect(user).faucet(user.address, 10_000_000n);
      await usdc.connect(user).approve(confidentialUsdcAddress, 10_000_000n);
      await confidentialUsdc.connect(user).wrap(user.address, 10_000_000n);
    }

    await usdc.connect(admin).faucet(admin.address, 10_000_000n);
    await usdc.connect(admin).approve(confidentialUsdcAddress, 10_000_000n);
    await confidentialUsdc.connect(admin).wrap(admin.address, 10_000_000n);

    return { usdc, confidentialUsdc, confidentialUsdcAddress, pool, poolAddress };
  }

  async function encryptedDeposit(
    confidentialUsdc: any,
    confidentialUsdcAddress: string,
    poolAddress: string,
    user: HardhatEthersSigner,
    amount: bigint,
    decryptDelegate?: string,
  ) {
    const encryptedAmount = await fhevm
      .createEncryptedInput(confidentialUsdcAddress, user.address)
      .add64(amount)
      .encrypt();
    const data = decryptDelegate
      ? ethers.AbiCoder.defaultAbiCoder().encode(["address"], [decryptDelegate])
      : "0x";

    const userToken = confidentialUsdc.connect(user);
    await userToken["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](
      poolAddress,
      encryptedAmount.handles[0],
      encryptedAmount.inputProof,
      data,
    );
  }

  async function fundPrize(
    confidentialUsdc: any,
    confidentialUsdcAddress: string,
    pool: any,
    poolAddress: string,
    amount: bigint,
  ) {
    const encryptedAmount = await fhevm
      .createEncryptedInput(confidentialUsdcAddress, admin.address)
      .add64(amount)
      .encrypt();

    const adminToken = confidentialUsdc.connect(admin);
    await adminToken["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](
      poolAddress,
      encryptedAmount.handles[0],
      encryptedAmount.inputProof,
      ethers.concat([
        await pool.PRIZE_FUNDING_DATA(),
        ethers.AbiCoder.defaultAbiCoder().encode(["uint64"], [amount]),
      ]),
    );
  }

  async function encryptedWrapAndDeposit(
    confidentialUsdc: any,
    confidentialUsdcAddress: string,
    poolAddress: string,
    user: HardhatEthersSigner,
    amount: bigint,
  ) {
    const encryptedAmount = await fhevm
      .createEncryptedInput(confidentialUsdcAddress, user.address)
      .add64(amount)
      .encrypt();

    await confidentialUsdc
      .connect(user)
      .multicall([
        confidentialUsdc.interface.encodeFunctionData("wrap", [user.address, amount]),
        confidentialUsdc.interface.encodeFunctionData(
          "confidentialTransferAndCall(address,bytes32,bytes,bytes)",
          [poolAddress, encryptedAmount.handles[0], encryptedAmount.inputProof, "0x"],
        ),
      ]);
  }

  async function encryptedWithdrawInput(
    poolAddress: string,
    user: HardhatEthersSigner,
    amount: bigint,
  ) {
    const encryptedAmount = await fhevm
      .createEncryptedInput(poolAddress, user.address)
      .add64(amount)
      .encrypt();
    return encryptedAmount;
  }

  async function finalizeAdmission(pool: any, account: string) {
    const pending = await pool.pendingAdmissionOf(account);
    const decrypted = await fhevm.publicDecrypt([pending.marker]);
    await pool.finalizeAdmission(account, pending.nonce, true, decrypted.decryptionProof);
  }

  async function decryptPoolWinnings(pool: any, poolAddress: string, user: HardhatEthersSigner) {
    return fhevm.userDecryptEuint(
      FhevmType.euint64,
      await pool.encryptedWinningsOf(user.address),
      poolAddress,
      user,
    );
  }

  it("tracks encrypted principal for multiple depositors", async function () {
    const { confidentialUsdc, confidentialUsdcAddress, pool, poolAddress } = await deployFixture();

    await encryptedDeposit(
      confidentialUsdc,
      confidentialUsdcAddress,
      poolAddress,
      alice,
      3_000_000n,
    );
    await encryptedDeposit(confidentialUsdc, confidentialUsdcAddress, poolAddress, bob, 1_500_000n);

    const encryptedAlicePrincipal = await pool.encryptedPrincipalOf(alice.address);
    const encryptedBobPrincipal = await pool.encryptedPrincipalOf(bob.address);
    const encryptedTotalPrincipal = await pool.encryptedTotalPrincipal();

    expect(
      await fhevm.userDecryptEuint(FhevmType.euint64, encryptedAlicePrincipal, poolAddress, alice),
    ).to.equal(3_000_000n);
    expect(
      await fhevm.userDecryptEuint(FhevmType.euint64, encryptedBobPrincipal, poolAddress, bob),
    ).to.equal(1_500_000n);
    await expect(
      fhevm.userDecryptEuint(FhevmType.euint64, encryptedBobPrincipal, poolAddress, alice),
    ).to.be.rejected;
    expect(await fhevm.debugger.decryptEuint(FhevmType.euint64, encryptedTotalPrincipal)).to.equal(
      4_500_000n,
    );
  });

  it("lets an account delegate principal decryption to its owner signer", async function () {
    const { confidentialUsdc, confidentialUsdcAddress, pool, poolAddress } = await deployFixture();

    await encryptedDeposit(
      confidentialUsdc,
      confidentialUsdcAddress,
      poolAddress,
      alice,
      2_000_000n,
      bob.address,
    );

    const encryptedAlicePrincipal = await pool.encryptedPrincipalOf(alice.address);

    expect(await pool.decryptDelegateOf(alice.address)).to.equal(bob.address);
    expect(
      await fhevm.userDecryptEuint(FhevmType.euint64, encryptedAlicePrincipal, poolAddress, alice),
    ).to.equal(2_000_000n);
    expect(
      await fhevm.userDecryptEuint(FhevmType.euint64, encryptedAlicePrincipal, poolAddress, bob),
    ).to.equal(2_000_000n);
    await expect(
      fhevm.userDecryptEuint(FhevmType.euint64, encryptedAlicePrincipal, poolAddress, admin),
    ).to.be.rejected;
  });

  it("lets an account set a decrypt delegate after depositing", async function () {
    const { confidentialUsdc, confidentialUsdcAddress, pool, poolAddress } = await deployFixture();

    await encryptedDeposit(
      confidentialUsdc,
      confidentialUsdcAddress,
      poolAddress,
      alice,
      1_250_000n,
    );

    const encryptedAlicePrincipal = await pool.encryptedPrincipalOf(alice.address);
    await expect(
      fhevm.userDecryptEuint(FhevmType.euint64, encryptedAlicePrincipal, poolAddress, bob),
    ).to.be.rejected;

    await pool.connect(alice).setDecryptDelegate(bob.address);

    expect(await pool.decryptDelegateOf(alice.address)).to.equal(bob.address);
    expect(
      await fhevm.userDecryptEuint(FhevmType.euint64, encryptedAlicePrincipal, poolAddress, bob),
    ).to.equal(1_250_000n);
  });

  it("wraps and deposits in one multicall", async function () {
    const { usdc, confidentialUsdc, confidentialUsdcAddress, pool, poolAddress } =
      await deployFixture();

    await usdc.connect(alice).faucet(alice.address, 2_500_000n);
    await usdc.connect(alice).approve(confidentialUsdcAddress, 2_500_000n);
    await encryptedWrapAndDeposit(
      confidentialUsdc,
      confidentialUsdcAddress,
      poolAddress,
      alice,
      2_500_000n,
    );

    const encryptedPrincipal = await pool.encryptedPrincipalOf(alice.address);
    const encryptedAliceBalance = await confidentialUsdc.confidentialBalanceOf(alice.address);
    const encryptedPoolBalance = await confidentialUsdc.confidentialBalanceOf(poolAddress);

    expect(
      await fhevm.userDecryptEuint(FhevmType.euint64, encryptedPrincipal, poolAddress, alice),
    ).to.equal(2_500_000n);
    expect(
      await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encryptedAliceBalance,
        confidentialUsdcAddress,
        alice,
      ),
    ).to.equal(10_000_000n);
    expect(await fhevm.debugger.decryptEuint(FhevmType.euint64, encryptedPoolBalance)).to.equal(
      2_500_000n,
    );
  });

  it("rejects legacy immediate confidential withdrawals", async function () {
    const { confidentialUsdc, confidentialUsdcAddress, pool, poolAddress } = await deployFixture();

    await encryptedDeposit(
      confidentialUsdc,
      confidentialUsdcAddress,
      poolAddress,
      alice,
      3_000_000n,
    );
    const encryptedAmount = await encryptedWithdrawInput(poolAddress, alice, 1_250_000n);

    await expect(
      pool.connect(alice).withdraw(encryptedAmount.handles[0], encryptedAmount.inputProof),
    ).to.be.revertedWithCustomError(pool, "QueuedWithdrawalsOnly");

    const encryptedPrincipal = await pool.encryptedPrincipalOf(alice.address);
    const encryptedAliceBalance = await confidentialUsdc.confidentialBalanceOf(alice.address);
    const encryptedPoolBalance = await confidentialUsdc.confidentialBalanceOf(poolAddress);

    expect(
      await fhevm.userDecryptEuint(FhevmType.euint64, encryptedPrincipal, poolAddress, alice),
    ).to.equal(3_000_000n);
    expect(
      await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encryptedAliceBalance,
        confidentialUsdcAddress,
        alice,
      ),
    ).to.equal(7_000_000n);
    expect(await fhevm.debugger.decryptEuint(FhevmType.euint64, encryptedPoolBalance)).to.equal(
      3_000_000n,
    );
  });

  it("rejects legacy immediate USDC withdrawals", async function () {
    const { confidentialUsdc, confidentialUsdcAddress, pool, poolAddress } = await deployFixture();

    await encryptedDeposit(
      confidentialUsdc,
      confidentialUsdcAddress,
      poolAddress,
      alice,
      2_000_000n,
    );
    const encryptedAmount = await encryptedWithdrawInput(poolAddress, alice, 9_000_000n);

    await expect(
      pool
        .connect(alice)
        .withdrawToUsdc(encryptedAmount.handles[0], encryptedAmount.inputProof, alice.address),
    ).to.be.revertedWithCustomError(pool, "QueuedWithdrawalsOnly");

    const encryptedPrincipal = await pool.encryptedPrincipalOf(alice.address);
    const encryptedAliceBalance = await confidentialUsdc.confidentialBalanceOf(alice.address);
    const encryptedPoolBalance = await confidentialUsdc.confidentialBalanceOf(poolAddress);

    expect(
      await fhevm.userDecryptEuint(FhevmType.euint64, encryptedPrincipal, poolAddress, alice),
    ).to.equal(2_000_000n);
    expect(
      await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encryptedAliceBalance,
        confidentialUsdcAddress,
        alice,
      ),
    ).to.equal(8_000_000n);
    expect(await fhevm.debugger.decryptEuint(FhevmType.euint64, encryptedPoolBalance)).to.equal(
      2_000_000n,
    );
  });

  it("rejects deposits that would push an account above 1,000 USDC", async function () {
    const { usdc, confidentialUsdc, confidentialUsdcAddress, pool, poolAddress } =
      await deployFixture();

    await usdc.connect(alice).faucet(alice.address, 1_100_000_000n);
    await usdc.connect(alice).approve(confidentialUsdcAddress, 1_100_000_000n);
    await confidentialUsdc.connect(alice).wrap(alice.address, 1_100_000_000n);

    await encryptedDeposit(
      confidentialUsdc,
      confidentialUsdcAddress,
      poolAddress,
      alice,
      1_000_000_000n,
    );
    await encryptedDeposit(confidentialUsdc, confidentialUsdcAddress, poolAddress, alice, 1n);

    const encryptedPrincipal = await pool.encryptedPrincipalOf(alice.address);
    const encryptedAliceBalance = await confidentialUsdc.confidentialBalanceOf(alice.address);
    const encryptedPoolBalance = await confidentialUsdc.confidentialBalanceOf(poolAddress);

    expect(
      await fhevm.userDecryptEuint(FhevmType.euint64, encryptedPrincipal, poolAddress, alice),
    ).to.equal(1_000_000_000n);
    expect(
      await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encryptedAliceBalance,
        confidentialUsdcAddress,
        alice,
      ),
    ).to.equal(110_000_000n);
    expect(await fhevm.debugger.decryptEuint(FhevmType.euint64, encryptedPoolBalance)).to.equal(
      1_000_000_000n,
    );
  });

  it("funds a public prize amount backed by a confidential reserve", async function () {
    const { confidentialUsdc, confidentialUsdcAddress, pool, poolAddress } = await deployFixture();

    await fundPrize(confidentialUsdc, confidentialUsdcAddress, pool, poolAddress, 750_000n);

    const encryptedReserve = await pool.encryptedPrizeReserve();
    const encryptedPoolBalance = await confidentialUsdc.confidentialBalanceOf(poolAddress);

    expect(await pool.publicPrizeReserve()).to.equal(750_000n);
    expect(await fhevm.debugger.decryptEuint(FhevmType.euint64, encryptedReserve)).to.equal(
      750_000n,
    );
    expect(await fhevm.debugger.decryptEuint(FhevmType.euint64, encryptedPoolBalance)).to.equal(
      750_000n,
    );
  });

  it("runs a confidential weighted draw and lets the winner claim", async function () {
    const { confidentialUsdc, confidentialUsdcAddress, pool, poolAddress } = await deployFixture();

    await encryptedDeposit(confidentialUsdc, confidentialUsdcAddress, poolAddress, alice, 600_000n);
    await encryptedDeposit(confidentialUsdc, confidentialUsdcAddress, poolAddress, bob, 448_576n);
    await finalizeAdmission(pool, alice.address);
    await finalizeAdmission(pool, bob.address);
    const aliceProof = await captureMembershipProof(pool, alice.address);
    const bobProof = await captureMembershipProof(pool, bob.address);
    await fundPrize(confidentialUsdc, confidentialUsdcAddress, pool, poolAddress, 1_000_000n);

    await time.increase(Number(DRAW_INTERVAL) + 1);
    await pool.connect(admin).closeDraw();
    await checkCapturedPrize(pool, 1n, alice.address, aliceProof);
    await checkCapturedPrize(pool, 1n, bob.address, bobProof);

    const encryptedBobWinnings = await pool.encryptedWinningsOf(bob.address);
    const aliceWinnings = await decryptPoolWinnings(pool, poolAddress, alice);
    const bobWinnings = await decryptPoolWinnings(pool, poolAddress, bob);

    expect(aliceWinnings + bobWinnings).to.equal(1_000_000n);
    await expect(
      fhevm.userDecryptEuint(FhevmType.euint64, encryptedBobWinnings, poolAddress, alice),
    ).to.be.rejected;

    const winner = aliceWinnings > 0n ? alice : bob;
    await pool.connect(winner).claimPrize();

    const encryptedWinnerBalance = await confidentialUsdc.confidentialBalanceOf(winner.address);
    expect(await decryptPoolWinnings(pool, poolAddress, winner)).to.equal(0n);
    expect(
      await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encryptedWinnerBalance,
        confidentialUsdcAddress,
        winner,
      ),
    ).to.be.greaterThan(0n);
  });

  it("lets the winner add a prize directly to savings", async function () {
    const { confidentialUsdc, confidentialUsdcAddress, pool, poolAddress } = await deployFixture();

    await encryptedDeposit(confidentialUsdc, confidentialUsdcAddress, poolAddress, alice, 600_000n);
    await finalizeAdmission(pool, alice.address);
    const aliceProof = await captureMembershipProof(pool, alice.address);
    await fundPrize(confidentialUsdc, confidentialUsdcAddress, pool, poolAddress, 1_000_000n);

    await time.increase(Number(DRAW_INTERVAL) + 1);
    await pool.connect(admin).closeDraw();
    await checkCapturedPrize(pool, 1n, alice.address, aliceProof);

    const encryptedAliceWinnings = await pool.encryptedWinningsOf(alice.address);
    const aliceWinnings = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedAliceWinnings,
      poolAddress,
      alice,
    );
    expect(aliceWinnings).to.equal(1_000_000n);

    await pool.connect(alice).claimPrizeToSavings();

    const encryptedClaimedWinnings = await pool.encryptedWinningsOf(alice.address);
    const encryptedPrincipal = await pool.encryptedPrincipalOf(alice.address);

    expect(
      await fhevm.userDecryptEuint(FhevmType.euint64, encryptedClaimedWinnings, poolAddress, alice),
    ).to.equal(0n);
    expect(
      await fhevm.userDecryptEuint(FhevmType.euint64, encryptedPrincipal, poolAddress, alice),
    ).to.equal(1_600_000n);
  });

  it("exposes the recurring draw schedule and lets anyone close a ready draw", async function () {
    const { pool } = await deployFixture();

    const nextDrawAt = await pool.nextDrawAt();
    expect(await pool.drawInterval()).to.equal(DRAW_INTERVAL);
    await expect(pool.connect(bob).closeDraw()).to.be.revertedWithCustomError(pool, "DrawNotReady");

    await time.increaseTo(nextDrawAt);
    await pool.connect(bob).closeDraw();

    expect(await pool.drawId()).to.equal(1n);
    expect(await pool.nextDrawAt()).to.be.greaterThan(nextDrawAt);
  });
});
