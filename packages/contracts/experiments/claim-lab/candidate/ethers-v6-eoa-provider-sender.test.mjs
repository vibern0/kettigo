import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Transaction, Wallet, getAddress } from "ethers";

import { DurableEoaSender } from "./eoa-sender.mjs";
import { EthersV6EoaProviderAdapter } from "./ethers-v6-eoa-provider.mjs";
import { CandidateRunJournal, ORIGINAL_ENVELOPE } from "./journal.mjs";

const wallet = new Wallet("0x8b3a350cf5c34c9194ca3a545d9feea8f6c5ba5b834ee65a5d3c4a8b30e3d2a1");
const actor = getAddress(wallet.address);
const target = getAddress("0x2222222222222222222222222222222222222222");
const blockHash = `0x${"ab".repeat(32)}`;
class Provider {
  constructor(status = 1, pending = false) {
    this.status = status;
    this.raw = null;
    this.broadcasts = 0;
    this.pending = pending;
    this.broadcastHash = null;
  }
  async getNetwork() {
    return { chainId: 11155111n };
  }
  async getTransactionCount() {
    return this.raw ? 1 : 0;
  }
  async broadcastTransaction(raw) {
    this.raw = raw;
    this.broadcasts++;
    return this.broadcastHash ?? { hash: Transaction.from(raw).hash };
  }
  async getTransaction(hash) {
    if (!this.raw) return null;
    const tx = Transaction.from(this.raw);
    return {
      hash: tx.hash,
      chainId: 11155111n,
      from: tx.from,
      to: tx.to,
      data: tx.data,
      nonce: tx.nonce,
      blockHash,
      blockNumber: 1,
    };
  }
  async getTransactionReceipt() {
    if (!this.raw || this.pending) return null;
    const tx = Transaction.from(this.raw);
    return {
      hash: tx.hash,
      status: this.status,
      gasUsed: 30_000n,
      gasPrice: tx.gasPrice,
      from: tx.from,
      to: tx.to,
      blockHash,
      blockNumber: 1,
    };
  }
  async getBlock() {
    return { hash: blockHash, number: 1 };
  }
}
async function run(status, pending = false) {
  const journal = await CandidateRunJournal.open({
    directory: await mkdtemp(join(tmpdir(), "kettigo-adapter-")),
    envelope: ORIGINAL_ENVELOPE,
    now: () => 1000,
  });
  const inward = new Provider(status, pending);
  const sender = new DurableEoaSender({
    journal,
    provider: new EthersV6EoaProviderAdapter(inward),
    signer: wallet,
    actor,
    targets: [target],
  });
  const result = await sender.submit({
    intentId: `eoa-${status}`,
    sender: actor,
    nonce: 0,
    to: target,
    data: "0x1234",
    value: 0n,
    gasLimit: 30_000n,
    gasPrice: 100_000n,
    offeredAt: 1000,
    fundingWei: 0n,
    usdcCommitment: "0",
  });
  return { journal, inward, sender, result };
}
test("durably broadcasts through ethers response and records success fee once", async () => {
  const { journal, inward, sender, result } = await run(1);
  assert.equal(result.state, "success");
  assert.equal(inward.broadcasts, 1);
  assert.equal(journal.intent("eoa-1").terminal.feeWei, "3000000000");
  await sender.reconcile("eoa-1");
  assert.equal(journal.snapshot().budget.feeActualWei, "3000000000");
  assert.equal(inward.broadcasts, 1);
  await journal.close();
});
test("pending null evidence stays unresolved without a new broadcast", async () => {
  for (const missing of ["getTransactionReceipt", "getTransaction", "getBlock"]) {
    const { journal, inward, sender } = await run(1, true);
    inward.pending = false;
    inward[missing] = async () => null;
    assert.equal((await sender.reconcile("eoa-1")).state, "unresolved");
    assert.equal(journal.intent("eoa-1").terminal, null);
    assert.equal(inward.broadcasts, 1);
    await journal.close();
  }
});
test("wrong broadcast hashes cannot terminalize the saved intent", async () => {
  for (const hash of [{}, { hash: `0x${"ef".repeat(32)}` }]) {
    const journal = await CandidateRunJournal.open({
      directory: await mkdtemp(join(tmpdir(), "kettigo-adapter-")),
      envelope: ORIGINAL_ENVELOPE,
      now: () => 1000,
    });
    const inward = new Provider(1);
    inward.broadcastHash = hash;
    const sender = new DurableEoaSender({
      journal,
      provider: new EthersV6EoaProviderAdapter(inward),
      signer: wallet,
      actor,
      targets: [target],
    });
    await sender.submit({
      intentId: "bad-hash",
      sender: actor,
      nonce: 0,
      to: target,
      data: "0x1234",
      value: 0n,
      gasLimit: 30_000n,
      gasPrice: 100_000n,
      offeredAt: 1000,
      fundingWei: 0n,
      usdcCommitment: "0",
    });
    assert.equal(journal.intent("bad-hash").terminal, null);
    assert.equal(journal.snapshot().budget.feeActualWei, "0");
    await journal.close();
  }
});
test("records reverted ethers receipt fee once", async () => {
  const { journal, result } = await run(0);
  assert.equal(result.state, "reverted");
  assert.equal(journal.intent("eoa-0").terminal.feeWei, "3000000000");
  await journal.close();
});
test("readonly reconciliation rejects each corrupted canonical tuple without terminalizing", async () => {
  for (const corrupt of [
    (p) =>
      (p.getTransaction = async () => ({
        ...(await Provider.prototype.getTransaction.call(p)),
        nonce: 1,
      })),
    (p) =>
      (p.getTransaction = async () => ({
        ...(await Provider.prototype.getTransaction.call(p)),
        data: "0xabcd",
      })),
    (p) => (p.getBlock = async () => ({ hash: blockHash, number: 2 })),
  ]) {
    const { journal, inward } = await run(1, true);
    corrupt(inward);
    inward.pending = false;
    const sender = new DurableEoaSender({
      journal,
      provider: new EthersV6EoaProviderAdapter(inward),
      signer: wallet,
      actor,
      targets: [target],
    });
    assert.equal((await sender.reconcile("eoa-1")).state, "unresolved");
    assert.equal(journal.intent("eoa-1").terminal, null);
    assert.equal(inward.broadcasts, 1);
    await journal.close();
  }
});
