import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Transaction, Wallet, getAddress, keccak256 } from "ethers";

import { DurableEoaSender } from "./eoa-sender.mjs";
import { CandidateRunJournal, ORIGINAL_ENVELOPE } from "./journal.mjs";

const wallet = new Wallet("0x8b3a350cf5c34c9194ca3a545d9feea8f6c5ba5b834ee65a5d3c4a8b30e3d2a1");
const SENDER = getAddress(wallet.address);
const TARGET = getAddress("0x2222222222222222222222222222222222222222");
const secondTarget = getAddress("0x3333333333333333333333333333333333333333");
const emptyHash = "0x" + "00".repeat(32);

class FakeProvider {
  constructor() {
    this.latest = 0;
    this.pending = 0;
    this.sent = [];
    this.transactions = new Map();
    this.receipts = new Map();
    this.block = { hash: "0x" + "ab".repeat(32) };
    this.throwSend = null;
  }
  async getNetwork() {
    return { chainId: 11155111n };
  }
  async getTransactionCount(_, tag) {
    return tag === "latest" ? this.latest : this.pending;
  }
  async sendRawTransaction(raw) {
    this.sent.push(raw);
    const tx = Transaction.from(raw);
    this.transactions.set(tx.hash, tx);
    this.pending += 1;
    if (this.throwSend) throw this.throwSend;
    return tx.hash;
  }
  async getTransaction(hash) {
    return this.transactions.get(hash) ?? null;
  }
  async getTransactionReceipt(hash) {
    return this.receipts.get(hash) ?? null;
  }
  async getBlock() {
    return this.block;
  }
  mine(raw, status = 1, gasUsed = 21_000n) {
    const tx = Transaction.from(raw);
    this.transactions.set(tx.hash, tx);
    this.receipts.set(tx.hash, {
      hash: tx.hash,
      status,
      gasUsed,
      gasPrice: tx.gasPrice,
      blockHash: this.block.hash,
      blockNumber: 1,
    });
    this.latest = tx.nonce + 1;
    this.pending = this.latest;
  }
}
async function journal(now = () => 1000) {
  return CandidateRunJournal.open({
    directory: await mkdtemp(join(tmpdir(), "kettigo-eoa-")),
    envelope: ORIGINAL_ENVELOPE,
    now,
  });
}
function request(overrides = {}) {
  return {
    intentId: "eoa-1",
    sender: SENDER,
    nonce: 0,
    to: TARGET,
    data: "0x1234",
    value: 0n,
    gasLimit: 21_000n,
    gasPrice: 100_000n,
    offeredAt: 1000,
    fundingWei: 0n,
    usdcCommitment: "0",
    ...overrides,
  };
}
function sender(journal, provider, options = {}) {
  return new DurableEoaSender({
    journal,
    provider,
    signer: wallet,
    actor: SENDER,
    targets: [TARGET],
    ...options,
  });
}

test("reserves before signing, durably saves exact raw bytes before its first provider call", async () => {
  const log = [];
  const provider = new FakeProvider();
  const j = await journal();
  const signingWallet = {
    getAddress: () => wallet.getAddress(),
    async signTransaction(tx) {
      log.push(j.intent("eoa-1")?.state);
      return wallet.signTransaction(tx);
    },
  };
  const s = new DurableEoaSender({
    journal: j,
    provider,
    signer: signingWallet,
    actor: SENDER,
    targets: [TARGET],
  });
  provider.sendRawTransaction = async (raw) => {
    log.push(j.intent("eoa-1")?.signed?.raw === raw);
    return FakeProvider.prototype.sendRawTransaction.call(provider, raw);
  };
  await s.submit(request());
  assert.deepEqual(log, ["reserved", true]);
  assert.equal(j.intent("eoa-1").attempts.length, 1);
  await j.close();
});

