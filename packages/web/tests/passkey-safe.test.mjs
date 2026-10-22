import assert from "node:assert/strict";
import test from "node:test";

import { EthSafeSignature } from "@safe-global/protocol-kit";
import { PimlicoFeeEstimator } from "@safe-global/relay-kit";
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

function relay(address = SAFE_ADDRESS, safeProvider) {
  const signatures = new Map();
  const operation = {
    signatures,
    addSignature(signature) {
      signatures.set(signature.signer, signature);
    },
  };
  return {
    protocolKit: {
      async getAddress() {
        return address;
      },
      ...(safeProvider ? { getSafeProvider() { return safeProvider; } } : {}),
    },
    async createTransaction() {
      return operation;
    },
    async signSafeOperation(operation) {
      operation.addSignature(new EthSafeSignature(SHARED_SIGNER_ADDRESS, "0x1234"));
      return operation;
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
    userOperation: { verificationGasLimit: 613_085n },
  });

  assert.equal(sponsoredVerificationGas, 766_357n);
  assert.equal(result.verificationGasLimit, 766_357n);
  assert.equal(result.paymasterData, "0x1234");
});

test("covers real Sepolia passkey validation before paymaster sponsorship", async () => {
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

  // Captured production estimate: 308,778. The same real signature failed
  // validation with 358,778 gas and succeeded with 450,000 gas on Sepolia.
  for (const verificationGasLimit of [200_000n, 308_778n, 450_000n]) {
    const result = await estimator.postEstimateUserOperationGas({
      userOperation: { verificationGasLimit },
    });

    assert.equal(sponsoredVerificationGas, 600_000n);
    assert.equal(result.verificationGasLimit, 600_000n);
  }
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

test("preserves the full passkey margin above the verification floor", async () => {
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
    userOperation: { verificationGasLimit: 700_000n },
  });

  assert.equal(sponsoredVerificationGas, 875_000n);
  assert.equal(result.verificationGasLimit, 875_000n);
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
  assert.equal(sponsoredVerificationGas, 3_710_709n);
  assert.equal(result.verificationGasLimit, 3_710_709n);
  assert.equal(result.paymasterData, "0x1234");
});

test("a measured verifier cost can raise the budget above the fallback and bundler estimate", async () => {
  const diagnostics = {};
  const estimator = createPasskeyFeeEstimator({
    async preEstimateUserOperationGas() { return {}; },
    async postEstimateUserOperationGas(input) {
      assert.equal(input.userOperation.verificationGasLimit, 912_500n);
      return { verificationGasLimit: 950_000n };
    },
  }, { estimateVerifierGas: async () => 650_000n, diagnostics });
  await estimator.postEstimateUserOperationGas({ userOperation: { verificationGasLimit: 308_778n } });
  assert.equal(diagnostics.verifierProbe, "measured");
  assert.equal(diagnostics.verifierGas, "650000");
  assert.equal(diagnostics.bundlerVerificationGas, "308778");
  assert.equal(diagnostics.requestedVerificationGas, "912500");
  assert.equal(diagnostics.sponsoredVerificationGas, "950000");
});

test("a probe outage preserves the proven fallback without blocking sponsorship", async () => {
  const diagnostics = {};
  const estimator = createPasskeyFeeEstimator({
    async preEstimateUserOperationGas() { return {}; },
    async postEstimateUserOperationGas(input) { return { verificationGasLimit: input.userOperation.verificationGasLimit }; },
  }, { estimateVerifierGas: async () => { throw new Error("offline https://rpc.example/?apikey=secret"); }, diagnostics });
  const result = await estimator.postEstimateUserOperationGas({ userOperation: { verificationGasLimit: 308_778n } });
  assert.equal(result.verificationGasLimit, 600_000n);
  assert.equal(diagnostics.verifierProbe, "fallback");
  assert.doesNotMatch(JSON.stringify(diagnostics), /secret|https/);
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
    return relay().createTransaction();
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

test("does not retry a deployed relay after an AA24 signature rejection", async () => {
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
        return firstRelay;
      },
    }),
  );

  await assert.rejects(
    session.sendTransaction([{ to: SAFE_ADDRESS, data: "0x" }]),
    /AA24 signature error/,
  );
  assert.equal(initCount, 3);
});

test("submission failures retain gas diagnostics and request only one signature", async () => {
  const instance = relay();
  let signatures = 0;
  let submissions = 0;
  instance.createTransaction = async () => ({ getUserOperation() { return {
    verificationGasLimit: 650_000n, callGasLimit: 1_000_000n, preVerificationGas: 60_000n,
    maxFeePerGas: 123n, maxPriorityFeePerGas: 100n,
    sender: SAFE_ADDRESS, callData: "secret-calldata", signature: "secret-signature",
  }; } });
  instance.signSafeOperation = async (operation) => { signatures++; return operation; };
  instance.executeTransaction = async () => { submissions++; throw new Error("AA24 signature error"); };
  const session = await createPasskeyAccount(
    { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage: createStorage() },
    dependencies({ async initRelay() { return instance; } }),
  );
  await assert.rejects(session.sendTransaction([{ to: SAFE_ADDRESS, data: "0x" }]), (error) => {
    assert.equal(error.passkeyDiagnostics.phase, "submission");
    assert.equal(error.passkeyDiagnostics.aaCode, "AA24");
    assert.equal(error.passkeyDiagnostics.submittedVerificationGas, "650000");
    assert.equal(error.passkeyDiagnostics.submittedMaxFeePerGas, "123");
    assert.doesNotMatch(JSON.stringify(error.passkeyDiagnostics), /secret|sender|callData|signature|0x/);
    return true;
  });
  assert.equal(signatures, 1);
  assert.equal(submissions, 1);
});

