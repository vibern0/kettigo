import assert from "node:assert/strict";
import test from "node:test";
import { recoverTypedDataAddress } from "viem";

import * as zamaSessionManagers from "../src/lib/zama-session-manager.ts";

const {
  createPersistentCredentialOptions,
  createZamaSessionManager,
} = zamaSessionManagers;

test("persistent credentials expire after seven days", () => {
  const storage = { name: "browser-storage" };

  assert.deepEqual(createPersistentCredentialOptions(storage), {
    storage,
    permitTTL: 7,
    transportKeyPairTTL: 7 * 24 * 60 * 60,
  });
});

test("a delegated read session authorizes the local signer before decrypting", async () => {
  assert.equal(typeof zamaSessionManagers.createDelegatedZamaSessionManager, "function");

  const events = [];
  const session = { address: "safe" };
  const key = { address: "reader" };
  const manager = zamaSessionManagers.createDelegatedZamaSessionManager({
    async createSessionKey(receivedSession) {
      assert.equal(receivedSession, session);
      events.push("key");
      return key;
    },
    createResource(receivedKey) {
      assert.equal(receivedKey, key);
      events.push("resource");
      return {
        permits: { async clear() {} },
        terminate() {},
      };
    },
    async ensureDelegated(receivedSession, receivedKey, contracts) {
      assert.equal(receivedSession, session);
      assert.equal(receivedKey, key);
      events.push(`delegate:${contracts.join(",")}`);
    },
  });

  const first = await manager.run(session, ["token", "pool"], async (resource, receivedKey) => {
    assert.equal(receivedKey, key);
    events.push("decrypt");
    return resource;
  });
  const second = await manager.run(session, ["pool"], async (resource) => resource);

  assert.equal(first, second);
  assert.deepEqual(events, [
    "key",
    "resource",
    "delegate:token,pool",
    "decrypt",
    "delegate:pool",
  ]);
});

test("the local read key is reused for seven days and then replaced", () => {
  assert.equal(typeof zamaSessionManagers.getOrCreateZamaReadSessionKey, "function");

  const values = new Map();
  const storage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
  const safe = "0x00000000000000000000000000000000000000bb";
  const generated = [`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`];
  let generation = 0;
  const deps = {
    generatePrivateKey() { return generated[generation++]; },
    getAccountAddress(privateKey) {
      return privateKey === generated[0]
        ? "0x00000000000000000000000000000000000000aa"
        : "0x00000000000000000000000000000000000000cc";
    },
  };

  const first = zamaSessionManagers.getOrCreateZamaReadSessionKey(storage, safe, 1_000, deps);
  const reused = zamaSessionManagers.getOrCreateZamaReadSessionKey(
    storage,
    safe,
    1_000 + 6 * 24 * 60 * 60 * 1_000,
    deps,
  );
  const replaced = zamaSessionManagers.getOrCreateZamaReadSessionKey(
    storage,
    safe,
    first.expiresAtMs,
    deps,
  );

  assert.equal(first.privateKey, generated[0]);
  assert.equal(first.expiresAtMs, 1_000 + 7 * 24 * 60 * 60 * 1_000);
  assert.deepEqual(reused, first);
  assert.equal(replaced.privateKey, generated[1]);
  assert.equal(generation, 2);
});

test("the local read key produces a canonical 65-byte EIP-712 signature", async () => {
  assert.equal(typeof zamaSessionManagers.signZamaReadSessionTypedData, "function");

  const privateKey = `0x${"11".repeat(32)}`;
  const typedData = {
    domain: {
      name: "Authorization token",
      version: "1",
      chainId: 11155111n,
      verifyingContract: "0x00000000000000000000000000000000000000bb",
    },
    types: {
      EIP712Domain: [],
      Authorization: [{ name: "expires", type: "uint256" }],
    },
    primaryType: "Authorization",
    message: { expires: 123n },
  };

  const signature = await zamaSessionManagers.signZamaReadSessionTypedData(
    privateKey,
    typedData,
  );

  assert.match(signature, /^0x[0-9a-f]{130}$/);
  assert.equal(
    await recoverTypedDataAddress({
      ...typedData,
      types: { Authorization: typedData.types.Authorization },
      signature,
    }),
    "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A",
  );
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

test("clear still terminates and can retry when credential removal fails", async () => {
  let attempts = 0;
  let terminations = 0;
  const manager = createZamaSessionManager(() => ({
    permits: {
      async clear() {
        attempts += 1;
        if (attempts === 1) throw new Error("storage unavailable");
      },
    },
    terminate() {
      terminations += 1;
    },
  }));
  const session = {};
  await assert.rejects(manager.clear(session), /storage unavailable/);
  await manager.clear(session);

  assert.equal(attempts, 2);
  assert.equal(terminations, 2);
  await assert.rejects(manager.run(session, async () => {}), /closed/);
});
