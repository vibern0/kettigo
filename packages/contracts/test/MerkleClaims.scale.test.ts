import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { captureMembershipProof, checkCapturedPrize } from "./proofHelper";

const DRAW_INTERVAL = 15n * 60n;
const WITHDRAWAL_BATCH_INTERVAL = 5n * 60n;
const SCALE = 4_096;

// Deliberately opt-in: this is a real local FHE/ERC-7984 population run, not a synthetic tree seed.
(process.env.RUN_TASK2_SCALE === "1" ? describe : describe.skip)(
  "ConfidentialPrizePool 4,096-member local scale",
  function () {
    this.timeout(1_800_000);

    beforeEach(async function () {
      if (!fhevm.isMock) this.skip();
    });

    it("funds 33 then 4,096 distinct memberships, keeps close work bounded, and checks index 4095", async function () {
      const [owner] = await ethers.getSigners();
      const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
      const token = await (
        await ethers.getContractFactory("ConfidentialUSDC")
      ).deploy(await usdc.getAddress());
      const pool = await (
        await ethers.getContractFactory("ConfidentialPrizePool")
      ).deploy(await token.getAddress(), DRAW_INTERVAL, WITHDRAWAL_BATCH_INTERVAL);
      const poolAddress = await pool.getAddress();
      const users: any[] = [];

      const enroll = async (index: number) => {
        const address = ethers.getAddress(ethers.toBeHex(0x700000 + index, 20));
        await ethers.provider.send("hardhat_setBalance", [address, "0x56BC75E2D63100000"]);
        const user = await ethers.getImpersonatedSigner(address);
        users.push(user);
        await usdc.faucet(address, 1n);
        await usdc.connect(user).approve(await token.getAddress(), 1n);
        await token.connect(user).wrap(address, 1n);
        const input = await fhevm
          .createEncryptedInput(await token.getAddress(), address)
          .add64(1n)
          .encrypt();
        const userToken = token.connect(user);
        await userToken["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](
          poolAddress,
          input.handles[0],
          input.inputProof,
          "0x",
        );
        const pending = await pool.pendingAdmissionOf(address);
        const admitted = await fhevm.publicDecrypt([pending.marker]);
        await pool.finalizeAdmission(address, pending.nonce, true, admitted.decryptionProof);
      };

      const fund = async (amount: bigint) => {
        const input = await fhevm
          .createEncryptedInput(await token.getAddress(), owner.address)
          .add64(amount)
          .encrypt();
        await usdc.faucet(owner.address, amount);
        await usdc.connect(owner).approve(await token.getAddress(), amount);
        await token.connect(owner).wrap(owner.address, amount);
        const ownerToken = token.connect(owner);
        await ownerToken["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](
          poolAddress,
          input.handles[0],
          input.inputProof,
          ethers.concat([
            await pool.PRIZE_FUNDING_DATA(),
            ethers.AbiCoder.defaultAbiCoder().encode(["uint64"], [amount]),
          ]),
        );
      };
      const close = async () => {
        await ethers.provider.send("evm_increaseTime", [Number(DRAW_INTERVAL) + 1]);
        await ethers.provider.send("evm_mine", []);
        return (await (await pool.closeDraw()).wait())!;
      };

      for (let index = 0; index < 33; ++index) await enroll(index);
      expect(await pool.activeMemberCount()).to.equal(33n);
      await fund(1n);
      const boundaryClose = await close();
      for (let index = 33; index < SCALE; ++index) await enroll(index);
      expect(await pool.activeMemberCount()).to.equal(BigInt(SCALE));
      expect(
        await fhevm.debugger.decryptEuint(FhevmType.euint64, (await pool.membershipNode(32, 0))[1]),
      ).to.equal(BigInt(SCALE));
      const proof4095 = await captureMembershipProof(pool, users[4095].address);
      await fund(1n);
      const scaleClose = await close();
      expect(scaleClose.gasUsed).to.be.lessThan(boundaryClose.gasUsed + 150_000n);

      await checkCapturedPrize(pool, 2n, users[4095].address, proof4095);
      const draw = await pool.draws(2n);
      const award = await fhevm.debugger.decryptEuint(
        FhevmType.euint64,
        await pool.encryptedAwardOf(2n, users[4095].address),
      );
      expect(
        award + (await fhevm.debugger.decryptEuint(FhevmType.euint64, draw.remaining)),
      ).to.equal(await fhevm.debugger.decryptEuint(FhevmType.euint64, draw.prize));
    });
  },
);
