import assert from "node:assert/strict";
import test from "node:test";

import { getAddress } from "viem";

import {
  PendingOperationBusyError,
  PendingOperationRecoveryBlockedError,
  createPendingOperationManager,
} from "../src/lib/pending-operation-guard.ts";

const ENTRY_POINT = getAddress("0x0000000071727De22E5E9d8BAf0edAc6f37da032");
const SENDER = getAddress("0x00000000000000000000000000000000000000bb");
const OTHER_SENDER = getAddress("0x00000000000000000000000000000000000000cc");
const HASH_A = `0x${"aa".repeat(32)}`;
const HASH_B = `0x${"bb".repeat(32)}`;

class SharedStorage {
  #values = new Map();
  getItem(key) {
    return this.#values.get(key) ?? null;
  }
  setItem(key, value) {
    this.#values.set(key, value);
  }
  removeItem(key) {
    this.#values.delete(key);
  }
  value(key) {
    return this.getItem(key);
  }
}

class SharedLocks {
  #held = new Set();
  async request(name, options, callback) {
    if (options?.ifAvailable && this.#held.has(name)) return callback(null);
    this.#held.add(name);
    try {
      return await callback({ name });
    } finally {
      this.#held.delete(name);
    }
  }
}

function identity(hash = HASH_A, sender = SENDER) {
  return { chainId: 11155111, entryPoint: ENTRY_POINT, sender, userOperationHash: hash };
}
function manager(storage = new SharedStorage(), locks = new SharedLocks(), sender = SENDER) {
  return createPendingOperationManager({
    storage,
    locks,
    sender,
    entryPoint: ENTRY_POINT,
    now: () => 123,
  });
}

test("only one same-origin review lease can stage and release permits a retry", async () => {
  const storage = new SharedStorage();
  const locks = new SharedLocks();
  const first = manager(storage, locks);
  const second = manager(storage, locks);
  const lease = await first.acquireReview();
  await assert.rejects(second.acquireReview(), PendingOperationBusyError);
  lease.stagePrepared(identity());
  await lease.release();
  await assert.rejects(second.acquireReview(), PendingOperationRecoveryBlockedError);
  const recovery = await second.acquireRecovery();
  recovery.clearMatching(identity());
  await recovery.release();
  const retry = await second.acquireReview();
  await retry.release();
});

test("stages a frozen durable public record and preserves its original creation time", async () => {
  const storage = new SharedStorage();
  const subject = manager(storage);
  const lease = await subject.acquireReview();
  const prepared = lease.stagePrepared(identity());
  assert.deepEqual(prepared, { version: 1, ...identity(), createdAt: 123, phase: "prepared" });
  assert.equal(Object.isFrozen(prepared), true);
  assert.equal(lease.stagePrepared(identity()).createdAt, 123);
  const attempted = lease.markAttempted(identity());
  assert.equal(attempted.phase, "attempted");
  assert.equal(subject.readCurrent().phase, "attempted");
  await lease.release();
  assert.equal(manager(storage).readCurrent().phase, "attempted");
});

test("an attempted durable record blocks review while recovery clears only its matching hash", async () => {
  const storage = new SharedStorage();
  const subject = manager(storage);
  const review = await subject.acquireReview();
  review.stagePrepared(identity());
  review.markAttempted(identity());
  await review.release();
  await assert.rejects(
    subject.acquireReview(),
    (error) =>
      error instanceof PendingOperationRecoveryBlockedError &&
      error.record.userOperationHash === HASH_A,
  );
  const recovery = await subject.acquireRecovery();
  assert.equal(recovery.readCurrent().phase, "attempted");
  assert.equal(recovery.clearMatching(identity(HASH_B)), false);
  assert.equal(recovery.clearMatching(identity(HASH_A)), true);
  assert.equal(subject.readCurrent(), null);
  await recovery.release();
});

test("prepared orphan can be cleared by recovery but never by an inactive lease", async () => {
  const storage = new SharedStorage();
  const subject = manager(storage);
  const review = await subject.acquireReview();
  review.stagePrepared(identity());
  await review.release();
  const recovery = await subject.acquireRecovery();
  await recovery.release();
  assert.throws(() => recovery.clearMatching(identity()), PendingOperationRecoveryBlockedError);
  const next = await subject.acquireRecovery();
  assert.equal(next.clearMatching(identity()), true);
  await next.release();
});

test("malformed, cross-scope, and oversized persisted values fail closed without deletion", () => {
  const storage = new SharedStorage();
  const subject = manager(storage);
  const key = subject.storageKey;
  for (const value of [
    "{",
    JSON.stringify({
      version: 1,
      ...identity(HASH_A, OTHER_SENDER),
      createdAt: 1,
      phase: "prepared",
    }),
    "x".repeat(16_385),
  ]) {
    storage.setItem(key, value);
    assert.throws(() => subject.readCurrent(), PendingOperationRecoveryBlockedError);
    assert.equal(storage.value(key), value);
  }
});

test("storage failures and readback mutations fail closed before records become usable", async () => {
  const storage = new SharedStorage();
  const subject = manager(storage);
  const lease = await subject.acquireReview();
  storage.setItem = () => {
    throw new Error("quota");
  };
  assert.throws(() => lease.stagePrepared(identity()), PendingOperationRecoveryBlockedError);
  await lease.release();
  // A separate storage fake makes writes appear successful but returns altered bytes.
  let written = false;
  const altered = {
    getItem: () => (written ? "{}" : null),
    setItem: () => {
      written = true;
    },
    removeItem: () => undefined,
  };
  const another = manager(altered);
  const anotherLease = await another.acquireReview();
  assert.throws(() => anotherLease.stagePrepared(identity()), PendingOperationRecoveryBlockedError);
  await anotherLease.release();
});

test("missing, rejected, and delayed lock acquisition never yields a usable late lease", async () => {
  const storage = new SharedStorage();
  await assert.rejects(
    createPendingOperationManager({
      storage,
      sender: SENDER,
      entryPoint: ENTRY_POINT,
    }).acquireReview(),
    PendingOperationRecoveryBlockedError,
  );
  const rejecting = {
    request: async () => {
      throw new Error("locks unavailable");
    },
  };
  await assert.rejects(
    manager(storage, rejecting).acquireReview(),
    PendingOperationRecoveryBlockedError,
  );
  let grant;
  const delayed = {
    request: (_name, _opts, callback) =>
      new Promise((resolve) => {
        grant = () => resolve(callback({ name: "late" }));
      }),
  };
  const subject = createPendingOperationManager({
    storage,
    locks: delayed,
    sender: SENDER,
    entryPoint: ENTRY_POINT,
    acquisitionTimeoutMs: 1,
  });
  await assert.rejects(subject.acquireReview(), PendingOperationBusyError);
  grant();
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  const healthy = manager(storage);
  const lease = await healthy.acquireReview();
  await lease.release();
});
