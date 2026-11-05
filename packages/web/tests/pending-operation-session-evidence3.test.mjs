import {
  assert,
  calls,
  createLocks,
  createStorage,
  delay,
  dependencies,
  EthSafeSignature,
  operation,
  relay,
  RAW_ID,
  SAFE_ADDRESS,
  test,
  VERIFIER_ADDRESS,
  COORDINATES,
} from "./pending-operation-session-fixtures.mjs";
import { createGuardedPasskeySession } from "../src/lib/pending-operation-session.ts";
import {
  createPendingOperationManager,
  PendingOperationRecoveryBlockedError,
} from "../src/lib/pending-operation-guard.ts";
import {
  PASSKEY_METADATA_KEY,
  readPasskeyMetadata,
  writePasskeyMetadata,
} from "../src/lib/passkey-metadata.ts";
import {
  createPasskeyAccount,
  restorePasskeyAccount,
  SafeUserOperationPendingError,
} from "../src/lib/passkey-safe.ts";

const metadata = {
  rawId: RAW_ID,
  coordinates: COORDINATES,
  verifierAddress: VERIFIER_ADDRESS,
  safeAddress: SAFE_ADDRESS,
};
const typedData = {
  domain: { name: "Kettigo", version: "1", chainId: 11155111n, verifyingContract: SAFE_ADDRESS },
  types: { Authorization: [{ name: "expires", type: "uint256" }] },
  primaryType: "Authorization",
  message: { expires: 123n },
};
const badRecords = [
  ["malformed JSON", "{"],
  [
    "wrong sender",
    JSON.stringify({
      version: 1,
      ...operation(),
      createdAt: 1,
      phase: "attempted",
      sender: VERIFIER_ADDRESS,
    }),
  ],
  [
    "wrong chain",
    JSON.stringify({ version: 1, ...operation(), createdAt: 1, phase: "attempted", chainId: 1 }),
  ],
  [
    "wrong EntryPoint",
    JSON.stringify({
      version: 1,
      ...operation(),
      createdAt: 1,
      phase: "attempted",
      entryPoint: VERIFIER_ADDRESS,
    }),
  ],
];

async function restoreWithBadPending(badRecord) {
  const storage = createStorage();
  const locks = createLocks();
  const manager = createPendingOperationManager({ sender: SAFE_ADDRESS, storage, locks });
  writePasskeyMetadata(metadata, storage);
  storage.setItem(manager.storageKey, badRecord);
  const state = { credentials: 0, executes: 0, safeMessageHashes: 0, signedHashes: 0 };
  const instance = relay();
  instance.protocolKit.getSafeMessageHash = async (hash) => {
    state.safeMessageHashes += 1;
    return hash;
  };
  instance.protocolKit.signHash = async () => {
    state.signedHashes += 1;
    return new EthSafeSignature(VERIFIER_ADDRESS, `0x${"11".repeat(64)}1b`);
  };
  instance.executeTransaction = async () => {
    state.executes += 1;
    return `0x${"60".repeat(32)}`;
  };
  const session = await restorePasskeyAccount(
    { rpId: "app.kettigo.xyz", storage, metadata },
    dependencies({
      pendingOperationLocks: locks,
      async getCredential() {
        state.credentials += 1;
        return { id: "credential" };
      },
      async initRelay() {
        return instance;
      },
    }),
  );
  return { session, state, storage };
}

async function assertBadPendingSession({ session, state, storage }, label) {
  assert.equal(session.address, SAFE_ADDRESS, label);
  assert.equal(readPasskeyMetadata(storage).status, "valid", label);
  assert.notEqual(storage.getItem(PASSKEY_METADATA_KEY), null, label);
  assert.equal(await session.signTypedData(typedData), `0x${"11".repeat(64)}1b`, label);
  assert.equal(state.safeMessageHashes, 1, label);
  assert.equal(state.signedHashes, 1, label);
  assert.throws(() => session.getPendingOperation(), PendingOperationRecoveryBlockedError, label);
  await assert.rejects(session.sendTransaction(calls), PendingOperationRecoveryBlockedError, label);
  await assert.rejects(
    session.prepareTransaction(calls),
    PendingOperationRecoveryBlockedError,
    label,
  );
  assert.equal(state.credentials, 0, label);
  assert.equal(state.executes, 0, label);
}

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

test("restored production sessions keep signing available but block corrupt or wrong-scope pending state", async () => {
  for (const [label, badRecord] of badRecords)
    await assertBadPendingSession(await restoreWithBadPending(badRecord), label);
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
