import {
  assert,
  calls,
  createLocks,
  createStorage,
  delay,
  dependencies,
  operation,
  relay,
  SAFE_ADDRESS,
  test,
} from "./pending-operation-session-fixtures.mjs";
import { createGuardedPasskeySession } from "../src/lib/pending-operation-session.ts";
import { createPendingOperationManager } from "../src/lib/pending-operation-guard.ts";
import { createPasskeyAccount, SafeUserOperationPendingError } from "../src/lib/passkey-safe.ts";

test("direct unavailable durable support blocks before Safe transaction work", async () => {
  let created = 0;
  const session = await createPasskeyAccount(
    { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage: createStorage() },
    dependencies({
      pendingOperationLocks: {},
      async initRelay() {
        const instance = relay();
        instance.createTransaction = async () => {
          created += 1;
          return relay().createTransaction();
        };
        return instance;
      },
    }),
  );
  await assert.rejects(session.sendTransaction(calls), /storage|locks/i);
  assert.equal(created, 0);
});

test("persistent attempted readback poison remains blocked after actual send", async () => {
  const storage = createStorage();
  const read = storage.getItem;
  let count = 0;
  let execute = 0;
  storage.getItem = (key) => {
    count += 1;
    if (count >= 5) throw new Error("persistent read failure");
    return read(key);
  };
  const instance = relay();
  instance.executeTransaction = async () => {
    execute += 1;
    return `0x${"60".repeat(32)}`;
  };
  const session = await createPasskeyAccount(
    { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage },
    dependencies({
      pendingOperationLocks: createLocks(),
      preparationTimeoutMs: 10,
      async initRelay() {
        return instance;
      },
    }),
  );
  count = 0;
  await assert.rejects(session.sendTransaction(calls), /not submitted/i);
  assert.equal(execute, 0);
  await assert.rejects(session.sendTransaction(calls));
});

test("actual lookup rejection retains attempted record and blocks a new send", async () => {
  const storage = createStorage();
  const locks = createLocks();
  let lookups = 0;
  const raw = createGuardedPasskeySession(
    {
      address: SAFE_ADDRESS,
      async signTypedData() {
        return "0x";
      },
      async prepareTransaction() {
        throw new Error("unused");
      },
      async sendTransaction(_c, options) {
        await options.onOperationPrepared(operation());
        throw new SafeUserOperationPendingError(operation());
      },
      async lookupUserOperation() {
        lookups += 1;
        throw new Error("lookup unavailable");
      },
    },
    { storage, locks },
  );
  await assert.rejects(raw.sendTransaction(calls));
  await assert.rejects(raw.recoverPendingOperation());
  assert.equal(lookups, 1);
  await assert.rejects(raw.sendTransaction(calls));
});

test("prepared orphan recovery clears without lookup or transaction work", async () => {
  const storage = createStorage();
  const locks = createLocks();
  const manager = createPendingOperationManager({ sender: SAFE_ADDRESS, storage, locks });
  storage.setItem(
    manager.storageKey,
    JSON.stringify({ version: 1, ...operation(), createdAt: 1, phase: "prepared" }),
  );
  let lookup = 0;
  const guarded = createGuardedPasskeySession(
    {
      address: SAFE_ADDRESS,
      async signTypedData() {
        return "0x";
      },
      async prepareTransaction() {
        throw new Error("no prepare");
      },
      async sendTransaction() {
        throw new Error("no send");
      },
      async lookupUserOperation() {
        lookup += 1;
        return { state: "pending", operation: operation() };
      },
    },
    { storage, locks },
  );
  assert.equal((await guarded.recoverPendingOperation()).state, "not-submitted");
  assert.equal(lookup, 0);
  assert.equal(guarded.getPendingOperation(), null);
});

test("recovery completion for A does not clear a replacement B", async () => {
  const storage = createStorage();
  const locks = createLocks();
  const first = operation();
  const next = operation(`0x${"22".repeat(32)}`);
  let finish;
  const manager = createPendingOperationManager({ sender: SAFE_ADDRESS, storage, locks });
  storage.setItem(
    manager.storageKey,
    JSON.stringify({ version: 1, ...first, createdAt: 1, phase: "attempted" }),
  );
  const guarded = createGuardedPasskeySession(
    {
      address: SAFE_ADDRESS,
      async signTypedData() {
        return "0x";
      },
      async prepareTransaction() {
        throw new Error("no");
      },
      async sendTransaction() {
        throw new Error("no");
      },
      async lookupUserOperation() {
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
    { storage, locks },
  );
  const recovering = guarded.recoverPendingOperation();
  await delay(0);
  storage.setItem(
    manager.storageKey,
    JSON.stringify({ version: 1, ...next, createdAt: 2, phase: "attempted" }),
  );
  finish({ state: "confirmed", operation: first, transactionHash: `0x${"44".repeat(32)}` });
  await recovering;
  assert.equal(guarded.getPendingOperation().userOperationHash, next.userOperationHash);
});

test("no-staged producer success fails closed for direct and prepared sends", async () => {
  const raw = {
    address: SAFE_ADDRESS,
    async signTypedData() {
      return "0x";
    },
    async sendTransaction() {
      return `0x${"11".repeat(32)}`;
    },
    async prepareTransaction() {
      return {
        cancel() {},
        async send() {
          return `0x${"11".repeat(32)}`;
        },
      };
    },
  };
  const guarded = createGuardedPasskeySession(raw, {
    storage: createStorage(),
    locks: createLocks(),
  });
  await assert.rejects(guarded.sendTransaction(calls), /never durably staged/i);
  const prepared = await guarded.prepareTransaction(calls);
  await assert.rejects(prepared.send(), /never durably staged/i);
});
