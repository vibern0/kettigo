import assert from "node:assert/strict";
import test from "node:test";

import { createSafePolicyCapability } from "./safe-approved-policy.mjs";
import {
  ENTRY_POINT,
  ORIGINAL_ENVELOPE,
  SAFE,
  SIGNATURE,
  adapter,
  createJournal,
  operation,
} from "./safe-budget-adapter-test-fixture.mjs";

const ACTOR_A = "0x3333333333333333333333333333333333333333";
const ACTOR_B = "0x4444444444444444444444444444444444444444";
const TARGET = "0x2222222222222222222222222222222222222222";
const DIGEST_A = `0x${"aa".repeat(32)}`;
const DIGEST_B = `0x${"bb".repeat(32)}`;
const normalCaps = Object.freeze({
  maxAggregateFeeWei: "100000000000000000",
  maxSafeFeePerGas: "2000000000",
  maxSafeIntents: 16,
});

function policyFor(journal, caps = normalCaps) {
  const state = journal.snapshot();
  return createSafePolicyCapability({
    approval: {
      reference: "synthetic-active-policy-limits",
      expiresAt: 10_000_000,
      caps,
      binding: { runId: state.runId, baseEnvelopeIdentity: state.envelopeIdentity },
    },
    journal: state,
    expected: { chainId: 11155111, safe: SAFE, entryPoint: ENTRY_POINT },
    now: () => 1000,
  });
}

function eoaRequest({ intentId, sender, nonce, digest, fundingWei = 0n, usdcCommitment = "0" }) {
  return {
    intentId,
    sender,
    nonce,
    unsignedDigest: digest,
    to: TARGET,
    input: "0x12",
    offeredAt: 1000,
    maxFeeWei: 1n,
    maxGasPriceWei: 1n,
    fundingWei,
    usdcCommitment,
  };
}

test("rejects a Safe quote above the active synthetic fee cap before any reservation", async () => {
  const journal = await createJournal();
  const policy = policyFor(journal, { ...normalCaps, maxSafeFeePerGas: "4" });

  await assert.rejects(
    adapter(journal, { policy }).reserve({
      intentId: "safe-fee-cap",
      operation: operation({ maxFeePerGas: 5n }),
      offeredAt: 1000,
    }),
    /Safe policy rejects operation/,
  );
  assert.equal(journal.snapshot().intents.length, 0);
  await journal.close();
});

test("rejects the second distinct Safe intent at the active synthetic count cap", async () => {
  const journal = await createJournal();
  const policy = policyFor(journal, { ...normalCaps, maxSafeIntents: 1 });
  const fence = adapter(journal, { policy });

  await fence.reserve({ intentId: "safe-count-first", operation: operation(), offeredAt: 1000 });
  await assert.rejects(
    fence.reserve({
      intentId: "safe-count-second",
      operation: operation({ nonce: 1n }),
      offeredAt: 1000,
    }),
    /Safe policy intent cap reached/,
  );
  assert.equal(journal.snapshot().intents.length, 1);
  await journal.close();
});

test("rejects a conservative Safe fee reservation above the active aggregate cap", async () => {
  const journal = await createJournal();
  const policy = policyFor(journal, { ...normalCaps, maxAggregateFeeWei: "23" });
  const markers = [];

  await assert.rejects(
    adapter(journal, { policy, marker: (marker) => markers.push(marker) }).reserve({
      intentId: "safe-aggregate-fee",
      operation: operation(),
      offeredAt: 1000,
    }),
    /fee budget exceeded/,
  );
  const state = journal.snapshot();
  assert.equal(state.budget.feeReservedWei, "0");
  assert.equal(state.budget.signedCount, 0);
  assert.equal(markers.includes("signed-persisted"), false);
  assert.equal(markers.includes("actual-send"), false);
  await journal.close();
});

test("rejects a second EOA reservation at a tiny global signature cap with policy bound", async () => {
  assert.equal(ORIGINAL_ENVELOPE.maxSignedTransactions, 600);
  const journal = await createJournal({
    envelope: {
      ...ORIGINAL_ENVELOPE,
      id: "synthetic-global-signature-cap",
      maxSignedTransactions: 1,
    },
  });
  await journal.bindSafePolicy(policyFor(journal));
  await journal.reserve(
    eoaRequest({ intentId: "global-count-first", sender: ACTOR_A, nonce: 0, digest: DIGEST_A }),
  );

  await assert.rejects(
    journal.reserve(
      eoaRequest({ intentId: "global-count-second", sender: ACTOR_B, nonce: 0, digest: DIGEST_B }),
    ),
    /signature budget exceeded/,
  );
  await journal.close();
});

test("rejects EOA funding above the unchanged envelope funding cap with policy bound", async () => {
  const journal = await createJournal({
    envelope: { ...ORIGINAL_ENVELOPE, id: "synthetic-funding-cap", maxFundingWei: "1" },
  });
  await journal.bindSafePolicy(policyFor(journal));
  await journal.reserve(
    eoaRequest({
      intentId: "funding-first",
      sender: ACTOR_A,
      nonce: 0,
      digest: DIGEST_A,
      fundingWei: 1n,
    }),
  );

  await assert.rejects(
    journal.reserve(
      eoaRequest({
        intentId: "funding-second",
        sender: ACTOR_B,
        nonce: 0,
        digest: DIGEST_B,
        fundingWei: 1n,
      }),
    ),
    /funding budget exceeded/,
  );
  await journal.close();
});

test("rejects EOA USDC above the unchanged envelope USDC cap with policy bound", async () => {
  const journal = await createJournal({
    envelope: { ...ORIGINAL_ENVELOPE, id: "synthetic-usdc-cap", maxUsdcMicro: "1" },
  });
  await journal.bindSafePolicy(policyFor(journal));
  await journal.reserve(
    eoaRequest({
      intentId: "usdc-first",
      sender: ACTOR_A,
      nonce: 0,
      digest: DIGEST_A,
      usdcCommitment: "0.000001",
    }),
  );

  await assert.rejects(
    journal.reserve(
      eoaRequest({
        intentId: "usdc-second",
        sender: ACTOR_B,
        nonce: 0,
        digest: DIGEST_B,
        usdcCommitment: "0.000001",
      }),
    ),
    /USDC budget exceeded/,
  );
  await journal.close();
});

test("keeps the first active-policy deadline immutable across reserve, save, and route", async () => {
  let now = 1000;
  const journal = await createJournal({ now: () => now });
  const policy = policyFor(journal);
  const fence = adapter(journal, { policy, now: () => now });
  const reservation = await fence.reserve({
    intentId: "deadline-safe",
    operation: operation(),
    offeredAt: 1000,
  });
  const signed = await fence.saveSigned({
    reservation,
    operation: operation({ signature: SIGNATURE }),
  });
  const deadline = journal.snapshot().deadlineAt;
  assert.equal(deadline, 7_201_000);
  now = deadline;
  let sends = 0;

  await assert.rejects(
    journal.reserve(
      eoaRequest({ intentId: "deadline-reserve", sender: ACTOR_A, nonce: 0, digest: DIGEST_A }),
    ),
    /deadline reached/,
  );
  await assert.rejects(journal.saveSigned("deadline-safe", "0x12", DIGEST_A), /deadline reached/);
  await assert.rejects(
    fence.route({
      reservation: signed,
      wire: operation({ signature: SIGNATURE }),
      entryPoint: ENTRY_POINT,
      send: async () => {
        sends += 1;
      },
    }),
    /deadline reached/,
  );
  assert.equal(sends, 0);
  assert.equal(journal.snapshot().deadlineAt, deadline);
  await journal.close();
});
