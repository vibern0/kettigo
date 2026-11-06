import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CandidateRunJournal, ORIGINAL_ENVELOPE } from "./journal.mjs";
import { FiniteWorkloadDriver, sanitizeWorkloadDriverReport } from "./workload-driver.mjs";
import { compileCandidateWorkload } from "./eoa-workload-definition.mjs";
import {
  workloadDefinitionFixture,
  workloadManifestFixture,
} from "./eoa-workload-test-fixture.mjs";

const directory = () => mkdtemp(join(tmpdir(), "kettigo-workload-driver-"));
const workload = () =>
  compileCandidateWorkload(workloadDefinitionFixture(), workloadManifestFixture());
const success = (actionId) => ({
  kind: "canonical-success",
  actionId,
  evidence: { transactionHash: `0x${"ab".repeat(32)}` },
});
async function prepare(journal, omit = new Set()) {
  const compiled = workload();
  await journal.bindWorkloadDefinition(compiled);
  const conditional = compiled.actions.find(
    (action) => action.kind === "eoa" && action.refs.condition,
  );
  const last = compiled.actions.find(
    (action) => action.kind === "eoa" && action.dependencies.includes(conditional.id),
  );
  for (const action of compiled.actions)
    if (action.id !== conditional.id && action.id !== last.id && !omit.has(action.id))
      await journal.recordActionResult(action.id, success(action.id));
  return { conditional, last };
}

// The production change this catches is scheduling a child before its saved
// dependency result, or losing a terminal result after restart.
test("reconciles a saved terminal intent and persists a conditional skip before later work", async () => {
  const journal = await CandidateRunJournal.open({
    directory: await directory(),
    envelope: ORIGINAL_ENVELOPE,
    now: () => 1000,
  });
  const compiled = workload();
  const first = compiled.actions.find(
    (action) => action.kind === "eoa" && !action.dependencies.length,
  );
  const { conditional, last } = await prepare(journal, new Set([first.id]));
  await journal.reserve({
    intentId: first.id,
    sender: "0x0000000000000000000000000000000000000001",
    nonce: 0,
    unsignedDigest: `0x${"11".repeat(32)}`,
    to: "0x0000000000000000000000000000000000000032",
    input: "0x12",
    offeredAt: 1000,
    maxFeeWei: 10n,
    maxGasPriceWei: 1n,
    fundingWei: 0n,
    usdcCommitment: "0",
  });
  await journal.saveSigned(first.id, "0x12", `0x${"22".repeat(32)}`);
  await journal.recordAttempt(first.id);
  await journal.recordTerminal(first.id, {
    hash: `0x${"22".repeat(32)}`,
    status: 1,
    feeWei: 1n,
    from: "0x0000000000000000000000000000000000000001",
    to: "0x0000000000000000000000000000000000000032",
    input: "0x12",
    nonce: 0,
    chainId: 11155111,
  });
  const calls = [];
  const driver = new FiniteWorkloadDriver({
    journal,
    reconcileIntent: async (intent) => {
      calls.push(`reconcile:${intent.intentId}`);
      return { actionId: first.id, result: success(first.id) };
    },
    resolveConditional: async (action) => {
      calls.push(`condition:${action.id}`);
      return {
        kind: "conditional-SKIPPED",
        actionId: action.id,
        evidence: { reason: "zero-credit" },
      };
    },
    executeAction: async (action) => {
      calls.push(`execute:${action.id}`);
      return {
        kind: "canonical-success",
        actionId: action.id,
        evidence: { transactionHash: "0xdef" },
      };
    },
  });
  const report = await driver.run();
  assert.deepEqual(calls, [
    `reconcile:${first.id}`,
    `condition:${conditional.id}`,
    `execute:${last.id}`,
  ]);
  assert.equal(report.completed, 3);
  assert.equal(journal.actionResult(conditional.id).kind, "conditional-SKIPPED");
  assert.equal(journal.actionResult(last.id).kind, "canonical-success");
  await journal.close();
});

test("keeps unresolved saved intents in metrics and does not execute dependent work", async () => {
  const journal = await CandidateRunJournal.open({
    directory: await directory(),
    envelope: ORIGINAL_ENVELOPE,
    now: () => 1000,
  });
  await prepare(journal);
  const driver = new FiniteWorkloadDriver({
    journal,
    reconcileIntent: async () => ({ state: "unresolved" }),
    resolveConditional: async () => assert.fail("condition must not run"),
    executeAction: async () => assert.fail("execution must not run"),
  });
  const report = await driver.run();
  assert.equal(report.completed, 0);
  assert.equal(report.backlog, 2);
  assert.equal(report.unresolved, 0);
  await journal.close();
});

// The production change this catches is resubmitting a locally pending action
// after another ready action advances the scheduler.
test("does not submit the same unresolved action twice in one run", async () => {
  const results = new Map();
  const journal = {
    workloadDefinition: () => ({
      actions: [
        { id: "pending", kind: "eoa", dependencies: [] },
        { id: "complete", kind: "eoa", dependencies: [] },
      ],
    }),
    actionResult: (id) => results.get(id),
    recordActionResult: async (id, result) => results.set(id, result),
    snapshot: () => ({ intents: [] }),
    journalBytes: () => 128,
  };
  let pendingCalls = 0;
  const report = await new FiniteWorkloadDriver({
    journal,
    reconcileIntent: async () => assert.fail("no intent recovery expected"),
    resolveConditional: async () => assert.fail("no condition expected"),
    executeAction: async (action) => {
      if (action.id === "pending") {
        pendingCalls += 1;
        return null;
      }
      return success(action.id);
    },
  }).run();
  assert.equal(pendingCalls, 1);
  assert.equal(report.submitted, 1);
  assert.equal(report.backlog, 1);
});

// The production change this catches is exposing signed payloads or RPC URLs in
// an operator-facing report.
test("sanitizes driver reports before they reach a CLI or CI log", () => {
  const report = sanitizeWorkloadDriverReport({
    completed: 2,
    journalBytes: 42,
    lastError: `broadcast https://rpc.example/${"0x" + "ab".repeat(32)}`,
    signedRaw: `0x${"cd".repeat(64)}`,
  });
  assert.deepEqual(report, {
    completed: 2,
    submitted: 0,
    unresolved: 0,
    failed: 0,
    blocked: 0,
    backlog: 0,
    journalBytes: 42,
    lastError: "broadcast [redacted-url]/[redacted-hex]",
  });
});
