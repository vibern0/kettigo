import assert from "node:assert/strict";
import test from "node:test";

import * as zamaSessionManagers from "../src/lib/zama-session-manager.ts";

test("existing-only reads require a persisted valid key without creating or granting access", async () => {
  const session = {};
  let creates = 0;
  let checks = 0;
  const manager = zamaSessionManagers.createDelegatedZamaSessionManager({
    async loadSessionKey() {
      return undefined;
    },
    async createSessionKey() {
      creates += 1;
      return { id: "new" };
    },
    isSessionKeyValid() {
      return true;
    },
    createResource() {
      throw new Error("a missing key must not create a resource");
    },
    async ensureDelegated() {
      throw new Error("a missing key must not delegate");
    },
    async assertDelegated() {
      checks += 1;
    },
  });

  await assert.rejects(
    manager.runExisting(session, ["token"], async () => "revealed"),
    (error) => error instanceof zamaSessionManagers.ZamaReadSessionAccessRequiredError,
  );

  assert.equal(creates, 0);
  assert.equal(checks, 0);
});

test("existing-only reads reject an expired cached key without replacing it", async () => {
  const session = {};
  let valid = true;
  let creates = 0;
  let terminated = 0;
  const key = { id: "persisted" };
  const manager = zamaSessionManagers.createDelegatedZamaSessionManager({
    async loadSessionKey() {
      return key;
    },
    async createSessionKey() {
      creates += 1;
      return { id: "new" };
    },
    isSessionKeyValid() {
      return valid;
    },
    createResource() {
      return {
        permits: { async clear() {} },
        terminate() {
          terminated += 1;
        },
      };
    },
    async ensureDelegated() {},
    async assertDelegated() {},
  });

  assert.equal(await manager.runExisting(session, ["token"], async () => "revealed"), "revealed");
  valid = false;
  await assert.rejects(
    manager.runExisting(session, ["token"], async () => "revealed"),
    (error) => error instanceof zamaSessionManagers.ZamaReadSessionAccessRequiredError,
  );

  assert.equal(creates, 0);
  assert.equal(terminated, 1);
});

test("existing-only reads check ACL once and never retry it as a transient reveal failure", async () => {
  const session = {};
  let aclChecks = 0;
  let reveals = 0;
  const manager = zamaSessionManagers.createDelegatedZamaSessionManager({
    async loadSessionKey() {
      return { id: "persisted" };
    },
    async createSessionKey() {
      throw new Error("must not create");
    },
    isSessionKeyValid() {
      return true;
    },
    createResource() {
      return { permits: { async clear() {} }, terminate() {} };
    },
    async ensureDelegated() {
      throw new Error("must not grant");
    },
    async assertDelegated() {
      aclChecks += 1;
      throw new zamaSessionManagers.ZamaReadSessionAccessRequiredError();
    },
  });

  await assert.rejects(
    manager.runExisting(session, ["token"], async () => {
      reveals += 1;
    }),
    (error) => error instanceof zamaSessionManagers.ZamaReadSessionAccessRequiredError,
  );

  assert.equal(aclChecks, 1);
  assert.equal(reveals, 0);
});

test("existing-only reads serialize a persisted resource and stop late output after abort or logout", async () => {
  const session = {};
  let releaseLoad;
  let loaded;
  let loads = 0;
  const loading = new Promise((resolve) => {
    loaded = resolve;
  });
  let resources = 0;
  let terminated = 0;
  const signal = { aborted: false, reason: undefined };
  const manager = zamaSessionManagers.createDelegatedZamaSessionManager({
    async loadSessionKey() {
      loads += 1;
      if (loads > 1) return undefined;
      loaded();
      await new Promise((resolve) => {
        releaseLoad = resolve;
      });
      return { id: "persisted" };
    },
    async createSessionKey() {
      throw new Error("must not create");
    },
    isSessionKeyValid() {
      return true;
    },
    createResource() {
      resources += 1;
      return {
        permits: { async clear() {} },
        terminate() {
          terminated += 1;
        },
      };
    },
    async ensureDelegated() {
      throw new Error("must not grant");
    },
    async assertDelegated() {},
  });

  const reveal = manager.runExisting(session, ["token"], async () => "late", {
    signal,
  });
  await loading;
  signal.aborted = true;
  signal.reason = new Error("account changed");
  releaseLoad();
  await assert.rejects(reveal, /account changed/);
  assert.equal(resources, 0);

  const logout = manager.clear(session);
  await logout;
  assert.equal(terminated, 0);
  await assert.rejects(
    manager.runExisting(session, ["token"], async () => "late"),
    /closed/,
  );
});

test("logout fences an active existing-only decrypt before it can return a late value", async () => {
  const session = {};
  let releaseDecrypt;
  let decrypting;
  const started = new Promise((resolve) => {
    decrypting = resolve;
  });
  const events = [];
  const manager = zamaSessionManagers.createDelegatedZamaSessionManager({
    async loadSessionKey() {
      return { id: "persisted" };
    },
    async createSessionKey() {
      throw new Error("must not create");
    },
    isSessionKeyValid() {
      return true;
    },
    createResource() {
      return {
        permits: {
          async clear() {
            events.push("clear");
          },
        },
        terminate() {
          events.push("terminate");
        },
      };
    },
    async ensureDelegated() {
      throw new Error("must not grant");
    },
    async assertDelegated() {
      events.push("acl");
    },
  });

  const reveal = manager.runExisting(session, ["token"], async () => {
    decrypting();
    await new Promise((resolve) => {
      releaseDecrypt = resolve;
    });
    return "late";
  });
  await started;
  const logout = manager.clear(session);
  releaseDecrypt();

  await assert.rejects(reveal, /closed/);
  await logout;
  assert.deepEqual(events, ["acl", "clear", "terminate"]);
});
