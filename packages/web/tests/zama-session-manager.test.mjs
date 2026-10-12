import assert from "node:assert/strict";
import test from "node:test";

import {
  createPersistentCredentialOptions,
  createZamaSessionManager,
} from "../src/lib/zama-session-manager.ts";

test("persistent credentials expire after seven days", () => {
  const storage = { name: "browser-storage" };

  assert.deepEqual(createPersistentCredentialOptions(storage), {
    storage,
    permitTTL: 7,
    transportKeyPairTTL: 7 * 24 * 60 * 60,
  });
});

test("one SDK instance is reused for the same wallet session", () => {
  const created = [];
  const manager = createZamaSessionManager((session) => {
    const sdk = { session, permits: {}, terminate() {} };
    created.push(sdk);
    return sdk;
  });
  const session = {};

  assert.equal(manager.get(session), manager.get(session));
  assert.equal(created.length, 1);
  assert.notEqual(manager.get({}), manager.get(session));
  assert.equal(created.length, 2);
});

test("grantPermit authorizes all requested contracts through the reused SDK", async () => {
  const grants = [];
  const session = {};
  const manager = createZamaSessionManager(() => ({
    permits: {
      async grantPermit(contracts) {
        grants.push(contracts);
      },
    },
    terminate() {},
  }));

  await manager.grantPermit(session, ["token", "pool"]);
  await manager.grantPermit(session, ["token", "pool"]);

  assert.deepEqual(grants, [["token", "pool"], ["token", "pool"]]);
});

test("clear removes persistent credentials, terminates the SDK, and allows recreation", async () => {
  const events = [];
  let instance = 0;
  const manager = createZamaSessionManager(() => {
    const id = ++instance;
    return {
      id,
      permits: {
        async clear() {
          events.push(`clear:${id}`);
        },
      },
      terminate() {
        events.push(`terminate:${id}`);
      },
    };
  });
  const session = {};
  const first = manager.get(session);

  await manager.clear(session);
  const second = manager.get(session);

  assert.deepEqual(events, ["clear:1", "terminate:1"]);
  assert.notEqual(first, second);
  assert.equal(second.id, 2);
});

test("clear still terminates and evicts an SDK when credential removal fails", async () => {
  let terminated = false;
  const manager = createZamaSessionManager(() => ({
    permits: {
      async clear() {
        throw new Error("storage unavailable");
      },
    },
    terminate() {
      terminated = true;
    },
  }));
  const session = {};
  const first = manager.get(session);

  await assert.rejects(manager.clear(session), /storage unavailable/);

  assert.equal(terminated, true);
  assert.notEqual(manager.get(session), first);
});
