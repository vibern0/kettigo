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
    return { owner, alice, bob, carol, usdc, token, pool };
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
  async function proofAt(pool: any, beneficiary: string, index: bigint, generation: bigint) {
    const [, balance] = await pool.membershipNode(0, index);
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
    return { beneficiary, index, generation, balance, siblingHashes, siblingSums, parentSums };
  }
  async function close(pool: any) {
    await ethers.provider.send("evm_increaseTime", [Number(DRAW_INTERVAL) + 1]);
    await ethers.provider.send("evm_mine", []);
    await pool.closeDraw();
  }

  async function configureWithdrawalAdapter(f: any) {
    const morpho = await (await ethers.getContractFactory("MockMorphoBlue")).deploy();
    const marketParams = {
      loanToken: await f.usdc.getAddress(),
      collateralToken: f.carol.address,
      oracle: ethers.ZeroAddress,
      irm: ethers.ZeroAddress,
      lltv: 945_000_000_000_000_000n,
    };
    await morpho.createMarket(marketParams);
    const adapter = await (
      await ethers.getContractFactory("MorphoYieldAdapter")
    ).deploy(
      await f.usdc.getAddress(),
      await f.token.getAddress(),
      await f.pool.getAddress(),
      await morpho.getAddress(),
      marketParams,
    );
    await f.pool.setMorphoYieldAdapter(await adapter.getAddress(), 1n);
  }

  async function exitAndReuseHistoricalSlot(f: any, p: any) {
    await configureWithdrawalAdapter(f);
    await f.pool.connect(f.alice).exitMembership();
    expect(await f.pool.membershipIndexOf(f.alice.address)).to.equal(0n);
    await deposit(f.token, f.pool, f.bob, 1n);
    await admit(f.pool, f.bob.address);
    expect(await f.pool.membershipIndexOf(f.bob.address)).to.equal(p.index + 1n);
    expect(await f.pool.generationOf(p.index)).to.equal(p.generation + 1n);
    await deposit(f.token, f.pool, f.alice, 1n);
    await admit(f.pool, f.alice.address);
    expect(await f.pool.membershipIndexOf(f.alice.address)).to.not.equal(p.index + 1n);
  }

  async function assertHistoricalClaimOwnerAndReplayProtection(f: any, p: any) {
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
    ).to.be.revertedWithCustomError(f.pool, "InvalidDrawProof");
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
    expect(
      await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await f.pool.encryptedAwardOf(1n, f.alice.address),
        await f.pool.getAddress(),
        f.alice,
      ),
    ).to.equal(5n);
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
    ).to.be.revertedWithCustomError(f.pool, "DrawAlreadyChecked");
  }

  async function exitBothAndRejoinAlice(f: any) {
    const staleGeneration = await f.pool.generationOf(0n);
    await f.pool.connect(f.alice).exitMembership();
    await f.pool.connect(f.bob).exitMembership();
    await deposit(f.token, f.pool, f.alice, 1n);
    await admit(f.pool, f.alice.address);
    expect(await f.pool.membershipIndexOf(f.alice.address)).to.equal(2n);
    return staleGeneration;
  }

  async function assertStaleProofRejected(f: any, stale: any) {
    await expect(
      f.pool
        .connect(f.carol)
        .checkPrize(
          1n,
          stale.beneficiary,
          stale.index,
          stale.generation,
          stale.balance,
          stale.siblingHashes,
          stale.siblingSums,
          stale.parentSums,
        ),
    ).to.be.revertedWithCustomError(f.pool, "InvalidDrawProof");
  }

  async function checkActivePrizeAndRejectReplay(f: any, active: any) {
    await f.pool.checkPrize(
      1n,
      f.alice.address,
      active.index,
      active.generation,
      active.balance,
      active.siblingHashes,
      active.siblingSums,
      active.parentSums,
    );
    expect(await f.pool.checked(1n, f.alice.address)).to.equal(true);
    await expect(
      f.pool.checkPrize(
        1n,
        f.alice.address,
        active.index,
        active.generation,
        active.balance,
        active.siblingHashes,
        active.siblingSums,
        active.parentSums,
      ),
    ).to.be.revertedWithCustomError(f.pool, "DrawAlreadyChecked");
  }

  it("emits PrizeChecked only for the successful prize check", async function () {
    const f = await fixture();
    await deposit(f.token, f.pool, f.alice, 5n);
    await admit(f.pool, f.alice.address);
    const claim = await proof(f.pool, f.alice.address);
    await fund(f.token, f.pool, f.owner, 5n);
    await close(f.pool);

    await expect(
      f.pool.checkPrize(
        1n,
        f.alice.address,
        claim.index,
        claim.generation,
        claim.balance,
        claim.siblingHashes,
        claim.siblingSums,
        claim.parentSums,
      ),
    )
      .to.emit(f.pool, "PrizeChecked")
      .withArgs(1n, f.alice.address);
    const awardBeforeReplay = await f.pool.encryptedAwardOf(1n, f.alice.address);

    await expect(
      f.pool.checkPrize(
        1n,
        f.alice.address,
        claim.index,
        claim.generation,
        claim.balance,
        claim.siblingHashes,
        claim.siblingSums,
        claim.parentSums,
      ),
    ).to.be.revertedWithCustomError(f.pool, "DrawAlreadyChecked");
    expect(await f.pool.encryptedAwardOf(1n, f.alice.address)).to.equal(awardBeforeReplay);
  });

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
    await exitAndReuseHistoricalSlot(f, p);
    await assertHistoricalClaimOwnerAndReplayProtection(f, p);
  });

  it("rejects a stale zero leaf before it can consume a rejoined account's draw check", async function () {
    const f = await fixture();
    await configureWithdrawalAdapter(f);
    for (const user of [f.alice, f.bob]) {
      await deposit(f.token, f.pool, user, 1n);
      await admit(f.pool, user.address);
    }
    const staleGeneration = await exitBothAndRejoinAlice(f);
    const stale = await proofAt(f.pool, f.alice.address, 0n, staleGeneration);
    const active = await proof(f.pool, f.alice.address);
    await fund(f.token, f.pool, f.owner, 5n);
    await close(f.pool);
    await assertStaleProofRejected(f, stale);
    await checkActivePrizeAndRejectReplay(f, active);
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
