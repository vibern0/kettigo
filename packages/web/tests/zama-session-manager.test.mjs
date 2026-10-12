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

test("one SDK instance is reused for the same wallet session", async () => {
  const created = [];
  const manager = createZamaSessionManager((session) => {
    const sdk = { session, permits: {}, terminate() {} };
    created.push(sdk);
    return sdk;
  });
  const session = {};

  const first = await manager.run(session, async (sdk) => sdk);
  const second = await manager.run(session, async (sdk) => sdk);
  assert.equal(created.length, 1);
  assert.equal(first, second);
  assert.notEqual(await manager.run({}, async (sdk) => sdk), first);
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

test("clear removes persistent credentials and terminates the SDK", async () => {
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
  await manager.run(session, async (sdk) => sdk);

  await manager.clear(session);

  assert.deepEqual(events, ["clear:1", "terminate:1"]);
  await assert.rejects(manager.run(session, async (sdk) => sdk), /closed/);
});

test("clear creates an SDK to remove credentials persisted before reload", async () => {
  const events = [];
  const session = {};
  const manager = createZamaSessionManager(() => ({
    permits: {
      async clear() {
        events.push("clear");
      },
    },
    terminate() {
      events.push("terminate");
    },
  }));

  await manager.clear(session);

  assert.deepEqual(events, ["clear", "terminate"]);
});

test("clear waits for active work before removing credentials", async () => {
  const events = [];
  let finishWork;
  const workGate = new Promise((resolve) => { finishWork = resolve; });
  const session = {};
  const manager = createZamaSessionManager(() => ({
    permits: {
      async clear() {
        events.push("clear");
      },
    },
    terminate() {
      events.push("terminate");
    },
  }));

  const work = manager.run(session, async () => {
    events.push("work:start");
    await workGate;
    events.push("work:end");
  });
  await Promise.resolve();
  const clearing = manager.clear(session);
  await Promise.resolve();

  assert.deepEqual(events, ["work:start"]);
  await assert.rejects(manager.run(session, async () => {}), /closed/);
  finishWork();
  await Promise.all([work, clearing]);
  assert.deepEqual(events, ["work:start", "work:end", "clear", "terminate"]);
});

test("clear still terminates and closes a session when credential removal fails", async () => {
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
  await assert.rejects(manager.clear(session), /storage unavailable/);

  assert.equal(terminated, true);
  await assert.rejects(manager.run(session, async () => {}), /closed/);
});
