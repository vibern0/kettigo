import assert from "node:assert/strict";
import test from "node:test";

import { EthSafeSignature } from "@safe-global/protocol-kit";
import { getAddress, hashTypedData } from "viem";

import {
  buildPasskeySigner,
  createPasskeyFeeEstimator,
  createPasskeyAccount,
  restorePasskeyAccount,
  signSafeTypedData,
  waitForUserOperationTransaction,
} from "../src/lib/passkey-safe.ts";

const SAFE_ADDRESS = getAddress("0x00000000000000000000000000000000000000bb");
const VERIFIER_ADDRESS = getAddress("0x00000000000000000000000000000000000000aa");
const SHARED_SIGNER_ADDRESS = getAddress("0x94a4F6affBd8975951142c3999aEAB7ecee555c2");
const RAW_ID = "aabbccdd";
const COORDINATES = {
  x: `0x${"11".repeat(32)}`,
  y: `0x${"22".repeat(32)}`,
};

function createStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function relay(address = SAFE_ADDRESS) {
  return {
    protocolKit: {
      async getAddress() {
        return address;
      },
    },
    async createTransaction() {
      return { operation: true };
    },
    async signSafeOperation(operation) {
      return { ...operation, signed: true };
    },
    async executeTransaction() {
      return `0x${"33".repeat(32)}`;
    },
    async getUserOperationReceipt() {
      return {
        success: true,
        receipt: { transactionHash: `0x${"44".repeat(32)}` },
      };
    },
  };
}

test("adds passkey verification gas before paymaster sponsorship", async () => {
  let sponsoredVerificationGas;
  const estimator = createPasskeyFeeEstimator({
    async preEstimateUserOperationGas() {
      return { maxFeePerGas: 1n };
    },
    async postEstimateUserOperationGas(input) {
      sponsoredVerificationGas = input.userOperation.verificationGasLimit;
      return {
        verificationGasLimit: input.userOperation.verificationGasLimit,
        paymasterData: "0x1234",
      };
    },
  });

  assert.deepEqual(await estimator.preEstimateUserOperationGas({}), { maxFeePerGas: 1n });
  const result = await estimator.postEstimateUserOperationGas({
    userOperation: { verificationGasLimit: 413_085n },
  });

  assert.equal(sponsoredVerificationGas, 463_085n);
  assert.equal(result.verificationGasLimit, 463_085n);
  assert.equal(result.paymasterData, "0x1234");
});

test("does not alter sponsor-signed gas fields", async () => {
  const estimator = createPasskeyFeeEstimator({
    async preEstimateUserOperationGas() {
      return {};
    },
    async postEstimateUserOperationGas() {
      return {
        verificationGasLimit: 420_000n,
        paymasterData: "0x1234",
      };
    },
  });

  await assert.rejects(
    estimator.postEstimateUserOperationGas({
      userOperation: { verificationGasLimit: 413_085n },
    }),
    /insufficient verification gas/i,
  );
});

test("preserves the full passkey margin at 500,000 gas", async () => {
  let sponsoredVerificationGas;
  const estimator = createPasskeyFeeEstimator({
    async preEstimateUserOperationGas() {
      return {};
    },
    async postEstimateUserOperationGas(input) {
      sponsoredVerificationGas = input.userOperation.verificationGasLimit;
      return { verificationGasLimit: sponsoredVerificationGas };
    },
  });

  const result = await estimator.postEstimateUserOperationGas({
    userOperation: { verificationGasLimit: 450_000n },
  });

  assert.equal(sponsoredVerificationGas, 500_000n);
  assert.equal(result.verificationGasLimit, 500_000n);
});

test("sponsors the observed Samsung passkey deployment estimate without a local ceiling", async () => {
  let sponsoredVerificationGas;
  const estimator = createPasskeyFeeEstimator({
    async preEstimateUserOperationGas() {
      return {};
    },
    async postEstimateUserOperationGas(input) {
      sponsoredVerificationGas = input.userOperation.verificationGasLimit;
      return { verificationGasLimit: sponsoredVerificationGas, paymasterData: "0x1234" };
    },
  });

  const result = await estimator.postEstimateUserOperationGas({
    userOperation: { verificationGasLimit: 2_968_567n },
  });
  assert.equal(sponsoredVerificationGas, 3_018_567n);
  assert.equal(result.verificationGasLimit, 3_018_567n);
  assert.equal(result.paymasterData, "0x1234");
});

function dependencies(overrides = {}) {
  return {
    async createCredential() {
      return { id: "credential" };
    },
    async extractPasskeyData() {
      return { rawId: RAW_ID, coordinates: COORDINATES };
    },
    getVerifierAddress(chainId) {
      assert.equal(chainId, "11155111");
      return VERIFIER_ADDRESS;
    },
    async initRelay() {
      return relay();
    },
    async getCode() {
      return "0x";
    },
    async getCredential() {
      return { id: "credential" };
    },
    async sleep() {},
    ...overrides,
  };
}