test("estimation failures are identified before any passkey signature", async () => {
  const instance = relay();
  instance.createTransaction = async () => { throw new Error("RPC unavailable"); };
  instance.signSafeOperation = async () => { assert.fail("must not sign"); };
  const session = await createPasskeyAccount(
    { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage: createStorage() },
    dependencies({ async initRelay() { return instance; } }),
  );
  await assert.rejects(session.sendTransaction([{ to: SAFE_ADDRESS, data: "0x" }]), (error) => {
    assert.equal(error.passkeyDiagnostics.phase, "estimation");
    return true;
  });
});

test("immediate and prepared actions measure the configured verifier before signing once", async (t) => {
  t.mock.method(PimlicoFeeEstimator.prototype, "postEstimateUserOperationGas", async ({ userOperation }) => ({
    verificationGasLimit: userOperation.verificationGasLimit,
  }));
  for (const prepared of [false, true]) {
    let measured = false;
    let signatures = 0;
    const instance = relay();
    instance.createTransaction = async ({ options }) => {
      const gas = await options.feeEstimator.postEstimateUserOperationGas({ userOperation: { verificationGasLimit: 308_778n } });
      assert.equal(gas.verificationGasLimit, 912_500n);
      return { getUserOperation() { return gas; } };
    };
    instance.signSafeOperation = async (operation) => {
      assert.equal(measured, true);
      signatures++;
      return operation;
    };
    const session = await createPasskeyAccount(
      { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage: createStorage() },
      dependencies({
        async initRelay() { return instance; },
        async estimateVerifierGas(address) { assert.equal(address, VERIFIER_ADDRESS); measured = true; return 650_000n; },
      }),
    );
    const calls = [{ to: SAFE_ADDRESS, data: "0x" }];
    if (prepared) await (await session.prepareTransaction(calls)).send();
    else await session.sendTransaction(calls);
    assert.equal(signatures, 1);
  }
});

test("paymaster failures retain the sponsorship phase and requested budget", async (t) => {
  t.mock.method(PimlicoFeeEstimator.prototype, "postEstimateUserOperationGas", async () => { throw new Error("paymaster unavailable"); });
  const instance = relay();
  instance.createTransaction = async ({ options }) => options.feeEstimator.postEstimateUserOperationGas({userOperation:{verificationGasLimit:308_778n}});
  const session = await createPasskeyAccount(
    { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage: createStorage() },
    dependencies({ async initRelay() { return instance; }, async estimateVerifierGas() { return 356_759n; } }),
  );
  await assert.rejects(session.sendTransaction([{to: SAFE_ADDRESS, data: "0x"}]), (error) => {
    assert.equal(error.passkeyDiagnostics.phase, "sponsorship");
    assert.equal(error.passkeyDiagnostics.requestedVerificationGas, "600000");
    return true;
  });
});

test("binds a deployed passkey client to the Safe shared signer", async () => {
  const metadata = {
    rawId: RAW_ID,
    coordinates: COORDINATES,
    verifierAddress: VERIFIER_ADDRESS,
    safeAddress: SAFE_ADDRESS,
  };
  const externalSigner = {
    key: "passkeyWallet",
    account: { address: getAddress("0x00000000000000000000000000000000000000cc") },
    async signMessage() { return "0x"; },
  };
  const safeProvider = {
    signer: { rawId: RAW_ID },
    async getExternalSigner() { return externalSigner; },
  };
  const instance = relay(SAFE_ADDRESS, safeProvider);

  await restorePasskeyAccount(
    { metadata, rpId: "app.kettigo.xyz" },
    dependencies({
      async getCode() { return "0x6000"; },
      async initRelay() { return instance; },
    }),
  );

  assert.equal(safeProvider.signer, externalSigner);
  assert.equal(externalSigner.account.address, SHARED_SIGNER_ADDRESS);
});

test("wraps a deployed passkey signature as a shared-signer contract signature", async () => {
  const metadata = {
    rawId: RAW_ID,
    coordinates: COORDINATES,
    verifierAddress: VERIFIER_ADDRESS,
    safeAddress: SAFE_ADDRESS,
  };
  const instance = relay();
  let submitted;
  instance.executeTransaction = async ({ executable }) => {
    submitted = [...executable.signatures.values()][0];
    return `0x${"33".repeat(32)}`;
  };

  const session = await restorePasskeyAccount(
    { metadata, rpId: "app.kettigo.xyz" },
    dependencies({
      async getCode() {
        return "0x6000";
      },
      async initRelay() {
        return instance;
      },
    }),
  );

  await session.sendTransaction([{ to: SAFE_ADDRESS, data: "0x" }]);
  assert.equal(submitted.signer, SHARED_SIGNER_ADDRESS);
  assert.equal(submitted.data, "0x1234");
  assert.equal(submitted.isContractSignature, true);
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
  await assert.rejects(prepared.send(), /review your transaction/);
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
  await assert.rejects(prepared.send(), /review your transaction/);
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
