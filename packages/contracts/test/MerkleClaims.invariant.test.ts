import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { captureMembershipProof, checkCapturedPrize } from "./proofHelper";

const DRAW_INTERVAL = 15n * 60n;
const WITHDRAWAL_BATCH_INTERVAL = 5n * 60n;

describe("ConfidentialPrizePool historical-draw invariants", function () {
  beforeEach(async function () {
    if (!fhevm.isMock) this.skip();
  });

  async function fixture(harness = false) {
    const [owner, alice, bob, carol] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const token = await (
      await ethers.getContractFactory("ConfidentialUSDC")
    ).deploy(await usdc.getAddress());
    const pool = await (
      await ethers.getContractFactory(
        harness ? "ConfidentialPrizePoolHarness" : "ConfidentialPrizePool",
      )
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
    const userToken = token.connect(user);
    await userToken["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](
      await pool.getAddress(),
      input.handles[0],
      input.inputProof,
      "0x",
    );
  }

  async function fund(token: any, pool: any, owner: any, amount: bigint) {
    const input = await fhevm
      .createEncryptedInput(await token.getAddress(), owner.address)
      .add64(amount)
      .encrypt();
    const ownerToken = token.connect(owner);
    await ownerToken["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](
      await pool.getAddress(),
      input.handles[0],
      input.inputProof,
      ethers.concat([
        await pool.PRIZE_FUNDING_DATA(),
        ethers.AbiCoder.defaultAbiCoder().encode(["uint64"], [amount]),
      ]),
    );
  }

  async function admit(pool: any, account: string) {
    const pending = await pool.pendingAdmissionOf(account);
    const proof = await fhevm.publicDecrypt([pending.marker]);
    await pool.finalizeAdmission(account, pending.nonce, true, proof.decryptionProof);
  }

  async function close(pool: any) {
    await ethers.provider.send("evm_increaseTime", [Number(DRAW_INTERVAL) + 1]);
    await ethers.provider.send("evm_mine", []);
    await pool.closeDraw();
  }

  async function clear(handle: any) {
    return fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
  }

  it("conserves each funded draw across out-of-order checks, replay attempts, and a later claim", async function () {
    const f = await fixture();
    const weights = new Map([
      [f.alice.address, 2n],
      [f.bob.address, 3n],
      [f.carol.address, 5n],
    ]);
    for (const [account, amount] of weights) {
      const signer = [f.alice, f.bob, f.carol].find((candidate) => candidate.address === account)!;
      await deposit(f.token, f.pool, signer, amount);
      await admit(f.pool, account);
    }
    const proofs = await Promise.all(
      [f.alice, f.bob, f.carol].map((user) => captureMembershipProof(f.pool, user.address)),
    );
    await fund(f.token, f.pool, f.owner, 7n);
    await close(f.pool);
    await fund(f.token, f.pool, f.owner, 11n);
    await close(f.pool);

    // Draw two is settled before draw one; the reference model only uses the checked awards.
    for (const [draw, positions] of [
      [2n, [2, 0, 1]],
      [1n, [1, 2, 0]],
    ] as const) {
      let awards = 0n;
      for (const position of positions) {
        const user = [f.alice, f.bob, f.carol][position];
        await checkCapturedPrize(f.pool, draw, user.address, proofs[position]);
        const award = await clear(await f.pool.encryptedAwardOf(draw, user.address));
        if (user.address === f.bob.address) {
          await expect(
            fhevm.userDecryptEuint(
              FhevmType.euint64,
              await f.pool.encryptedAwardOf(draw, user.address),
              await f.pool.getAddress(),
              f.alice,
            ),
          ).to.be.rejected;
        }
        awards += award;
        await expect(
          checkCapturedPrize(f.pool, draw, user.address, proofs[position]),
        ).to.be.revertedWithCustomError(f.pool, "DrawAlreadyChecked");
      }
      const snapshot = await f.pool.draws(draw);
      expect(awards + (await clear(snapshot.remaining))).to.equal(await clear(snapshot.prize));
    }

    const balances = await Promise.all(
      [f.alice, f.bob, f.carol].map(async (user) =>
        fhevm.userDecryptEuint(
          FhevmType.euint64,
          await f.pool.encryptedWinningsOf(user.address),
          await f.pool.getAddress(),
          user,
        ),
      ),
    );
    const winnerIndex = balances.findIndex((balance) => balance > 0n);
    expect(winnerIndex).to.be.at.least(0);
    await f.pool.connect([f.alice, f.bob, f.carol][winnerIndex]).claimPrize();
    expect(
      await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await f.pool.encryptedWinningsOf([f.alice, f.bob, f.carol][winnerIndex].address),
        await f.pool.getAddress(),
        [f.alice, f.bob, f.carol][winnerIndex],
      ),
    ).to.equal(0n);
  });

  it("keeps an empty draw's encrypted reserve for a future draw while its public mirror reports only new funding", async function () {
    const f = await fixture();
    await deposit(f.token, f.pool, f.alice, 0n);
    const pending = await f.pool.pendingAdmissionOf(f.alice.address);
    const zeroProof = await fhevm.publicDecrypt([pending.marker]);
    await f.pool.finalizeAdmission(
      f.alice.address,
      pending.nonce,
      false,
      zeroProof.decryptionProof,
    );
    expect(await f.pool.activeMemberCount()).to.equal(0n);
    await fund(f.token, f.pool, f.owner, 9n);
    await close(f.pool);
    const first = await f.pool.draws(1n);
    expect(await clear(first.prize)).to.equal(0n);
    expect(await clear(await f.pool.encryptedPrizeReserve())).to.equal(9n);
    expect(await f.pool.publicPrizeReserve()).to.equal(0n);
  });

  it("uses a depth-32 proof at sparse index 2^32-1 without materializing billions of users", async function () {
    const f = await fixture(true);
    await f.pool.seedNextMembershipIndex((1n << 32n) - 1n);
    await deposit(f.token, f.pool, f.alice, 4n);
    await admit(f.pool, f.alice.address);
    const proof = await captureMembershipProof(f.pool, f.alice.address);
    expect(proof.index).to.equal((1n << 32n) - 1n);
    await fund(f.token, f.pool, f.owner, 3n);
    await close(f.pool);
    await checkCapturedPrize(f.pool, 1n, f.alice.address, proof);
    expect(await f.pool.checked(1n, f.alice.address)).to.equal(true);
  });
});