test("creates a deterministic Safe 1.4.1 session and stores checksum metadata", async () => {
  const storage = createStorage();
  let initOptions;
  const deps = dependencies({
    async initRelay(options) {
      initOptions = options;
      return relay();
    },
  });

  const session = await createPasskeyAccount(
    { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage },
    deps,
  );

  assert.equal(session.address, SAFE_ADDRESS);
  assert.equal(initOptions.safeModulesVersion, "0.3.0");
  assert.equal(initOptions.customContracts.entryPointAddress.toLowerCase(), "0x0000000071727de22e5e9d8baf0edac6f37da032");
  assert.equal(initOptions.customContracts.safeWebAuthnSharedSignerAddress, SHARED_SIGNER_ADDRESS);
  assert.deepEqual(initOptions.options.owners, []);
  assert.equal(initOptions.options.threshold, 1);
  assert.equal(initOptions.options.safeVersion, "1.4.1");
  assert.match(initOptions.options.saltNonce, /^\d+$/);
  assert.equal(initOptions.signer.verifierAddress, VERIFIER_ADDRESS);
  const persisted = JSON.parse(storage.getItem("kettigo.passkey.v1"));
  assert.equal(persisted.safeAddress, SAFE_ADDRESS);
  assert.equal(persisted.verifierAddress, VERIFIER_ADDRESS);
  assert.equal("email" in persisted, false);
});

test("derives account identity before restoring counterfactual and deployed Safes", async () => {
  const metadata = {
    rawId: RAW_ID,
    coordinates: COORDINATES,
    verifierAddress: VERIFIER_ADDRESS,
    safeAddress: SAFE_ADDRESS,
  };

  for (const [code, expectedKey] of [["0x", "owners"], ["0x6000", "safeAddress"]]) {
    const initOptions = [];
    const session = await restorePasskeyAccount(
      { metadata, rpId: "app.kettigo.xyz" },
      dependencies({
        async getCode() {
          return code;
        },
        async initRelay(options) {
          initOptions.push(options);
          return relay();
        },
      }),
    );

    assert.equal(session.address, SAFE_ADDRESS);
    assert.equal("owners" in initOptions[0].options, true);
    const restoredOptions = initOptions.at(-1);
    assert.equal(expectedKey in restoredOptions.options, true);
    assert.equal(
      restoredOptions.customContracts.safeWebAuthnSharedSignerAddress,
      SHARED_SIGNER_ADDRESS,
    );
    assert.equal(initOptions.length, code === "0x" ? 1 : 2);
  }
});

test("blocks a deployed restored signer when independent Safe derivation no longer matches", async () => {
  const other = getAddress("0x00000000000000000000000000000000000000cc");
  await assert.rejects(
    restorePasskeyAccount(
      {
        metadata: {
          rawId: RAW_ID,
          coordinates: COORDINATES,
          verifierAddress: VERIFIER_ADDRESS,
          safeAddress: SAFE_ADDRESS,
        },
        rpId: "app.kettigo.xyz",
      },
      dependencies({
        async getCode() {
          return "0x6000";
        },
        async initRelay(options) {
          assert.equal("owners" in options.options, true);
          return relay(other);
        },
      }),
    ),
    /does not match/i,
  );
});

