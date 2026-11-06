import assert from "node:assert/strict";
import test from "node:test";

import { createPrizeCheckIntentStore } from "../src/lib/prize-check-coordinator.ts";
import {
  ACCOUNT,
  HASH,
  POOL,
  fixture,
  identity,
  memoryStorage,
} from "./prize-check-coordinator-fixtures.mjs";

const saved = () => ({
  chainId: 11155111,
  pool: POOL,
  account: ACCOUNT,
  drawId: 4n,
  action: "checkPrize",
  operation: identity(),
});

test("aborting while the prepared observer saves prevents broadcast and retains its identity", async () => {
  const controller = new AbortController();
  let sent = 0,
    value = null;
  const { coordinator } = fixture({
    intentStore: {
      save: async (next) => {
        value = next;
        controller.abort(new Error("scope changed"));
      },
      read: () => value,
      clear: async () => {},
    },
    session: {
      address: ACCOUNT,
      prepareTransaction: async () => ({
        cancel() {},
        send: async (options) => {
          await options.onOperationPrepared(identity());
          sent += 1;
          return HASH;
        },
      }),
    },
  });
  const ready = await coordinator.prepare(
    await coordinator.review(4n, controller.signal),
    controller.signal,
  );
  await assert.rejects(ready.confirm(), /scope changed/);
  assert.equal(sent, 0);
  assert.equal(value.operation.userOperationHash, identity().userOperationHash);
});

test("reconciliation clears captured identity A without replacing or touching B", async () => {
  const a = saved(),
    b = { ...saved(), operation: { ...identity(), userOperationHash: HASH } };
  let current = a,
    looked = null,
    cleared = null;
  const { coordinator } = fixture({
    intentStore: {
      save: async () => {},
      read: () => current,
      clear: async (value) => {
        cleared = value;
        if (value.operation.userOperationHash === a.operation.userOperationHash) current = b;
      },
    },
    session: {
      address: ACCOUNT,
      prepareTransaction: async () => {
        throw new Error("unused");
      },
      lookupUserOperation: async (operation) => {
        looked = operation;
        return {
          state: "failed",
          operation,
          transactionHash: HASH,
          blockNumber: 1n,
          blockHash: HASH,
        };
      },
    },
  });
  assert.equal((await coordinator.reconcile(4n, a)).state, "failed");
  assert.equal(looked.userOperationHash, a.operation.userOperationHash);
  assert.equal(cleared.operation.userOperationHash, a.operation.userOperationHash);
  assert.equal(current.operation.userOperationHash, b.operation.userOperationHash);
});

test("confirmed checks retain their exact saved intent until checked award state is readable", async () => {
  for (const reads of [
    {
      readChecked: async () => false,
      readAward: async () => HASH,
    },
    {
      readChecked: async () => true,
      readAward: async () => {
        throw new Error("award unavailable");
      },
    },
  ]) {
    const value = saved();
    const { coordinator } = fixture({
      ...reads,
      intentStore: {
        save: async () => {},
        read: () => value,
        clear: async () => {
          value.cleared = true;
        },
      },
      session: {
        address: ACCOUNT,
        prepareTransaction: async () => {
          throw new Error("unused");
        },
        lookupUserOperation: async (operation) => ({
          state: "confirmed",
          operation,
          transactionHash: HASH,
          blockNumber: 1n,
          blockHash: HASH,
        }),
      },
    });
    await assert.rejects(coordinator.reconcile(4n, value));
    assert.equal(value.cleared, undefined);
  }
});

test("abort after send discards late reconciliation without cancelling attempted operation", async () => {
  const controller = new AbortController();
  let cancelled = 0,
    looked = 0,
    value = null;
  const { coordinator } = fixture({
    intentStore: {
      save: async (next) => {
        value = next;
      },
      read: () => value,
      clear: async () => {},
    },
    session: {
      address: ACCOUNT,
      prepareTransaction: async () => ({
        cancel: () => {
          cancelled += 1;
        },
        send: async (options) => {
          await options.onOperationPrepared(identity());
          controller.abort(new Error("switched"));
          return HASH;
        },
        lookupUserOperation: async () => {
          looked += 1;
          return { state: "pending", operation: identity() };
        },
      }),
    },
  });
  const ready = await coordinator.prepare(
    await coordinator.review(4n, controller.signal),
    controller.signal,
  );
  await assert.rejects(ready.confirm(), /switched/);
  assert.equal(cancelled, 0);
  assert.equal(looked, 0);
  assert.equal(value.operation.userOperationHash, identity().userOperationHash);
});

test("actual storage rejects oversized wrong-action and invalid draw records without overwrite", async () => {
  for (const raw of [
    "x".repeat(2049),
    JSON.stringify({ ...saved(), drawId: "4", action: "claimPrize" }),
    JSON.stringify({ ...saved(), drawId: "0" }),
    JSON.stringify({ ...saved(), drawId: (1n << 256n).toString() }),
  ]) {
    const storage = memoryStorage(raw),
      store = createPrizeCheckIntentStore(storage);
    assert.throws(() => store.read(), /corrupt/i);
    await assert.rejects(store.save(saved()), /corrupt/i);
    assert.equal(storage.raw(), raw);
  }
});
