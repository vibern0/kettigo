import {
  assert,
  calls,
  COORDINATES,
  createLocks,
  createStorage,
  delay,
  dependencies,
  operation,
  RAW_ID,
  relay,
  RpcRequestError,
  SAFE_ADDRESS,
  test,
  VERIFIER_ADDRESS,
} from "./pending-operation-session-fixtures.mjs";
import { createGuardedPasskeySession } from "../src/lib/pending-operation-session.ts";
import { createPendingOperationManager } from "../src/lib/pending-operation-guard.ts";
import {
  createPasskeyAccount,
  restorePasskeyAccount,
  SafeUserOperationFailedError,
} from "../src/lib/passkey-safe.ts";

test("cancelling a ready review releases it and an inactive review cannot send", async () => {
  const storage = createStorage();
  const locks = createLocks();
  let sends = 0;
  const guarded = createGuardedPasskeySession(
    {
      address: SAFE_ADDRESS,
      async signTypedData() {
        return "0x";
      },
      async prepareTransaction() {
        return {
          cancel() {},
          async send() {
            sends += 1;
            return `0x${"11".repeat(32)}`;
          },
        };
      },
      async sendTransaction() {
        return `0x${"11".repeat(32)}`;
      },
    },
    { storage, locks },
  );
  const cancelled = await guarded.prepareTransaction(calls);
  cancelled.cancel();
  await assert.rejects(cancelled.send(), /review your transaction/i);
  const replacement = await guarded.prepareTransaction(calls);
  replacement.cancel();
  assert.equal(sends, 0);
});

test("observer and durable staging failures never execute and poison later sends", async () => {
  for (const scenario of ["observer", "storage"]) {
    const storage = createStorage();
    if (scenario === "storage")
      storage.setItem = () => {
        throw new Error("disk full");
      };
    let executes = 0;
    const raw = {
      address: SAFE_ADDRESS,
      async signTypedData() {
        return "0x";
      },
      async prepareTransaction() {
        throw new Error("not used");
      },
      async sendTransaction(_calls, options) {
        await options.onOperationPrepared(operation());
        executes += 1;
        return `0x${"11".repeat(32)}`;
      },
    };
    const guarded = createGuardedPasskeySession(raw, {
      storage,
      locks: createLocks(),
      preparationTimeoutMs: 10,
    });
    await assert.rejects(
      guarded.sendTransaction(
        calls,
        scenario === "observer"
          ? {
              onOperationPrepared() {
                throw new Error("observer refused");
              },
            }
          : undefined,
      ),
    );
    assert.equal(executes, 0, scenario);
    await assert.rejects(guarded.sendTransaction(calls), /storage|recovery/i);
  }
});

test(
  "a repaired storage read clears only a known not-submitted attempted record",
  { timeout: 1_000 },
  async () => {
    const storage = createStorage();
    const originalRead = storage.getItem;
    let reads = 0;
    storage.getItem = (key) => {
      reads += 1;
      if (reads === 5) throw new Error("verification read failed");
      return originalRead(key);
    };
    let executes = 0;
    const instance = relay();
    instance.executeTransaction = async () => {
      executes += 1;
      return `0x${"60".repeat(32)}`;
    };
    const guarded = await createPasskeyAccount(
      { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage },
      dependencies({
        pendingOperationLocks: createLocks(),
        preparationTimeoutMs: 10,
        async initRelay() {
          return instance;
        },
      }),
    );
    reads = 0;
    await assert.rejects(guarded.sendTransaction(calls), /not submitted/i);
    assert.equal(executes, 0);
    assert.equal(guarded.getPendingOperation(), null);
  },
);

test("a late observer after the direct deadline cannot attempt or execute", async () => {
  const storage = createStorage();
  const locks = createLocks();
  let finishObserver;
  let executes = 0;
  const guarded = createGuardedPasskeySession(
    {
      address: SAFE_ADDRESS,
      async signTypedData() {
        return "0x";
      },
      async prepareTransaction() {
        throw new Error("unused");
      },
      async sendTransaction(_calls, options) {
        await options.onOperationPrepared(operation());
        executes += 1;
        return `0x${"11".repeat(32)}`;
      },
    },
    { storage, locks, preparationTimeoutMs: 10 },
  );
  await assert.rejects(
    guarded.sendTransaction(calls, {
      onOperationPrepared() {
        return new Promise((resolve) => {
          finishObserver = resolve;
        });
      },
    }),
    /timed out/i,
  );
  finishObserver();
  await delay(0);
  assert.equal(executes, 0);
  assert.equal(guarded.getPendingOperation(), null);
});

