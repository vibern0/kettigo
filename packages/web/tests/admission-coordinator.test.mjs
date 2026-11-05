import assert from "node:assert/strict";
import test from "node:test";

import {
  AdmissionReconciliationError,
  AdmissionStaleError,
  createAdmissionCoordinator,
  readWithConfirmedVisibility,
} from "../src/lib/admission-coordinator.ts";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const POOL = "0x2222222222222222222222222222222222222222";
const MARKER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_MARKER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PROOF = "0x1234";

function pending({ nonce = 7n, marker = MARKER, requested = true } = {}) {
  return { balance: MARKER, nonce, marker, requested };
}

function fixture({
  snapshots = [pending(), pending(), pending({ requested: false })],
  positive = true,
  send,
  membershipIndex = 1n,
} = {}) {
  let reads = 0;
  let prepareCalls = 0;
  const prepared = {
    cancel() {},
    send: send ?? (async () => "0xdead"),
  };
  const session = {
    address: ACCOUNT,
    prepareTransaction: async (calls) => {
      prepareCalls += 1;
      assert.deepEqual(calls, [{ to: POOL, data: "0xabcdef" }]);
      return prepared;
    },
  };
  const coordinator = createAdmissionCoordinator({
    account: ACCOUNT,
    pool: POOL,
    decryptPublicBoolean: async () => ({ clearValue: positive, decryptionProof: PROOF }),
    readPendingAdmission: async () => snapshots[reads++] ?? snapshots.at(-1),
    readMembershipIndex: async () => membershipIndex,
    encodeFinalizeAdmission: ({ nonce, positive: value, proof }) => {
      assert.equal(nonce, 7n);
      assert.equal(value, positive);
      assert.equal(proof, PROOF);
      return "0xabcdef";
    },
    session,
  });
  return { coordinator, session, prepared, getPrepareCalls: () => prepareCalls };
}

test("rejects a string false instead of treating it as an admission result", async () => {
  const { session } = fixture();
  const malformed = createAdmissionCoordinator({
    account: ACCOUNT,
    pool: POOL,
    decryptPublicBoolean: async () => ({ clearValue: "false", decryptionProof: PROOF }),
    readPendingAdmission: async () => pending(),
    readMembershipIndex: async () => 0n,
    encodeFinalizeAdmission: () => "0x",
    session,
  });
  await assert.rejects(malformed.review(), /boolean/i);
});

test("stops when the admission nonce changes before the finalization is prepared", async () => {
  const { coordinator, getPrepareCalls } = fixture({
    snapshots: [pending(), pending({ nonce: 8n })],
  });
  const review = await coordinator.review();

  await assert.rejects(coordinator.prepare(review), AdmissionStaleError);
  assert.equal(getPrepareCalls(), 0);
});

test("stops when the admission marker changes before the finalization is prepared", async () => {
  const { coordinator, getPrepareCalls } = fixture({
    snapshots: [pending(), pending({ marker: OTHER_MARKER })],
  });
  const review = await coordinator.review();

  await assert.rejects(coordinator.prepare(review), AdmissionStaleError);
  assert.equal(getPrepareCalls(), 0);
});

test("a false signed marker completes without reporting an active membership", async () => {
  const { coordinator } = fixture({ positive: false });
  const ready = await coordinator.prepare(await coordinator.review());

  const result = await ready.confirm();
  assert.deepEqual(result, {
    state: "not-admitted",
    membershipIndex: 1n,
    pending: pending({ requested: false }),
  });
});

test("does not reconcile a failed prepared submission as an admission", async () => {
  const failure = new Error("receipt failed");
  const { coordinator } = fixture({
    send: async () => {
      throw failure;
    },
  });
  const ready = await coordinator.prepare(await coordinator.review());

  await assert.rejects(ready.confirm(), failure);
});

test("does not report a positive marker as admitted when membership reconciliation is missing", async () => {
  const { coordinator } = fixture({ membershipIndex: 0n });
  const ready = await coordinator.prepare(await coordinator.review());

  await assert.rejects(ready.confirm(), AdmissionReconciliationError);
});

test("starts the prepared send exactly once in the confirm call stack", async () => {
  let sends = 0;
  const { coordinator } = fixture({
    send: () => {
      sends += 1;
      return Promise.resolve("0xdead");
    },
  });
  const ready = await coordinator.prepare(await coordinator.review());
  const result = ready.confirm();

  assert.equal(sends, 1);
  await result;
  assert.equal(sends, 1);
});

test("does not retry a terminal permission denial", async () => {
  const denial = { code: "NOT_ENTITLED" };
  let reads = 0;
  await assert.rejects(
    readWithConfirmedVisibility({
      read: async () => {
        reads += 1;
        throw denial;
      },
      observeConfirmedVisibility: async () => true,
    }),
    (error) => error === denial,
  );
  assert.equal(reads, 1);
});

test("retries one typed rate-limit read only after confirmed visibility", async () => {
  let reads = 0;
  let observations = 0;
  const rateLimit = { code: "RPC_RATE_LIMITED" };
  const result = await readWithConfirmedVisibility({
    read: async () => (++reads === 1 ? Promise.reject(rateLimit) : "visible"),
    observeConfirmedVisibility: async () => {
      observations += 1;
      return true;
    },
    isRateLimitError: (error) => error === rateLimit,
  });

  assert.equal(result, "visible");
  assert.equal(reads, 2);
  assert.equal(observations, 1);
});

test("preserves the first rate-limit error when confirmed visibility is unavailable or aborted", async () => {
  const rateLimit = { code: "RPC_RATE_LIMITED" };
  let reads = 0;
  await assert.rejects(
    readWithConfirmedVisibility({
      read: async () => {
        reads += 1;
        throw rateLimit;
      },
      observeConfirmedVisibility: async () => false,
      isRateLimitError: (error) => error === rateLimit,
    }),
    (error) => error === rateLimit,
  );
  assert.equal(reads, 1);

  const controller = new AbortController();
  controller.abort(new Error("account switched"));
  await assert.rejects(
    readWithConfirmedVisibility({
      read: async () => {
        throw rateLimit;
      },
      observeConfirmedVisibility: async () => true,
      isRateLimitError: (error) => error === rateLimit,
      signal: controller.signal,
    }),
    /account switched/,
  );
});
