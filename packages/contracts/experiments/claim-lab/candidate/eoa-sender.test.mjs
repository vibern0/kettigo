import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { readFileSync } from "node:fs";
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
const CANARY = getAddress("0xAdB8F835E565aC7e71d2DF6cFBd0FC003fa22C27");
const LEGACY_POOLS = [
  getAddress("0xe65D6459a7Ce01315FbB0998C37233c6FeE3aB8b"),
  getAddress("0x9c23E5f7143612dc1232FC643A57300291e0d719"),
];

class FakeProvider {
  constructor() {
    this.latest = 0;
    this.pending = 0;
    this.sent = [];
    this.transactions = new Map();
    this.receipts = new Map();
    this.block = { hash: "0x" + "ab".repeat(32) };
    this.throwSend = null;
    this.throwLookup = null;
    this.chainId = 11155111n;
  }
  async getNetwork() {
    return { chainId: this.chainId };
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
    if (this.throwLookup) throw this.throwLookup;
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
    this.transactions.set(tx.hash, transactionRecord(tx, this.block));
    this.receipts.set(tx.hash, {
      hash: tx.hash,
      status,
      gasUsed,
      gasPrice: tx.gasPrice,
      from: tx.from,
      to: tx.to,
      nonce: tx.nonce,
      blockHash: this.block.hash,
      blockNumber: 1,
    });
    this.latest = tx.nonce + 1;
    this.pending = this.latest;
  }
}
function transactionRecord(tx, block = null) {
  return {
    hash: tx.hash,
    chainId: tx.chainId,
    from: tx.from,
    to: tx.to,
    data: tx.data,
    nonce: tx.nonce,
    blockHash: block?.hash ?? null,
    blockNumber: block ? 1 : null,
  };
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
  provider.mine(provider.sent[0]);
  await s.reconcile("eoa-1");
  const creation = request({ intentId: "create", nonce: 1, to: null, data: "0x6000" });
  await assert.rejects(s.submit(creation), /creation input/);
  const creationSender = sender(j, provider, { creationInputDigests: [keccak256("0x6000")] });
  provider.latest = provider.pending = 1;
  await creationSender.submit(creation);
  assert.equal(provider.sent.length, 2);
  await j.close();
});

test("1 unresolved actor work blocks a fresh sender, while 6 conflicting in-flight input rejects", async () => {
  const provider = new FakeProvider();
  const j = await journal();
  const first = sender(j, provider);
  await first.submit(request());
  await assert.rejects(
    sender(j, provider).submit(request({ intentId: "next", nonce: 1 })),
    /unresolved/,
  );
  const duplicate = first.submit(request({ intentId: "same", nonce: 1 }));
  await assert.rejects(
    first.submit(request({ intentId: "same", nonce: 1, data: "0xabcd" })),
    /different/,
  );
  await assert.rejects(duplicate, /unresolved/);
  await j.close();
  const fresh = await journal();
  let releaseAddress;
  const delayed = sender(fresh, new FakeProvider(), {
    signer: {
      getAddress: () =>
        new Promise((resolve) => {
          releaseAddress = resolve;
        }),
      signTransaction: wallet.signTransaction.bind(wallet),
    },
  });
  const pending = delayed.submit(request());
  await assert.rejects(delayed.submit(request({ usdcCommitment: "1" })), /different/);
  releaseAddress(wallet.address);
  await pending;
  await fresh.close();
});

test("3 lower or unknown resume nonce aborts, while 9 exact known pending does not rebroadcast", async () => {
  const provider = new FakeProvider();
  const j = await journal();
  await sender(j, provider).submit(request());
  const raw = provider.sent[0];
  const hash = Transaction.from(raw).hash;
  const resumed = sender(j, provider);
  await resumed.submit(request());
  assert.equal(provider.sent.length, 1);
  provider.transactions.delete(hash);
  provider.latest = provider.pending = -1;
  await assert.rejects(resumed.submit(request()), /nonce consumption/);
  await j.close();
});

test("4 lookup errors persist first evidence; 7 forged fees and blocks cannot terminalize; 8 wrong network rejects", async () => {
  const provider = new FakeProvider();
  const j = await journal();
  provider.throwLookup = new Error("lookup lost");
  await sender(j, provider).submit(request());
  assert.equal(j.intent("eoa-1").firstError, "lookup lost");
  provider.throwLookup = null;
  provider.mine(j.intent("eoa-1").signed.raw);
  provider.receipts.get(j.intent("eoa-1").signed.hash).gasPrice = 0n;
  await assert.rejects(sender(j, provider).reconcile("eoa-1"), /receipt transaction mismatch/);
  assert.equal(j.intent("eoa-1").terminal, null);
  provider.chainId = 1n;
  await assert.rejects(sender(j, provider).reconcile("eoa-1"), /Sepolia/);
  await j.close();
});

test("2 signer lookup and 10 post-attempt deadline changes result in zero signatures or sends", async () => {
  let now = 1000;
  const provider = new FakeProvider();
  const j = await journal(() => now);
  let signs = 0;
  const delayedSigner = {
    async getAddress() {
      return wallet.getAddress();
    },
    async signTransaction(tx) {
      signs += 1;
      return wallet.signTransaction(tx);
    },
  };
  const reserve = j.reserve.bind(j);
  j.reserve = async (intent) => {
    const result = await reserve(intent);
    now += ORIGINAL_ENVELOPE.durationMs;
    return result;
  };
  await assert.rejects(
    sender(j, provider, { signer: delayedSigner }).submit(request()),
    /deadline/,
  );
  assert.equal(signs, 0);
  await j.close();
  now = 1000;
  const j2 = await journal(() => now);
  await j2.reserve({
    intentId: "attempt-only",
    sender: SENDER,
    nonce: 0,
    unsignedDigest: "0x" + "01".repeat(32),
    to: TARGET,
    input: "0x1234",
    offeredAt: 1000,
    maxFeeWei: 1n,
    maxGasPriceWei: 1n,
    fundingWei: 0n,
    usdcCommitment: "0",
  });
  await j2.saveSigned("attempt-only", "0x0001", "0x" + "02".repeat(32));
  j2.now = () => {
    const persisted = JSON.parse(readFileSync(join(j2.directory, "journal.json"), "utf8"));
    return persisted.intents[0].attempts.length ? 1000 + ORIGINAL_ENVELOPE.durationMs : 1000;
  };
  await assert.rejects(
    j2.attemptWithPermit("attempt-only", () => provider.sendRawTransaction("0x0001")),
    /deadline/,
  );
  assert.equal(provider.sent.length, 0);
  await j2.close();
});

test("positive value cannot bypass the funding cap and USDC commitment is explicit", async () => {
  const provider = new FakeProvider();
  const j = await journal();
  const s = sender(j, provider);
  await assert.rejects(
    s.submit(request({ value: ORIGINAL_ENVELOPE.maxFundingWei, fundingWei: 0n })),
    /funding must equal/,
  );
  await assert.rejects(s.submit({ ...request(), usdcCommitment: undefined }), /explicit USDC/);
  for (const target of [...LEGACY_POOLS, CANARY])
    await assert.rejects(
      sender(j, provider, { targets: [TARGET, target] }).submit(request({ to: target })),
      /forbidden/,
    );
  await j.close();
});
