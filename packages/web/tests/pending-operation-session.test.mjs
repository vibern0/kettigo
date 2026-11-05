import {
  assert,
  createLocks,
  createStorage,
  delay,
  dependencies,
  finalUserOperation,
  getAddress,
  entryPoint07Address,
  SAFE_ADDRESS,
  test,
  VERIFIER_ADDRESS,
  RAW_ID,
  relay,
  COORDINATES,
} from "./passkey-safe-fixtures.mjs";

import { createGuardedPasskeySession } from "../src/lib/pending-operation-session.ts";
import { createPendingOperationManager } from "../src/lib/pending-operation-guard.ts";
import {
  createPasskeyAccount,
  restorePasskeyAccount,
  SafeUserOperationPendingError,
} from "../src/lib/passkey-safe.ts";

test("fails closed before raw preparation when durable browser support is unavailable", async () => {
  let prepares = 0;
  const guarded = createGuardedPasskeySession(
    {
      address: SAFE_ADDRESS,
      async signTypedData() {
        return "0x";
      },
      async prepareTransaction() {
        prepares += 1;
        return {
          cancel() {},
          async send() {
            return `0x${"11".repeat(32)}`;
          },
        };
      },
      async sendTransaction() {
        return `0x${"11".repeat(32)}`;
      },
    },
    {},
  );
  await assert.rejects(guarded.prepareTransaction([{ to: SAFE_ADDRESS, data: "0x" }]));
  assert.equal(prepares, 0);
});

test("only one real session can reach a ready review for a shared Safe", async () => {
  const storage = createStorage();
  const locks = createLocks();
  let credentials = 0;
  const fixtures = () =>
    dependencies({
      pendingOperationLocks: locks,
      async getCredential(...args) {
        credentials += 1;
        return dependencies().getCredential(...args);
      },
    });
  const first = await createPasskeyAccount(
    { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage },
    fixtures(),
  );
  const second = await createPasskeyAccount(
    { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage },
    fixtures(),
  );
  const review = await first.prepareTransaction([{ to: SAFE_ADDRESS, data: "0x" }]);
  await assert.rejects(
    second.prepareTransaction([{ to: SAFE_ADDRESS, data: "0x" }]),
    /another operation/i,
  );
  assert.equal(credentials, 0);
  review.cancel();
});

test("a pending direct operation blocks a restored session until canonical recovery clears it", async () => {
  const storage = createStorage();
  const locks = createLocks();
  const stalled = dependencies({
    pendingOperationLocks: locks,
    receiptTimeoutMs: 10,
    receiptPollMs: 0,
    async initRelay() {
      const instance = relay();
      instance.getUserOperationReceipt = async () => null;
      return instance;
    },
    async sleep() {},
  });
  const first = await createPasskeyAccount(
    { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage },
    stalled,
  );
  await assert.rejects(
    first.sendTransaction([{ to: SAFE_ADDRESS, data: "0x" }]),
    SafeUserOperationPendingError,
  );
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
  await assert.rejects(restored.sendTransaction([{ to: SAFE_ADDRESS, data: "0x" }]), /recovery/i);
  assert.equal((await restored.recoverPendingOperation()).state, "confirmed");
  assert.equal(restored.getPendingOperation(), null);
});

test("a slow preparation is cancelled after its deadline and cannot later request credentials", async () => {
  const storage = createStorage();
  const locks = createLocks();
  let finishPreparation;
  let cancelled = 0;
  let credentials = 0;
  const raw = {
    address: SAFE_ADDRESS,
    async signTypedData() {
      return "0x";
    },
    async prepareTransaction() {
      return new Promise((resolve) => {
        finishPreparation = () =>
          resolve({
            cancel() {
              cancelled += 1;
            },
            async send() {
              credentials += 1;
              return `0x${"11".repeat(32)}`;
            },
          });
      });
    },
    async sendTransaction() {
      return `0x${"11".repeat(32)}`;
    },
  };
  const guarded = createGuardedPasskeySession(raw, {
    storage,
    locks,
    preparationTimeoutMs: 10,
  });
  await assert.rejects(
    guarded.prepareTransaction([{ to: SAFE_ADDRESS, data: "0x" }]),
    /timed out/i,
  );
  finishPreparation();
  await delay(0);
  assert.equal(cancelled, 1);
  assert.equal(credentials, 0);
});