test("rejects altered signer output and persistence failure without broadcasting", async () => {
  const provider = new FakeProvider();
  const j = await journal();
  const liar = {
    getAddress: () => wallet.getAddress(),
    signTransaction: () =>
      wallet.signTransaction({ ...request(), to: secondTarget, type: 0, chainId: 11155111 }),
  };
  await assert.rejects(sender(j, provider, { signer: liar }).submit(request()), /does not match/);
  assert.equal(provider.sent.length, 0);
  const j2 = await journal();
  j2.failPublish = true;
  await assert.rejects(sender(j2, provider).submit(request()), /persist/);
  assert.equal(provider.sent.length, 0);
  await j.close();
  await j2.close();
});

test("canonical success and canonical revert record actual fee, while missing receipts remain unresolved", async () => {
  for (const status of [1, 0]) {
    const provider = new FakeProvider();
    const j = await journal();
    const s = sender(j, provider);
    await s.submit(request({ intentId: `result-${status}`, gasLimit: 30_000n }));
    provider.mine(provider.sent[0], status, 30_000n);
    const outcome = await s.reconcile(`result-${status}`);
    assert.equal(outcome.state, status ? "success" : "reverted");
    assert.equal(j.intent(`result-${status}`).terminal.feeWei, "3000000000");
    await j.close();
  }
});

test("ambiguous send restarts with identical raw bytes and reconciles without another signature", async () => {
  const provider = new FakeProvider();
  const j = await journal();
  let signs = 0;
  const signing = {
    getAddress: () => wallet.getAddress(),
    signTransaction: async (tx) => {
      signs += 1;
      return wallet.signTransaction(tx);
    },
  };
  provider.throwSend = new Error("socket closed after acceptance");
  const s = new DurableEoaSender({
    journal: j,
    provider,
    signer: signing,
    actor: SENDER,
    targets: [TARGET],
  });
  await s.submit(request());
  const raw = j.intent("eoa-1").signed.raw;
  provider.mine(raw);
  provider.throwSend = null;
  const outcome = await new DurableEoaSender({
    journal: j,
    provider,
    signer: signing,
    actor: SENDER,
    targets: [TARGET],
  }).submit(request());
  assert.equal(outcome.state, "success");
  assert.equal(signs, 1);
  assert.equal(provider.sent[0], raw);
  await j.close();
});

test("unknown nonce consumption, stop or deadline before signing, and disallowed targets all prevent signing and sending", async () => {
  const provider = new FakeProvider();
  let signs = 0;
  const signing = {
    getAddress: () => wallet.getAddress(),
    signTransaction: async (tx) => {
      signs += 1;
      return wallet.signTransaction(tx);
    },
  };
  provider.latest = provider.pending = 1;
  let j = await journal();
  await assert.rejects(
    new DurableEoaSender({
      journal: j,
      provider,
      signer: signing,
      actor: SENDER,
      targets: [TARGET],
    }).submit(request()),
    /nonce/,
  );
  assert.equal(signs, 0);
  await j.close();
  let now = 1000;
  provider.latest = provider.pending = 0;
  j = await journal(() => now);
  const s = new DurableEoaSender({
    journal: j,
    provider,
    signer: signing,
    actor: SENDER,
    targets: [TARGET],
  });
  const original = j.assertSigningPermit.bind(j);
  j.assertSigningPermit = async () => {
    now += ORIGINAL_ENVELOPE.durationMs;
    return original();
  };
  await assert.rejects(s.submit(request()), /deadline/);
  assert.equal(signs, 0);
  assert.equal(provider.sent.length, 0);
  await assert.rejects(s.submit(request({ intentId: "wrong", to: secondTarget })), /allowed/);
  await j.close();
});

test("one actor serializes duplicate concurrent intent and validates explicit creation digest", async () => {
  const provider = new FakeProvider();
  const j = await journal();
  const s = sender(j, provider);
  await Promise.all([s.submit(request()), s.submit(request())]);
  assert.equal(provider.sent.length, 1);
  const creation = request({ intentId: "create", nonce: 1, to: null, data: "0x6000" });
  await assert.rejects(s.submit(creation), /creation input/);
  const creationSender = sender(j, provider, { creationInputDigests: [keccak256("0x6000")] });
  provider.latest = provider.pending = 1;
  await creationSender.submit(creation);
  assert.equal(provider.sent.length, 2);
  await j.close();
});
