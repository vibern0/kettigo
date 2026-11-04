import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";

const DRAW_INTERVAL = 15n * 60n;
const WITHDRAWAL_BATCH_INTERVAL = 5n * 60n;

describe("ConfidentialPrizePool snapshot claims", function () {
  beforeEach(async function () {
    if (!fhevm.isMock) this.skip();
  });

  async function fixture() {
    const [owner, alice, bob, carol] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const token = await (
      await ethers.getContractFactory("ConfidentialUSDC")
    ).deploy(await usdc.getAddress());
    const pool = await (
      await ethers.getContractFactory("ConfidentialPrizePool")
    ).deploy(await token.getAddress(), DRAW_INTERVAL, WITHDRAWAL_BATCH_INTERVAL);
    for (const user of [owner, alice, bob, carol]) {
      await usdc.faucet(user.address, 100n);
      await usdc.connect(user).approve(await token.getAddress(), 100n);
      await token.connect(user).wrap(user.address, 100n);
    }
    return { owner, alice, bob, carol, token, pool };
  }

  async function deposit(token: any, pool: any, user: any, amount: bigint) {
    const input = await fhevm
      .createEncryptedInput(await token.getAddress(), user.address)
      .add64(amount)
      .encrypt();
    await token
      .connect(user)
      ["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](
        await pool.getAddress(),
        input.handles[0],
        input.inputProof,
        "0x",
      );
  }
  async function admit(pool: any, account: string) {
    const pending = await pool.pendingAdmissionOf(account);
    const proof = await fhevm.publicDecrypt([pending.marker]);
    await pool.finalizeAdmission(account, pending.nonce, true, proof.decryptionProof);
  }
  async function fund(token: any, pool: any, owner: any, amount: bigint) {
    const input = await fhevm
      .createEncryptedInput(await token.getAddress(), owner.address)
      .add64(amount)
      .encrypt();
    await token
      .connect(owner)
      ["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](
        await pool.getAddress(),
        input.handles[0],
        input.inputProof,
        ethers.concat([
          await pool.PRIZE_FUNDING_DATA(),
          ethers.AbiCoder.defaultAbiCoder().encode(["uint64"], [amount]),
        ]),
      );
  }
  async function proof(pool: any, account: string) {
    const position = await pool.membershipIndexOf(account);
    const index = position - 1n;
    const generation = await pool.generationOf(index);
    const [_, balance] = await pool.membershipNode(0, index);
    const siblingHashes: string[] = [],
      siblingSums: string[] = [],
      parentSums: string[] = [];
    for (let level = 0n; level < 32n; level++) {
      const [hash, sum] = await pool.membershipNode(level, (index >> level) ^ 1n);
      const [, parentSum] = await pool.membershipNode(level + 1n, index >> (level + 1n));
      siblingHashes.push(hash);
      siblingSums.push(sum);
      parentSums.push(parentSum);
    }
    return { index, generation, balance, siblingHashes, siblingSums, parentSums };
  }
  async function close(pool: any) {
    await ethers.provider.send("evm_increaseTime", [Number(DRAW_INTERVAL) + 1]);
    await ethers.provider.send("evm_mine", []);
    await pool.closeDraw();
  }

  it("closeDoesNotScanPopulation", async function () {
    const f = await fixture();
    for (const user of [f.alice, f.bob, f.carol]) {
      await deposit(f.token, f.pool, user, 1n);
      await admit(f.pool, user.address);
    }
    await fund(f.token, f.pool, f.owner, 7n);
    await close(f.pool);
    expect(await f.pool.checked(1n, f.alice.address)).to.equal(false);
    expect((await f.pool.draws(1n)).upperBound).to.equal(3n);
  });

  it("oldClaimSurvivesExitReuseAndRejoin", async function () {
    const f = await fixture();
    await deposit(f.token, f.pool, f.alice, 3n);
    await admit(f.pool, f.alice.address);
    const p = await proof(f.pool, f.alice.address);
    await fund(f.token, f.pool, f.owner, 5n);
    await close(f.pool);
    await expect(f.pool.connect(f.alice).exitMembership()).to.be.revertedWithCustomError(
      f.pool,
      "MorphoYieldAdapterNotSet",
    );
    await f.pool.checkPrize(
      1n,
      f.alice.address,
      p.index,
      p.generation,
      p.balance,
      p.siblingHashes,
      p.siblingSums,
      p.parentSums,
    );
    expect(await f.pool.checked(1n, f.alice.address)).to.equal(true);
  });

  it("rejectsWrongOwnerGenerationPathAndDraw", async function () {
    const f = await fixture();
    await deposit(f.token, f.pool, f.alice, 3n);
    await admit(f.pool, f.alice.address);
    const p = await proof(f.pool, f.alice.address);
    await fund(f.token, f.pool, f.owner, 5n);
    await close(f.pool);
    await expect(
      f.pool.checkPrize(
        1n,
        f.bob.address,
        p.index,
        p.generation,
        p.balance,
        p.siblingHashes,
        p.siblingSums,
        p.parentSums,
      ),
    ).to.be.reverted;
    await expect(
      f.pool.checkPrize(
        2n,
        f.alice.address,
        p.index,
        p.generation,
        p.balance,
        p.siblingHashes,
        p.siblingSums,
        p.parentSums,
      ),
    ).to.be.reverted;
  });

  it("creditsEachOutcomeOnce", async function () {
    const f = await fixture();
    await deposit(f.token, f.pool, f.alice, 3n);
    await admit(f.pool, f.alice.address);
    const p = await proof(f.pool, f.alice.address);
    await fund(f.token, f.pool, f.owner, 5n);
    await close(f.pool);
    await f.pool.checkPrize(
      1n,
      f.alice.address,
      p.index,
      p.generation,
      p.balance,
      p.siblingHashes,
      p.siblingSums,
      p.parentSums,
    );
    await expect(
      f.pool.checkPrize(
        1n,
        f.alice.address,
        p.index,
        p.generation,
        p.balance,
        p.siblingHashes,
        p.siblingSums,
        p.parentSums,
      ),
    ).to.be.reverted;
    expect(
      await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await f.pool.encryptedWinningsOf(f.alice.address),
        await f.pool.getAddress(),
        f.alice,
      ),
    ).to.equal(5n);
  });

  it("keepsPerDrawOutcomeStableAfterClaim", async function () {
    const f = await fixture();
    await deposit(f.token, f.pool, f.alice, 3n);
    await admit(f.pool, f.alice.address);
    const p = await proof(f.pool, f.alice.address);
    await fund(f.token, f.pool, f.owner, 5n);
    await close(f.pool);
    await f.pool.checkPrize(
      1n,
      f.alice.address,
      p.index,
      p.generation,
      p.balance,
      p.siblingHashes,
      p.siblingSums,
      p.parentSums,
    );
    const award = await f.pool.encryptedAwardOf(1n, f.alice.address);
    expect(
      await fhevm.userDecryptEuint(FhevmType.euint64, award, await f.pool.getAddress(), f.alice),
    ).to.equal(5n);
    await f.pool.connect(f.alice).claimPrize();
    expect(
      await fhevm.userDecryptEuint(FhevmType.euint64, award, await f.pool.getAddress(), f.alice),
    ).to.equal(5n);
  });
});
