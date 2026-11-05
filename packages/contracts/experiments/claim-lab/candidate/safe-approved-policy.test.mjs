import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createSafePolicyCapability } from "./safe-approved-policy.mjs";
import { deterministicUserOperationRecord } from "./safe-budget-adapter.mjs";
import {
  ENTRY_POINT,
  SAFE,
  adapter,
  createJournal,
  operation,
  reopenJournal,
  SIGNATURE,
} from "./safe-budget-adapter-test-fixture.mjs";

const caps = Object.freeze({
  maxAggregateFeeWei: "100000000000000000",
  maxSafeFeePerGas: "2000000000",
  maxSafeIntents: 16,
});
function policyFor(journal, overrides = {}) {
  const state = journal.snapshot();
  return createSafePolicyCapability({
    approval: {
      reference: "synthetic-matrix",
      expiresAt: 7_201_000,
      caps: overrides.caps ?? caps,
      binding: { runId: state.runId, baseEnvelopeIdentity: state.envelopeIdentity },
      ...overrides.approval,
    },
    journal: state,
    expected: { chainId: 11155111, safe: SAFE, entryPoint: ENTRY_POINT, ...overrides.expected },
    now: overrides.now ?? (() => 1000),
  });
}

test("creates an immutable synthetic capability bound to this journal and fixed Safe", async () => {
  const journal = await createJournal();
  const state = journal.snapshot();
  const capability = createSafePolicyCapability({
    approval: {
      reference: "synthetic-b3b-approval-1",
      expiresAt: 7_201_000,
      caps,
      binding: { runId: state.runId, baseEnvelopeIdentity: state.envelopeIdentity },
    },
    journal: state,
    expected: { chainId: 11155111, safe: SAFE, entryPoint: ENTRY_POINT },
    now: () => 1000,
  });
  assert.equal(capability.runId, state.runId);
  assert.equal(capability.baseEnvelopeIdentity, state.envelopeIdentity);
  assert.equal(capability.safe, SAFE);
  assert.equal(capability.entryPoint, ENTRY_POINT);
  assert.equal(capability.caps.maxSafeIntents, 16);
  assert.equal(Object.isFrozen(capability), true);
  await journal.close();
});

test("rejects an expired or altered synthetic approval binding", async () => {
  const journal = await createJournal();
  const state = journal.snapshot();
  const expected = { chainId: 11155111, safe: SAFE, entryPoint: ENTRY_POINT };
  const approval = {
    reference: "synthetic-b3b-approval-2",
    expiresAt: 1000,
    caps,
    binding: { runId: state.runId, baseEnvelopeIdentity: state.envelopeIdentity },
  };
  assert.throws(
    () => createSafePolicyCapability({ approval, journal: state, expected, now: () => 1000 }),
    /expired/,
  );
  assert.throws(
    () =>
      createSafePolicyCapability({
        approval: { ...approval, expiresAt: 7_201_000 },
        journal: { ...state, runId: "other-run" },
        expected,
        now: () => 1000,
      }),
    /run/,
  );
  await journal.close();
});

test("persists the exact policy before the first synthetic Safe reservation and restart", async () => {
  const journal = await createJournal();
  const state = journal.snapshot();
  const policy = createSafePolicyCapability({
    approval: {
      reference: "synthetic-b3b-approval-3",
      expiresAt: 7_201_000,
      caps,
      binding: { runId: state.runId, baseEnvelopeIdentity: state.envelopeIdentity },
    },
    journal: state,
    expected: { chainId: 11155111, safe: SAFE, entryPoint: ENTRY_POINT },
    now: () => 1000,
  });
  await adapter(journal, { policy }).reserve({
    intentId: "policy-safe",
    operation: operation(),
    offeredAt: 1000,
  });
  assert.equal(journal.snapshot().safePolicy.policyIdentity, policy.policyIdentity);
  const directory = journal.directory;
  await journal.close();
  const restarted = await reopenJournal(directory, { safePolicy: policy });
  assert.equal(restarted.snapshot().safePolicy.policyIdentity, policy.policyIdentity);
  await restarted.close();
});