test("returned user-operation hash mismatch remains attempted across restoration", async () => {
  const storage = createStorage();
  const locks = createLocks();
  const instance = relay();
  instance.executeTransaction = async () => `0x${"99".repeat(32)}`;
  const first = await createPasskeyAccount(
    { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage },
    dependencies({
      pendingOperationLocks: locks,
      async initRelay() {
        return instance;
      },
    }),
  );
  await assert.rejects(first.sendTransaction(calls), /different operation hash/i);
  assert.equal(first.getPendingOperation().phase, "attempted");
  const restored = await restorePasskeyAccount(
    {
      rpId: "app.kettigo.xyz",
      storage,
      metadata: {
        rawId: RAW_ID,
        coordinates: COORDINATES,
        verifierAddress: VERIFIER_ADDRESS,
        safeAddress: SAFE_ADDRESS,
      },
    },
    dependencies({ pendingOperationLocks: locks }),
  );
  await assert.rejects(restored.prepareTransaction(calls), /recovery/i);
});

test("only a genuine rejected RPC clears the wrapper record for a new review", async () => {
  const genuine = new RpcRequestError({
    body: { method: "eth_sendUserOperation", params: [] },
    error: { code: -32500, message: "no" },
    url: "https://bundler.invalid",
  });
  for (const error of [genuine, new Error("timeout")]) {
    const storage = createStorage();
    const instance = relay();
    instance.executeTransaction = async () => {
      throw error;
    };
    const session = await createPasskeyAccount(
      { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage },
      dependencies({
        async initRelay() {
          return instance;
        },
      }),
    );
    await assert.rejects(session.sendTransaction(calls));
    if (error === genuine) {
      assert.equal(session.getPendingOperation(), null);
      (await session.prepareTransaction(calls)).cancel();
    } else assert.equal(session.getPendingOperation().phase, "attempted");
  }
});

test("canonical inner failure clears exactly its record while pending recovery retains it", async () => {
  const storage = createStorage();
  const locks = createLocks();
  const failed = createGuardedPasskeySession(
    {
      address: SAFE_ADDRESS,
      async signTypedData() {
        return "0x";
      },
      async prepareTransaction() {
        throw new Error("unused");
      },
      async sendTransaction(_calls, options) {
        await options.onOperationPrepared(operation());
        throw new SafeUserOperationFailedError(operation());
      },
    },
    { storage, locks },
  );
  await assert.rejects(failed.sendTransaction(calls));
  assert.equal(failed.getPendingOperation(), null);
  const pending = createGuardedPasskeySession(
    {
      address: SAFE_ADDRESS,
      async signTypedData() {
        return "0x";
      },
      async prepareTransaction() {
        throw new Error("unused");
      },
      async sendTransaction() {
        throw new Error("unused");
      },
      async lookupUserOperation() {
        return { state: "pending", operation: operation() };
      },
    },
    { storage, locks },
  );
  const manager = createPendingOperationManager({ sender: SAFE_ADDRESS, storage, locks });
  storage.setItem(
    manager.storageKey,
    JSON.stringify({ version: 1, ...operation(), createdAt: 1, phase: "attempted" }),
  );
  assert.equal((await pending.recoverPendingOperation()).state, "pending");
  assert.equal(pending.getPendingOperation().phase, "attempted");
});

test("prepared send enters credential work synchronously and an aborted preparation cannot revive", async () => {
  const storage = createStorage();
  const locks = createLocks();
  const events = [];
  const controller = new AbortController();
  let resolve;
  const guarded = createGuardedPasskeySession(
    {
      address: SAFE_ADDRESS,
      async signTypedData() {
        return "0x";
      },
      async prepareTransaction() {
        return new Promise((done) => {
          resolve = done;
        });
      },
      async sendTransaction() {
        return `0x${"11".repeat(32)}`;
      },
    },
    { storage, locks, preparationTimeoutMs: 100 },
  );
  const waiting = guarded.prepareTransaction(calls, { signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting);
  resolve({
    cancel() {
      events.push("cancel");
    },
    send() {
      events.push("credential");
      return Promise.resolve(`0x${"11".repeat(32)}`);
    },
  });
  await delay(0);
  assert.deepEqual(events, ["cancel"]);
  const ready = await createGuardedPasskeySession(
    {
      address: SAFE_ADDRESS,
      async signTypedData() {
        return "0x";
      },
      async sendTransaction() {
        return "0x";
      },
      async prepareTransaction() {
        return {
          cancel() {},
          send(options) {
            void options.onOperationPrepared(operation());
            events.push("credential");
            return Promise.resolve(`0x${"11".repeat(32)}`);
          },
        };
      },
    },
    { storage: createStorage(), locks: createLocks() },
  ).prepareTransaction(calls);
  const sent = ready.send();
  assert.equal(events.at(-1), "credential");
  await sent;
});