test("a timed-out direct signer checks ownership again before it can request a credential", async () => {
  const storage = createStorage();
  const locks = createLocks();
  let allowEstimate;
  let credentials = 0;
  const session = await createPasskeyAccount(
    { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage },
    dependencies({
      pendingOperationLocks: locks,
      preparationTimeoutMs: 10,
      async initRelay() {
        const instance = await dependencies().initRelay();
        instance.createTransaction = async () =>
          new Promise((resolve) => {
            allowEstimate = () => resolve({ getUserOperation: () => finalUserOperation() });
          });
        return instance;
      },
      async getCredential() {
        credentials += 1;
        return { id: "credential" };
      },
    }),
  );
  await assert.rejects(session.sendTransaction([{ to: SAFE_ADDRESS, data: "0x" }]), /timed out/i);
  allowEstimate();
  await delay(0);
  assert.equal(credentials, 0);
});

test("offchain typed signing remains independent while a direct operation lease expires", async () => {
  const storage = createStorage();
  const locks = createLocks();
  let finish;
  let typedSigns = 0;
  const guarded = createGuardedPasskeySession(
    {
      address: SAFE_ADDRESS,
      async signTypedData() {
        typedSigns += 1;
        return "0x1234";
      },
      async prepareTransaction() {
        throw new Error("not used");
      },
      async sendTransaction() {
        return new Promise((resolve) => {
          finish = () => resolve(`0x${"11".repeat(32)}`);
        });
      },
    },
    { storage, locks, preparationTimeoutMs: 10 },
  );
  await assert.rejects(guarded.sendTransaction([{ to: SAFE_ADDRESS, data: "0x" }]), /timed out/i);
  assert.equal(await guarded.signTypedData({}), "0x1234");
  finish();
  await delay(0);
  assert.equal(typedSigns, 1);
});

test("a completion clears only its captured staged identity", async () => {
  const storage = createStorage();
  const locks = createLocks();
  const first = `0x${"11".repeat(32)}`;
  const newer = `0x${"22".repeat(32)}`;
  let complete;
  const raw = {
    address: SAFE_ADDRESS,
    async signTypedData() {
      return "0x";
    },
    async prepareTransaction() {
      throw new Error("not used");
    },
    async sendTransaction(_calls, options) {
      await options.onOperationPrepared({
        chainId: 11155111,
        entryPoint: getAddress(entryPoint07Address),
        sender: SAFE_ADDRESS,
        userOperationHash: first,
      });
      return new Promise((resolve) => {
        complete = () => resolve(first);
      });
    },
  };
  const guarded = createGuardedPasskeySession(raw, { storage, locks });
  const sending = guarded.sendTransaction([{ to: SAFE_ADDRESS, data: "0x" }]);
  await delay(0);
  const manager = createPendingOperationManager({ sender: SAFE_ADDRESS, storage, locks });
  storage.setItem(
    manager.storageKey,
    JSON.stringify({
      version: 1,
      chainId: 11155111,
      entryPoint: getAddress(entryPoint07Address),
      sender: SAFE_ADDRESS,
      userOperationHash: newer,
      createdAt: 1,
      phase: "attempted",
    }),
  );
  complete();
  await sending;
  assert.equal(guarded.getPendingOperation().userOperationHash, newer);
});

test("a broadcast direct operation keeps raw receipt waiting after the preparation deadline", async () => {
  const storage = createStorage();
  const locks = createLocks();
  let reads = 0;
  const session = await createPasskeyAccount(
    { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage },
    dependencies({
      pendingOperationLocks: locks,
      preparationTimeoutMs: 10,
      receiptTimeoutMs: 100,
      receiptPollMs: 0,
      async initRelay() {
        const instance = relay();
        instance.getUserOperationReceipt = async () => {
          reads += 1;
          return reads === 1 ? null : relay().getUserOperationReceipt();
        };
        return instance;
      },
      async sleep() {
        await delay(20);
      },
    }),
  );
  assert.equal(
    await session.sendTransaction([{ to: SAFE_ADDRESS, data: "0x" }]),
    `0x${"44".repeat(32)}`,
  );
  assert.equal(reads, 2);
});
