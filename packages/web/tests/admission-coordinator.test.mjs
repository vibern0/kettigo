import assert from "node:assert/strict";
import test from "node:test";
import { RpcRateLimitError } from "@zama-fhe/sdk";

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

function visibilityScope() {
  return { account: ACCOUNT, pool: POOL, handle: MARKER };
}

function observation(overrides = {}) {
  return { ...visibilityScope(), blockNumber: 123n, visible: true, ...overrides };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

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
  const repeated = ready.confirm();

  assert.equal(sends, 1);
  assert.equal(repeated, result);
  await result;
  assert.equal(sends, 1);
});

test("cancels a prepared transaction that resolves after its review scope aborts", async () => {
  const preparedDeferred = deferred();
  const preparationStarted = deferred();
  let cancelled = 0;
  const { coordinator } = fixture();
  const late = createAdmissionCoordinator({
    account: ACCOUNT,
    pool: POOL,
    decryptPublicBoolean: async () => ({ clearValue: true, decryptionProof: PROOF }),
    readPendingAdmission: async () => pending(),
    readMembershipIndex: async () => 0n,
    encodeFinalizeAdmission: () => "0xabcdef",
    session: {
      address: ACCOUNT,
      prepareTransaction: async () => {
        preparationStarted.resolve();
        return preparedDeferred.promise;
      },
    },
  });
  const controller = new AbortController();
  const preparing = late.prepare(await late.review(), controller.signal);
  await preparationStarted.promise;
  controller.abort(new Error("account switched"));
  preparedDeferred.resolve({
    cancel: () => {
      cancelled += 1;
    },
    send: async () => "0xdead",
  });

  await assert.rejects(preparing, /account switched/);
  assert.equal(cancelled, 1);
  void coordinator;
});

test("does not request credentials from a Ready action after its scope aborts", async () => {
  let sends = 0;
  const { coordinator } = fixture({
    send: () => {
      sends += 1;
      return Promise.resolve("0xdead");
    },
  });
  const controller = new AbortController();
  const ready = await coordinator.prepare(
    await coordinator.review(controller.signal),
    controller.signal,
  );
  controller.abort(new Error("account switched"));

  await assert.rejects(ready.confirm(), /account switched/);
  assert.equal(sends, 0);
});

test("does not reconcile a sent action after its account scope aborts", async () => {
  const sent = deferred();
  let reconciles = 0;
  let pendingReads = 0;
  const coordinator = createAdmissionCoordinator({
    account: ACCOUNT,
    pool: POOL,
    decryptPublicBoolean: async () => ({ clearValue: true, decryptionProof: PROOF }),
    readPendingAdmission: async () => {
      reconciles += 1;
      return pendingReads++ < 2 ? pending() : pending({ requested: false });
    },
    readMembershipIndex: async () => {
      reconciles += 1;
      return 1n;
    },
    encodeFinalizeAdmission: () => "0xabcdef",
    session: {
      address: ACCOUNT,
      prepareTransaction: async () => ({ cancel() {}, send: () => sent.promise }),
    },
  });
  const controller = new AbortController();
  const ready = await coordinator.prepare(
    await coordinator.review(controller.signal),
    controller.signal,
  );
  const confirmed = ready.confirm();
  controller.abort(new Error("account switched"));
  sent.resolve("0xdead");

  await assert.rejects(confirmed, /account switched/);
  assert.equal(reconciles, 2);
});

test("freezes reviewed nonce and marker primitives against later reader mutation", async () => {
  const mutable = pending();
  const { coordinator, getPrepareCalls } = fixture({ snapshots: [mutable, mutable] });
  const review = await coordinator.review();
  mutable.nonce = 8n;
  mutable.marker = OTHER_MARKER;

  await assert.rejects(coordinator.prepare(review), AdmissionStaleError);
  assert.equal(getPrepareCalls(), 0);
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
      scope: visibilityScope(),
      observeConfirmedVisibility: async () => observation(),
      isRateLimitError: () => true,
    }),
    (error) => error === denial,
  );
  assert.equal(reads, 1);
});

test("retries one typed rate-limit read only after confirmed visibility", async () => {
  let reads = 0;
  let observations = 0;
  const rateLimit = new RpcRateLimitError("rate limited");
  const result = await readWithConfirmedVisibility({
    read: async () => (++reads === 1 ? Promise.reject(rateLimit) : "visible"),
    scope: visibilityScope(),
    observeConfirmedVisibility: async () => {
      observations += 1;
      return observation();
    },
  });

  assert.equal(result, "visible");
  assert.equal(reads, 2);
  assert.equal(observations, 1);
});

test("preserves the first rate-limit error when confirmed visibility is unavailable or aborted", async () => {
  const rateLimit = new RpcRateLimitError("rate limited");
  let reads = 0;
  await assert.rejects(
    readWithConfirmedVisibility({
      read: async () => {
        reads += 1;
        throw rateLimit;
      },
      scope: visibilityScope(),
      observeConfirmedVisibility: async () => observation({ visible: false }),
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
      scope: visibilityScope(),
      observeConfirmedVisibility: async () => observation(),
      signal: controller.signal,
    }),
    /account switched/,
  );
});

test("does not let a caller classify a generic HTTP failure as retryable", async () => {
  const http500 = new Error("HTTP 500");
  let reads = 0;
  await assert.rejects(
    readWithConfirmedVisibility({
      read: async () => {
        reads += 1;
        throw http500;
      },
      scope: visibilityScope(),
      observeConfirmedVisibility: async () => observation(),
      isRateLimitError: () => true,
    }),
    (error) => error === http500,
  );
  assert.equal(reads, 1);
});

test("preserves the first rate-limit failure when visibility observation rejects or changes scope", async () => {
  const rateLimit = new RpcRateLimitError("rate limited");
  await assert.rejects(
    readWithConfirmedVisibility({
      read: async () => {
        throw rateLimit;
      },
      scope: visibilityScope(),
      observeConfirmedVisibility: async () => {
        throw new Error("observer offline");
      },
    }),
    (error) => error === rateLimit,
  );
  await assert.rejects(
    readWithConfirmedVisibility({
      read: async () => {
        throw rateLimit;
      },
      scope: visibilityScope(),
      observeConfirmedVisibility: async () => observation({ account: POOL }),
    }),
    (error) => error === rateLimit,
  );
});

test("aborts after either successful visibility read before returning data", async () => {
  const first = new AbortController();
  await assert.rejects(
    readWithConfirmedVisibility({
      read: async () => {
        first.abort(new Error("account switched"));
        return "late";
      },
      scope: visibilityScope(),
      observeConfirmedVisibility: async () => observation(),
      signal: first.signal,
    }),
    /account switched/,
  );
  const second = new AbortController();
  const rateLimit = new RpcRateLimitError("rate limited");
  let reads = 0;
  await assert.rejects(
    readWithConfirmedVisibility({
      read: async () => {
        if (++reads === 1) throw rateLimit;
        second.abort(new Error("account switched"));
        return "late";
      },
      scope: visibilityScope(),
      observeConfirmedVisibility: async () => observation(),
      signal: second.signal,
    }),
    /account switched/,
  );
});
