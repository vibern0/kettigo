import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const UINT64_MAX = (1n << 64n) - 1n;
const GLOBAL_HCU_LIMIT = 20_000_000;
const DEPTH_HCU_LIMIT = 5_000_000;
const metrics: Record<string, unknown>[] = [];

async function deploy() {
  const factory = await ethers.getContractFactory("SnapshotTreeProbe");
  const probe: any = await factory.deploy();
  await probe.waitForDeployment();
  return probe;
}

async function clear(handle: string): Promise<bigint> {
  if (handle === ethers.ZeroHash) return 0n;
  return fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
}

async function input(probe: any, actor: any, amount: bigint) {
  return fhevm.createEncryptedInput(ethers.getAddress(await probe.getAddress()), ethers.getAddress(actor.address))
    .add64(amount).encrypt();
}

async function encryptedCall(probe: any, actor: any, method: string, amount: bigint) {
  const encrypted = await input(probe, actor, amount);
  return probe.connect(actor)[method](encrypted.handles[0], encrypted.inputProof);
}

async function measure(label: string, transaction: any, extra: Record<string, unknown> = {}) {
  const receipt = await transaction.wait();
  const hcu = fhevm.computeTransactionHCU(receipt);
  const row = {
    label, ...extra, gas: Number(receipt.gasUsed), globalHCU: hcu.globalHCU,
    maxHCUDepth: hcu.maxHCUDepth, fheEvents: fhevm.parseCoprocessorEvents(receipt.logs).length,
  };
  metrics.push(row);
  expect(hcu.globalHCU, `${label}: total HCU`).to.be.at.most(GLOBAL_HCU_LIMIT);
  expect(hcu.maxHCUDepth, `${label}: sequential HCU`).to.be.at.most(DEPTH_HCU_LIMIT);
  return row;
}