test("allows the synthetic fixed Safe high quote but preserves original EOA and actor fences", async () => {
  const journal = await createJournal();
  const policy = policyFor(journal);
  await adapter(journal, { policy }).reserve({
    intentId: "high-safe",
    operation: operation({ callGasLimit: 3_993_284n, maxFeePerGas: 1_210_000_003n }),
    offeredAt: 1000,
  });
  await assert.rejects(
    journal.reserve({
      intentId: "eoa-high",
      sender: "0x3333333333333333333333333333333333333333",
      nonce: 1,
      unsignedDigest: `0x${"01".repeat(32)}`,
      to: "0x2222222222222222222222222222222222222222",
      input: "0x12",
      offeredAt: 1000,
      maxFeeWei: 1n,
      maxGasPriceWei: 1_210_000_003n,
      fundingWei: 0n,
      usdcCommitment: "0",
    }),
    /gas price/,
  );
  await assert.rejects(
    adapter(journal, { policy }).reserve({
      intentId: "wrong-safe",
      operation: operation({ sender: "0x3333333333333333333333333333333333333333" }),
      offeredAt: 1000,
    }),
    /Safe/,
  );
  await journal.close();
});

test("rejects malformed approval bindings and policy substitution across restart", async () => {
  const journal = await createJournal();
  const state = journal.snapshot();
  for (const approval of [
    {
      reference: "",
      expiresAt: 7_201_000,
      caps,
      binding: { runId: state.runId, baseEnvelopeIdentity: state.envelopeIdentity },
    },
    {
      reference: "x",
      expiresAt: 7_201_000,
      caps: { ...caps, extra: 1 },
      binding: { runId: state.runId, baseEnvelopeIdentity: state.envelopeIdentity },
    },
    {
      reference: "x",
      expiresAt: 7_201_000,
      caps,
      binding: { runId: "wrong", baseEnvelopeIdentity: state.envelopeIdentity },
    },
  ])
    assert.throws(() =>
      createSafePolicyCapability({
        approval,
        journal: state,
        expected: { chainId: 11155111, safe: SAFE, entryPoint: ENTRY_POINT },
        now: () => 1000,
      }),
    );
  const policy = policyFor(journal);
  await adapter(journal, { policy }).reserve({
    intentId: "bound",
    operation: operation(),
    offeredAt: 1000,
  });
  const directory = journal.directory;
  await journal.close();
  await assert.rejects(reopenJournal(directory));
  await assert.rejects(
    reopenJournal(directory, { safePolicy: { ...policy, approvalReference: "other" } }),
  );
  await (await reopenJournal(directory, { safePolicy: policy })).close();
});

test("rechecks synthetic policy expiry before signed persistence", async () => {
  let time = 1000;
  const journal = await createJournal({ now: () => time });
  const policy = policyFor(journal, { now: () => time, approval: { expiresAt: 1001 } });
  const fence = adapter(journal, { policy, now: () => time });
  const reservation = await fence.reserve({
    intentId: "expires-save",
    operation: operation(),
    offeredAt: 1000,
  });
  time = 1001;
  await assert.rejects(
    fence.saveSigned({ reservation, operation: operation({ signature: SIGNATURE }) }),
    /policy/,
  );
  await journal.close();
});

test("rejects an on-disk policy removal when the original authority is supplied", async () => {
  const journal = await createJournal();
  const policy = policyFor(journal);
  await adapter(journal, { policy }).reserve({
    intentId: "remove-policy",
    operation: operation(),
    offeredAt: 1000,
  });
  const directory = journal.directory;
  await journal.close();
  const path = join(directory, "journal.json");
  const state = JSON.parse(await readFile(path, "utf8"));
  state.safePolicy = null;
  await writeFile(path, JSON.stringify(state), { mode: 0o600 });
  await assert.rejects(reopenJournal(directory, { safePolicy: policy }), /journal|policy/);
});

test("suppresses an expired policy after durable route attempt and before external send", async () => {
  const journal = await createJournal();
  const policy = policyFor(journal, { approval: { expiresAt: 1001 } });
  const reserveFence = adapter(journal, { policy, now: () => 1000 });
  const reservation = await reserveFence.reserve({
    intentId: "expires-route",
    operation: operation(),
    offeredAt: 1000,
  });
  const persisted = await reserveFence.saveSigned({
    reservation,
    operation: operation({ signature: SIGNATURE }),
  });
  let checks = 0;
  const routeFence = adapter(journal, { policy, now: () => (checks++ === 0 ? 1000 : 1001) });
  let sends = 0;
  await assert.rejects(
    routeFence.route({
      reservation: persisted,
      wire: deterministicUserOperationRecord(operation({ signature: SIGNATURE })),
      entryPoint: ENTRY_POINT,
      send: async () => {
        sends += 1;
      },
    }),
    /policy/,
  );
  assert.equal(sends, 0);
  assert.equal(journal.intent("expires-route").attempts.at(-1).outcome, "suppressed");
  await journal.close();
});