test("reports signing before submission and receipt polling finish", async () => {
  let release;
  const submission = new Promise((resolve) => { release = resolve; });
  const instance = relay();
  let signed = false;
  instance.executeTransaction = async () => {
    assert.equal(signed, true);
    await submission;
    return `0x${"33".repeat(32)}`;
  };
  const session = await createPasskeyAccount(
    { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage: createStorage() },
    dependencies({ async initRelay() { return instance; } }),
  );
  const pending = session.sendTransaction([{ to: SAFE_ADDRESS, data: "0x" }], {
    onSigned() { signed = true; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signed, true);
  release();
  assert.equal(await pending, `0x${"44".repeat(32)}`);
});

test("does not hand off or submit when signing is cancelled", async () => {
  const instance = relay();
  let signed = false;
  let submitted = false;
  instance.signSafeOperation = async () => { throw new Error("Approval cancelled"); };
  instance.executeTransaction = async () => { submitted = true; return "0x"; };
  const session = await createPasskeyAccount(
    { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage: createStorage() },
    dependencies({ async initRelay() { return instance; } }),
  );
  await assert.rejects(session.sendTransaction([{ to: SAFE_ADDRESS, data: "0x" }], {
    onSigned() { signed = true; },
  }), /Approval cancelled/);
  assert.equal(signed, false);
  assert.equal(submitted, false);
});

test("reconnects through the deployed Safe after the first mined action", async () => {
  const storage = createStorage();
  const initOptions = [];
  const callCounts = [0, 0];
  const relays = [relay(), relay()];
  for (const [index, instance] of relays.entries()) {
    const original = instance.createTransaction;
    instance.createTransaction = async (...args) => {
      callCounts[index] += 1;
      return original(...args);
    };
  }

  const session = await createPasskeyAccount(
    { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage },
    dependencies({
      async initRelay(options) {
        initOptions.push(options);
        return relays[initOptions.length - 1];
      },
    }),
  );

  const calls = [{ to: SAFE_ADDRESS, data: "0x" }];
  await session.sendTransaction(calls);
  await session.sendTransaction(calls);

  assert.equal(initOptions.length, 2);
  assert.equal(initOptions[1].options.safeAddress, SAFE_ADDRESS);
  assert.equal(initOptions[1].customContracts.safeWebAuthnSharedSignerAddress, SHARED_SIGNER_ADDRESS);
  assert.deepEqual(callCounts, [1, 1]);
});

test("returns a mined transaction and retries a failed relay refresh before the next action", async () => {
  const storage = createStorage();
  const deployedRelay = relay();
  let initCount = 0;
  let deployedCalls = 0;
  deployedRelay.createTransaction = async () => {
    deployedCalls += 1;
    return { operation: true };
  };
  const session = await createPasskeyAccount(
    { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage },
    dependencies({
      async initRelay() {
        initCount += 1;
        if (initCount === 1) return relay();
        if (initCount === 2) throw new Error("temporary RPC failure");
        return deployedRelay;
      },
    }),
  );
  const calls = [{ to: SAFE_ADDRESS, data: "0x" }];

  assert.equal(await session.sendTransaction(calls), `0x${"44".repeat(32)}`);
  assert.equal(initCount, 1);
  await assert.rejects(session.sendTransaction(calls), /temporary RPC failure/);
  assert.equal(deployedCalls, 0);
  assert.equal(await session.sendTransaction(calls), `0x${"44".repeat(32)}`);
  assert.equal(initCount, 3);
  assert.equal(deployedCalls, 1);
});

test("refreshes a deployed relay before signing a transaction", async () => {
  const metadata = {
    rawId: RAW_ID,
    coordinates: COORDINATES,
    verifierAddress: VERIFIER_ADDRESS,
    safeAddress: SAFE_ADDRESS,
  };
  let initCount = 0;
  const freshRelay = relay();

  const session = await restorePasskeyAccount(
    { metadata, rpId: "app.kettigo.xyz" },
    dependencies({
      async getCode() {
        return "0x6000";
      },
      async initRelay() {
        initCount += 1;
        return initCount === 1 ? relay() : initCount === 2 ? relay() : freshRelay;
      },
    }),
  );

  assert.equal(initCount, 2);
  assert.equal(
    await session.sendTransaction([{ to: SAFE_ADDRESS, data: "0x" }]),
    `0x${"44".repeat(32)}`,
  );
  assert.equal(initCount, 3);
});

test("rebuilds and retries a deployed relay after an AA24 signature rejection", async () => {
  const metadata = {
    rawId: RAW_ID,
    coordinates: COORDINATES,
    verifierAddress: VERIFIER_ADDRESS,
    safeAddress: SAFE_ADDRESS,
  };
  const firstRelay = relay();
  firstRelay.executeTransaction = async () => {
    throw new Error("RpcRequestError: UserOperation reverted with reason: AA24 signature error");
  };
  const secondRelay = relay();
  let initCount = 0;

  const session = await restorePasskeyAccount(
    { metadata, rpId: "app.kettigo.xyz" },
    dependencies({
      async getCode() {
        return "0x6000";
      },
      async initRelay() {
        initCount += 1;
        if (initCount < 3) return relay();
        return initCount === 3 ? firstRelay : secondRelay;
      },
    }),
  );

  assert.equal(
    await session.sendTransaction([{ to: SAFE_ADDRESS, data: "0x" }]),
    `0x${"44".repeat(32)}`,
  );
  assert.equal(initCount, 4);
});

test("waits for a successful UserOperation receipt and returns the transaction hash", async () => {
  let attempts = 0;
  const result = await waitForUserOperationTransaction(
    {
      async getUserOperationReceipt() {
        attempts += 1;
        return attempts === 1
          ? null
          : { success: true, receipt: { transactionHash: `0x${"44".repeat(32)}` } };
      },
    },
    `0x${"33".repeat(32)}`,
    { timeoutMs: 10, pollMs: 0, sleep: async () => {} },
  );
  assert.equal(result, `0x${"44".repeat(32)}`);
  assert.equal(attempts, 2);

  await assert.rejects(
    waitForUserOperationTransaction(
      { async getUserOperationReceipt() { return { success: false, receipt: { transactionHash: `0x${"55".repeat(32)}` } }; } },
      `0x${"33".repeat(32)}`,
      { timeoutMs: 10, pollMs: 0, sleep: async () => {} },
    ),
    /failed/i,
  );
});

test("encodes a canonical Safe signature over bigint EIP-712 data", async () => {
  const owner = getAddress("0x00000000000000000000000000000000000000dd");
  const signature = `0x${"11".repeat(64)}1b`;
  const safeMessageHash = `0x${"22".repeat(32)}`;
  let wrappedDigest;
  let signedHash;
  const typedData = {
    domain: { name: "Kettigo", version: "1", chainId: 11155111n, verifyingContract: SAFE_ADDRESS },
    types: { Authorization: [{ name: "expires", type: "uint256" }] },
    primaryType: "Authorization",
    message: { expires: 123n },
  };

  const encoded = await signSafeTypedData(
    {
      async getSafeMessageHash(hash) {
        wrappedDigest = hash;
        return safeMessageHash;
      },
      async signHash(hash) {
        signedHash = hash;
        return new EthSafeSignature(owner, signature);
      },
    },
    typedData,
  );

  assert.equal(wrappedDigest, hashTypedData(typedData));
  assert.equal(signedHash, safeMessageHash);
  assert.equal(encoded, signature);
});

test("builds a passkey signer whose assertion callback is scoped to the stored credential", async () => {
  let requestedRawId;
  const signer = buildPasskeySigner(
    { rawId: RAW_ID, coordinates: COORDINATES, verifierAddress: VERIFIER_ADDRESS, safeAddress: SAFE_ADDRESS },
    "app.kettigo.xyz",
    {
      async getCredential(rawId, rpId) {
        requestedRawId = rawId;
        assert.equal(rpId, "app.kettigo.xyz");
        return { id: "credential" };
      },
    },
  );
  await signer.getFn({ publicKey: { challenge: new Uint8Array([1]) } });
  assert.equal(requestedRawId, RAW_ID);
});

test("prepared transactions start the real passkey request synchronously after Safe RPC checks", async () => {
  const events = [];
  const session = await createPasskeyAccount(
    { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage: createStorage() },
    dependencies({
      async initRelay(options) {
        const instance = relay();
        instance.createTransaction = async () => { events.push("prepare"); return { operation: true }; };
        instance.signSafeOperation = async (operation) => {
          events.push("rpc-checks");
          await options.signer.getFn({ publicKey: { challenge: new Uint8Array([1, 2, 3]) } });
          return operation;
        };
        return instance;
      },
      async getCredential(_id, _rp, options) {
        events.push("passkey");
        assert.deepEqual(options.publicKey.challenge, new Uint8Array([1, 2, 3]));
        return { id: "credential" };
      },
    }),
  );
  const prepared = await session.prepareTransaction([{ to: SAFE_ADDRESS, data: "0x" }]);
  assert.deepEqual(events, ["prepare", "rpc-checks"]);
  const pending = prepared.send({ onSigned() { events.push("signed"); } });
  assert.deepEqual(events, ["prepare", "rpc-checks", "passkey"]);
  await pending;
  assert.deepEqual(events, ["prepare", "rpc-checks", "passkey", "signed"]);
  await assert.rejects(prepared.send(), /review your deposit/);
});

test("cancelling a prepared review never requests a credential or submits", async () => {
  let credentials = 0;
  let submissions = 0;
  const session = await createPasskeyAccount(
    { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage: createStorage() },
    dependencies({
      async initRelay(options) {
        const instance = relay();
        instance.signSafeOperation = async (operation) => { await options.signer.getFn({}); return operation; };
        instance.executeTransaction = async () => { submissions++; return "0x"; };
        return instance;
      },
      async getCredential() { credentials++; return { id: "credential" }; },
    }),
  );
  const prepared = await session.prepareTransaction([{ to: SAFE_ADDRESS, data: "0x" }]);
  prepared.cancel();
  await assert.rejects(prepared.send(), /review your deposit/);
  assert.equal(credentials, 0);
  assert.equal(submissions, 0);
});

test("a Safe preflight failure is returned during review before any passkey prompt", async () => {
  const session = await createPasskeyAccount(
    { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage: createStorage() },
    dependencies({
      async initRelay() {
        const instance = relay();
        instance.signSafeOperation = async () => { throw new Error("RPC unavailable"); };
        return instance;
      },
      async getCredential() { assert.fail("must not request credentials"); },
    }),
  );
  await assert.rejects(session.prepareTransaction([{ to: SAFE_ADDRESS, data: "0x" }]), /RPC unavailable/);
});