describe("THROWAWAY snapshot-tree feasibility", function () {
  let actors: any[];

  before(async function () {
    expect(fhevm.isMock, "This probe must only run on a local mock network").to.equal(true);
    actors = await ethers.getSigners();
  });

  after(function () {
    fs.writeFileSync(path.join(__dirname, "../results.json"), JSON.stringify({
      environment: "Hardhat local mock; not Sepolia measurements",
      limits: { globalHCU: GLOBAL_HCU_LIMIT, maxHCUDepth: DEPTH_HCU_LIMIT },
      metrics,
    }, null, 2) + "\n");
  });

  it("onboards 65 distinct addresses and grows through the 32/33 and 64/65 boundaries", async function () {
    const probe = await deploy();
    const addresses: string[] = [];
    for (let i = 0; i < 65; i++) {
      const address = ethers.getAddress(ethers.toBeHex(BigInt(10_000 + i), 20));
      addresses.push(address);
      const transaction = await probe.depositForTest(address, i + 1);
      if ([31, 32, 63, 64].includes(i)) {
        await measure("actual-address-registration", transaction, { participants: i + 1 });
      } else await transaction.wait();
    }
    expect(await probe.participantCount()).to.equal(65n);
    expect(await probe.depth()).to.equal(7n);
    expect(await clear(await probe.total())).to.equal(65n * 66n / 2n);
    for (let i = 0; i < addresses.length; i++) {
      expect(await clear(await probe.principalOf(addresses[i]))).to.equal(BigInt(i + 1));
    }
    await probe.withdrawForTest(addresses[0], UINT64_MAX);
    await probe.depositForTest(addresses[0], 9);
    expect(await probe.participantCount()).to.equal(65n);
    expect(await clear(await probe.principalOf(addresses[0]))).to.equal(9n);
  });

  it("accepts actual encrypted inputs and keeps principal, tickets, and tree aggregates access-controlled", async function () {
    const probe = await deploy();
    const [alice, bob] = actors;
    await measure("encrypted-deposit", await encryptedCall(probe, alice, "deposit", 13n));
    await encryptedCall(probe, bob, "deposit", 29n);
    const contract = ethers.getAddress(await probe.getAddress());
    const principal = await probe.principalOf(alice.address);
    expect(await fhevm.userDecryptEuint(FhevmType.euint64, principal, contract, alice)).to.equal(13n);
    await assert.rejects(fhevm.userDecryptEuint(FhevmType.euint64, principal, contract, bob));
    await assert.rejects(fhevm.userDecryptEuint(FhevmType.euint64, await probe.total(), contract, alice));
    await probe.fundForTest(100);
    await probe.closeDraw();
    const round = await probe.draw(1);
    await assert.rejects(fhevm.userDecryptEuint(FhevmType.euint64, round.ticket, contract, alice));
    await probe.connect(alice).settle(1);
    await probe.connect(bob).settle(1);
    const aliceWinnings = await probe.winningsOf(alice.address);
    await fhevm.userDecryptEuint(FhevmType.euint64, aliceWinnings, contract, alice);
    await assert.rejects(fhevm.userDecryptEuint(FhevmType.euint64, aliceWinnings, contract, bob));
    expect(await clear((await probe.draw(1)).remaining)).to.equal(0n);
    await measure("encrypted-withdrawal", await encryptedCall(probe, alice, "withdraw", UINT64_MAX));
    expect(await clear(await probe.principalOf(alice.address))).to.equal(0n);
    expect(await clear(await probe.total())).to.equal(29n);
  });

  it("selects precisely one weighted interval for every ticket, including zero-balance leaves", async function () {
    const probe = await deploy();
    const weights = [0n, 1n, 3n, 0n, 4n];
    for (let i = 0; i < weights.length; i++) await probe.depositForTest(actors[i].address, weights[i]);
    const awarded = Array<bigint>(weights.length).fill(0n);
    for (let ticket = 0; ticket < 8; ticket++) {
      await probe.fundForTest(100);
      await probe.closeWithRandomForTest(BigInt(ticket) << 61n);
      const roundId = ticket + 1;
      expect(await clear((await probe.draw(roundId)).ticket)).to.equal(BigInt(ticket));
      let prefix = 0n;
      let winners = 0;
      for (let i = weights.length - 1; i >= 0; i--) await probe.connect(actors[i]).settle(roundId);
      for (let i = 0; i < weights.length; i++) {
        const wins = BigInt(ticket) >= prefix && BigInt(ticket) < prefix + weights[i];
        if (wins) { awarded[i] += 100n; winners++; }
        expect(await clear(await probe.winningsOf(actors[i].address))).to.equal(awarded[i]);
        prefix += weights[i];
      }
      expect(winners).to.equal(1);
      expect(await clear((await probe.draw(roundId)).remaining)).to.equal(0n);
    }
    expect(awarded).to.deep.equal([0n, 100n, 300n, 0n, 400n]);
  });

  it("documents the inherited multiply-high RNG's finite-resolution bias for non-power-of-two totals", function () {
    const words = 1n << 64n;
    const ceil = (numerator: bigint, denominator: bigint) => (numerator + denominator - 1n) / denominator;
    for (const total of [3n, 7n, 10n, 999n]) {
      let allocated = 0n;
      for (let ticket = 0n; ticket < total; ticket++) {
        const count = ceil((ticket + 1n) * words, total) - ceil(ticket * words, total);
        expect(count).to.be.oneOf([words / total, words / total + 1n]);
        allocated += count;
      }
      expect(allocated).to.equal(words);
    }
    const first = ceil(words, 3n);
    const last = words - ceil(2n * words, 3n);
    expect(first - last).to.equal(1n);
  });

  it("preserves closed snapshots across withdrawal, new membership, deposit, reinvestment, and later draws", async function () {
    const probe = await deploy();
    const [alice, bob, carol] = actors;
    await probe.depositForTest(alice.address, 5);
    await probe.depositForTest(bob.address, 3);
    await probe.fundForTest(12);
    await probe.closeWithRandomForTest(UINT64_MAX);
    const first = await probe.draw(1);
    await probe.withdrawForTest(alice.address, 5);
    await probe.depositForTest(bob.address, 100);
    await probe.depositForTest(carol.address, 50);
    await expect(probe.connect(carol).settle(1)).to.be.revertedWithCustomError(probe, "NotEligible");
    await probe.connect(bob).settle(1);
    expect(await clear(await probe.winningsOf(bob.address))).to.equal(12n);
    await probe.connect(bob).reinvestForTest();
    expect(await clear(await probe.principalOf(bob.address))).to.equal(115n);
    await probe.fundForTest(7);
    await probe.closeWithRandomForTest(0);
    await probe.connect(bob).settle(2);
    await probe.connect(alice).settle(1);
    expect(await clear(await probe.winningsOf(alice.address))).to.equal(0n);
    expect(await clear(await probe.winningsOf(bob.address))).to.equal(7n);
    const unchanged = await probe.draw(1);
    expect(unchanged.root).to.equal(first.root);
    expect(unchanged.count).to.equal(2n);
    expect(unchanged.depth).to.equal(first.depth);
    expect(unchanged.ticket).to.equal(first.ticket);
    expect(await clear(await probe.total())).to.equal(165n);
  });

  it("rejects duplicate checks for both outcomes and keeps multiple draws and claims independent", async function () {
    const probe = await deploy();
    const [alice, bob] = actors;
    await probe.depositForTest(alice.address, 1);
    await probe.depositForTest(bob.address, 1);
    for (let id = 1; id <= 2; id++) {
      await probe.fundForTest(17);
      await probe.closeWithRandomForTest(0);
    }
    await probe.connect(alice).settle(2);
    await probe.connect(alice).claimForTest();
    await probe.connect(alice).claimForTest();
    expect(await clear(await probe.paidOf(alice.address))).to.equal(17n);
    await probe.connect(alice).settle(1);
    await probe.connect(bob).settle(1);
    await expect(probe.connect(alice).settle(1)).to.be.revertedWithCustomError(probe, "AlreadyChecked");
    await expect(probe.connect(bob).settle(1)).to.be.revertedWithCustomError(probe, "AlreadyChecked");
    expect(await clear(await probe.winningsOf(alice.address))).to.equal(17n);
    await expect(probe.connect(alice).settle(0)).to.be.revertedWithCustomError(probe, "NotEligible");
    await expect(probe.connect(alice).settle(3)).to.be.revertedWithCustomError(probe, "NotEligible");
  });

  it("carries the prize through an empty or all-zero draw without awarding zero balances", async function () {
    const probe = await deploy();
    await probe.fundForTest(23);
    await probe.closeDraw();
    expect(await clear(await probe.reserve())).to.equal(23n);
    expect(await clear((await probe.draw(1)).prize)).to.equal(0n);
    await probe.depositForTest(actors[0].address, 0);
    await probe.closeDraw();
    await probe.connect(actors[0]).settle(2);
    expect(await clear(await probe.winningsOf(actors[0].address))).to.equal(0n);
    expect(await clear(await probe.reserve())).to.equal(23n);
    await probe.depositForTest(actors[0].address, 1);
    await probe.closeDraw();
    await probe.connect(actors[0]).settle(3);
    expect(await clear(await probe.winningsOf(actors[0].address))).to.equal(23n);
    expect(await clear(await probe.reserve())).to.equal(0n);
  });

  it("checks user overflow and preserves a prize when reinvestment exceeds the account cap", async function () {
    const probe = await deploy();
    const [alice] = actors;
    await probe.depositForTest(alice.address, 1_000_000_000);
    await probe.depositForTest(alice.address, UINT64_MAX);
    expect(await clear(await probe.principalOf(alice.address))).to.equal(1_000_000_000n);
    await probe.fundForTest(100);
    await probe.closeDraw();
    await probe.connect(alice).settle(1);
    await probe.connect(alice).reinvestForTest();
    expect(await clear(await probe.principalOf(alice.address))).to.equal(1_000_000_000n);
    expect(await clear(await probe.winningsOf(alice.address))).to.equal(100n);
  });

  it("rejects aggregate overflow independently of participant count at the uint64 boundary", async function () {
    const probe = await deploy();
    await probe.seedUniformForTest(35, (1n << 29n) - 1n, actors[0].address, 0);
    const initial = (1n << 64n) - (1n << 35n);
    expect(await clear(await probe.total())).to.equal(initial);
    for (let i = 0; i < 34; i++) {
      await probe.depositForTest(ethers.getAddress(ethers.toBeHex(BigInt(20_000 + i), 20)), 1_000_000_000);
    }
    const last = ethers.getAddress(ethers.toBeHex(30_000n, 20));
    await probe.depositForTest(last, 359_738_367);
    expect(await clear(await probe.total())).to.equal(UINT64_MAX);
    await probe.depositForTest(last, 1);
    expect(await clear(await probe.total())).to.equal(UINT64_MAX);
    expect(await clear(await probe.principalOf(last))).to.equal(359_738_367n);
  });

  it("matches an independent balance/interval model over randomized updates and delayed settlements", async function () {
    const probe = await deploy();
    const users = actors.slice(0, 8);
    const balances = users.map(() => 0n);
    const winnings = users.map(() => 0n);
    let state = 0x12345678;
    const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
    for (const user of users) await probe.depositForTest(user.address, 0);
    for (let epoch = 1; epoch <= 8; epoch++) {
      for (let step = 0; step < 12; step++) {
        const i = random() % users.length;
        const amount = BigInt(random() % 1000);
        if (random() & 1) {
          await probe.depositForTest(users[i].address, amount);
          balances[i] += amount;
        } else {
          await probe.withdrawForTest(users[i].address, amount);
          balances[i] -= amount < balances[i] ? amount : balances[i];
        }
        expect(await clear(await probe.total())).to.equal(balances.reduce((a, b) => a + b, 0n));
      }
      const snapshot = [...balances];
      const total = snapshot.reduce((a, b) => a + b, 0n);
      const word = (BigInt(random()) << 32n) | BigInt(random());
      const ticket = word * total >> 64n;
      await probe.fundForTest(31);
      await probe.closeWithRandomForTest(word);
      // Mutate the live state before anyone settles the closed snapshot.
      await probe.depositForTest(users[0].address, 19);
      balances[0] += 19n;
      let prefix = 0n;
      for (let i = 0; i < users.length; i++) {
        if (ticket >= prefix && ticket < prefix + snapshot[i]) winnings[i] += 31n;
        prefix += snapshot[i];
      }
      for (let i = users.length - 1; i >= 0; i--) {
        await probe.connect(users[i]).settle(epoch);
        expect(await clear(await probe.winningsOf(users[i].address))).to.equal(winnings[i]);
        expect(await clear(await probe.principalOf(users[i].address))).to.equal(balances[i]);
      }
      expect(await clear((await probe.draw(epoch)).remaining)).to.equal(0n);
    }
  });

  it("materializes 1,024 distinct addresses and checks the last address without scanning the others", async function () {
    const probe = await deploy();
    let last = "";
    for (let i = 0; i < 1024; i++) {
      last = ethers.getAddress(ethers.toBeHex(BigInt(40_000 + i), 20));
      const transaction = await probe.depositForTest(last, 100);
      if (i == 1023) await measure("materialized-1024-registration", transaction, { participants: 1024 });
      else await transaction.wait();
    }
    expect(await probe.participantCount()).to.equal(1024n);
    expect(await probe.depth()).to.equal(10n);
    expect(await clear(await probe.total())).to.equal(102_400n);
    await probe.fundForTest(1000);
    await measure("materialized-1024-close-draw", await probe.closeDraw(), { participants: 1024 });
    await ethers.provider.send("hardhat_impersonateAccount", [last]);
    await ethers.provider.send("hardhat_setBalance", [last, "0x56BC75E2D63100000"]);
    const actor = await ethers.getSigner(last);
    await measure("materialized-1024-check-last", await probe.connect(actor).settle(1), { participants: 1024 });
    await probe.fundForTest(77);
    await probe.closeWithRandomForTest(UINT64_MAX);
    await probe.withdrawForTest(last, 100);
    await probe.connect(actor).settle(2);
    // Full withdrawal after cutoff cannot change the already-determined winner.
    expect(await clear(await probe.winningsOf(last))).to.be.at.least(77n);
    expect(await clear((await probe.draw(2)).remaining)).to.equal(0n);
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [last]);
  });

  for (const count of [2, 8, 16, 32]) {
    it(`profiles the existing unmodified scan with ${count} actual registered addresses`, async function () {
      const driver: any = await (await ethers.getContractFactory("LegacyDepositDriver")).deploy();
      await driver.waitForDeployment();
      const legacy: any = await (await ethers.getContractFactory("ConfidentialPrizePool"))
        .deploy(await driver.getAddress(), 0, 60);
      await legacy.waitForDeployment();
      for (let i = 0; i < count; i++) {
        await driver.depositForTest(legacy, ethers.getAddress(ethers.toBeHex(BigInt(60_000 + i), 20)), 100);
      }
      await driver.fundForTest(legacy, 1000);
      // Record failures as evidence: a configured address cap is not proof of
      // transaction executability. Do not turn a limit failure into a passing metric.
      try {
        const transaction = await legacy.closeDraw();
        const receipt = await transaction.wait();
        const hcu = fhevm.computeTransactionHCU(receipt);
        metrics.push({ label: "legacy-close-draw", participants: count, outcome: "executed",
          gas: Number(receipt.gasUsed), globalHCU: hcu.globalHCU, maxHCUDepth: hcu.maxHCUDepth,
          withinDocumentedLimits: hcu.globalHCU <= GLOBAL_HCU_LIMIT && hcu.maxHCUDepth <= DEPTH_HCU_LIMIT,
        });
        expect(await legacy.drawId()).to.equal(1n);
      } catch (error: any) {
        const message = String(error.message);
        expect(message).to.match(/HCUTransaction(Depth)?LimitExceeded/);
        metrics.push({ label: "legacy-close-draw", participants: count, outcome: "HCU limit revert", error: message.split("\n")[0] });
      }
      if (count === 32) {
        await expect(driver.depositForTest(legacy, actors[0].address, 1))
          .to.be.revertedWithCustomError(legacy, "TooManyParticipants");
      }
    });
  }

  for (const level of [5, 10, 14, 20, 24, 32]) {
    it(`profiles exact depth ${level} with a compact fixture for ${2 ** level} logical leaves`, async function () {
      const probe = await deploy();
      const [actor] = actors;
      const count = 1n << BigInt(level);
      const extra = { depth: level, logicalParticipants: count.toString(), fixture: "shared-subtree uniform population" };
      await probe.seedUniformForTest(level, 100, actor.address, count - 1n);
      const nodesBefore = await probe.nodeCount();
      await measure("tree-encrypted-deposit", await encryptedCall(probe, actor, "deposit", 1n), extra);
      expect(await probe.nodeCount() - nodesBefore).to.equal(BigInt(level + 1));
      expect(await clear(await probe.total())).to.equal(count * 100n + 1n);
      await probe.fundForTest(1000);
      await measure("tree-close-draw", await probe.closeDraw(), extra);
      await measure("tree-check-last-index", await probe.connect(actor).settle(1), extra);
      await measure("tree-encrypted-withdrawal", await encryptedCall(probe, actor, "withdraw", 1n), extra);
      expect(await clear(await probe.total())).to.equal(count * 100n);
    });
  }
});
