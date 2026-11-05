import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CandidateRunJournal, ORIGINAL_ENVELOPE } from "./journal.mjs";

const SENDER = "0x1111111111111111111111111111111111111111";
const TARGET = "0x2222222222222222222222222222222222222222";
const digest = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const raw = (n) => `0x${n.toString(16).padStart(4, "0")}`;
async function directory() {
  return mkdtemp(join(tmpdir(), "kettigo-journal-"));
}
function request(n = 1) {
  return {
    intentId: `intent-${n}`,
    sender: SENDER,
    nonce: n,
    unsignedDigest: digest(n),
    to: TARGET,
    input: "0x1234",
    offeredAt: 1000,
    maxFeeWei: 100n,
    maxGasPriceWei: 100_000n,
    fundingWei: 10n,
    usdcCommitment: "1.25",
  };
}
async function open(dir, options = {}) {
  return CandidateRunJournal.open({
    directory: dir,
    envelope: ORIGINAL_ENVELOPE,
    now: () => 1000,
    ...options,
  });
}

test("persists reservation and signed bytes across a real restart with restrictive permissions", async () => {
  const dir = await directory();
  const journal = await open(dir);
  await journal.reserve(request());
  await journal.saveSigned("intent-1", raw(1), digest(99));
  await journal.close();
  const restarted = await open(dir);
  assert.deepEqual(restarted.intent("intent-1").signed, { raw: raw(1), hash: digest(99) });
  assert.equal(restarted.snapshot().budget.signedCount, 1);
  assert.equal((await stat(join(dir, "journal.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  await restarted.close();
});

test("rejects duplicate intent changes and sender nonce collisions while exact replays retain the saved signature", async () => {
  const journal = await open(await directory());
  await journal.reserve(request());
  await journal.saveSigned("intent-1", raw(1), digest(9));
  await assert.rejects(journal.reserve({ ...request(), unsignedDigest: digest(2) }));
  await assert.rejects(journal.reserve({ ...request(2), nonce: 1 }));
  assert.equal((await journal.reserve(request())).replay, true);
  assert.equal(journal.intent("intent-1").signed.raw, raw(1));
  await journal.close();
});

test("preserves first errors, every attempt, and canonical actual fee without releasing funding", async () => {
  const journal = await open(await directory());
  await journal.reserve(request());
  await journal.saveSigned("intent-1", raw(1), digest(9));
  await journal.recordAttempt("intent-1", { at: 1010, error: "temporary rpc error" });
  await journal.recordAttempt("intent-1", {
    at: 1011,
    error: "fatal receipt mismatch",
    unrecoverable: true,
  });
  await journal.recordTerminal("intent-1", {
    hash: digest(9),
    status: 0,
    feeWei: 7n,
    from: SENDER,
    to: TARGET,
    input: "0x1234",
    nonce: 1,
    chainId: 11155111,
  });
  const intent = journal.intent("intent-1");
  assert.equal(intent.firstError, "temporary rpc error");
  assert.equal(intent.firstUnrecoverableError, "fatal receipt mismatch");
  assert.equal(intent.attempts.length, 2);
  assert.equal(journal.snapshot().budget.fundingCommittedWei, "10");
  await journal.close();
});

test("keeps the first reservation clock and blocks signing at the inclusive deadline", async () => {
  let time = 1000;
  const journal = await open(await directory(), { now: () => time });
  await journal.reserve(request());
  time = 1000 + 2 * 60 * 60 * 1000;
  await assert.rejects(journal.saveSigned("intent-1", raw(1), digest(9)), /deadline/);
  await journal.close();
});

test("refuses a reservation whose gas price exceeds the approved cap", async () => {
  const journal = await open(await directory());
  await assert.rejects(journal.reserve({ ...request(), maxGasPriceWei: 100_001n }), /gas price/);
  await journal.close();
});

test("rejects corrupt state, foreign chains, and mismatched envelope identities", async () => {
  const dir = await directory();
  await assert.rejects(
    CandidateRunJournal.open({ directory: dir, envelope: { ...ORIGINAL_ENVELOPE, chainId: 1 } }),
  );
  const journal = await open(dir);
  await journal.close();
  await assert.rejects(
    CandidateRunJournal.open({
      directory: dir,
      envelope: { ...ORIGINAL_ENVELOPE, id: "another-approved-envelope" },
    }),
  );
});

test("prevents concurrent reservation overspend and refuses an active or foreign lease", async () => {
  const dir = await directory();
  const journal = await open(dir);
  const expensive = { ...request(), maxFeeWei: 3_000_000_000_000_000n };
  await journal.reserve(expensive);
  await assert.rejects(journal.reserve({ ...request(2), maxFeeWei: 1n }), /fee budget/);
  await assert.rejects(open(dir), /lease/);
  await journal.close();
});

test("fails closed when atomic persistence fails before a signed transition", async () => {
  const journal = await open(await directory());
  journal.failPublish = true;
  await assert.rejects(journal.reserve(request()), /persist/);
  assert.equal(journal.snapshot().intents.length, 0);
  await journal.close();
});

test("validates persisted state rather than silently treating it as a new run", async () => {
  const dir = await directory();
  const journal = await open(dir);
  await journal.close();
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(dir, "journal.json"), "{", { mode: 0o600 });
  await assert.rejects(open(dir), /invalid journal/);
});

test("fails closed for a dead lease and never removes its lock automatically", async () => {
  const dir = await directory();
  const lock = join(dir, "writer.lock");
  await writeFile(lock, JSON.stringify({ pid: 999_999_999, token: "dead-owner" }), { mode: 0o600 });
  await assert.rejects(open(dir, { processAlive: () => false }), /lease/);
  assert.equal((await stat(lock)).isFile(), true);
});

test("serializes concurrent reservations and blocks stale writes after close", async () => {
  const envelope = { ...ORIGINAL_ENVELOPE, maxSignedTransactions: 1 };
  const journal = await CandidateRunJournal.open({
    directory: await directory(),
    envelope,
    now: () => 1000,
  });
  const [first, second] = await Promise.allSettled([
    journal.reserve(request(1)),
    journal.reserve(request(2)),
  ]);
  assert.equal([first, second].filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(journal.snapshot().intents.length, 1);
  await journal.close();
  await assert.rejects(journal.recordTerminal("intent-1", {}), /closed/);
});

test("accepts nonce zero and contract creation while preserving exact creation receipts", async () => {
  const journal = await open(await directory());
  const creation = { ...request(), nonce: 0, offeredAt: 0, to: null, input: "0x6000" };
  await journal.reserve(creation);
  await journal.saveSigned("intent-1", raw(1), digest(9));
  await journal.recordAttempt("intent-1");
  await journal.recordTerminal("intent-1", {
    hash: digest(9),
    status: 1,
    feeWei: 7n,
    from: SENDER,
    to: null,
    input: "0x6000",
    nonce: 0,
    chainId: 11155111,
  });
  await journal.close();
});

test("requires an attempt before terminal and rejects attempts after terminal", async () => {
  const journal = await open(await directory());
  await journal.reserve(request());
  await journal.saveSigned("intent-1", raw(1), digest(9));
  const receipt = {
    hash: digest(9),
    status: 1,
    feeWei: 7n,
    from: SENDER,
    to: TARGET,
    input: "0x1234",
    nonce: 1,
    chainId: 11155111,
  };
  await assert.rejects(journal.recordTerminal("intent-1", receipt), /attempt/);
  await journal.recordAttempt("intent-1");
  await journal.recordTerminal("intent-1", receipt);
  await assert.rejects(journal.recordAttempt("intent-1"), /terminal/);
  await journal.close();
});

test("recomputes persisted totals and frees terminal fee headroom without releasing funding", async () => {
  const envelope = { ...ORIGINAL_ENVELOPE, maxFeeWei: "150" };
  const journal = await CandidateRunJournal.open({
    directory: await directory(),
    envelope,
    now: () => 1000,
  });
  await journal.reserve(request(1));
  await journal.saveSigned("intent-1", raw(1), digest(9));
  await journal.recordAttempt("intent-1");
  await journal.recordTerminal("intent-1", {
    hash: digest(9),
    status: 1,
    feeWei: 10n,
    from: SENDER,
    to: TARGET,
    input: "0x1234",
    nonce: 1,
    chainId: 11155111,
  });
  await journal.reserve({ ...request(2), maxFeeWei: 140n });
  assert.equal(journal.snapshot().budget.fundingCommittedWei, "20");
  await journal.close();
});

test("rejects a tampered restart deadline and recomputed budget", async () => {
  const dir = await directory();
  const journal = await open(dir);
  await journal.reserve(request());
  await journal.close();
  const path = join(dir, "journal.json");
  const state = JSON.parse(await readFile(path, "utf8"));
  state.deadlineAt += 1;
  await writeFile(path, JSON.stringify(state), { mode: 0o600 });
  await assert.rejects(open(dir), /invalid journal/);
  state.deadlineAt -= 1;
  state.budget.feeReservedWei = "0";
  await writeFile(path, JSON.stringify(state), { mode: 0o600 });
  await assert.rejects(open(dir), /invalid persisted budget/);
});

test("poisons future writes when persistence fails after publication", async () => {
  const journal = await open(await directory());
  journal.failPublish = "after-rename";
  await assert.rejects(journal.reserve(request()), /persist failed/);
  await assert.rejects(journal.reserve(request(2)), /uncertain/);
  await journal.close();
});
