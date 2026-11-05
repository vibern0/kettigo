import {
  assert,
  test,
  delay,
  getAddress,
  SAFE_ADDRESS,
  VERIFIER_ADDRESS,
  SHARED_SIGNER_ADDRESS,
  RAW_ID,
  COORDINATES,
  createStorage,
  dependencies,
  relay,
  finalUserOperation,
} from "./passkey-safe-fixtures.mjs";

import { createPasskeyAccount, restorePasskeyAccount } from "../src/lib/passkey-safe.ts";

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
  assert.equal(
    initOptions.customContracts.entryPointAddress.toLowerCase(),
    "0x0000000071727de22e5e9d8baf0edac6f37da032",
  );
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

  for (const [code, expectedKey] of [
    ["0x", "owners"],
    ["0x6000", "safeAddress"],
  ]) {
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
  const submission = new Promise((resolve) => {
    release = resolve;
  });
  const instance = relay();
  let signed = false;
  instance.executeTransaction = async () => {
    assert.equal(signed, true);
    await submission;
    return "0x60a9c26f9c932173953974fad9377bd05b94e7af3f01dfdb93482ac70b4265a5";
  };
  const session = await createPasskeyAccount(
    { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage: createStorage() },
    dependencies({
      async initRelay() {
        return instance;
      },
    }),
  );
  const pending = session.sendTransaction([{ to: SAFE_ADDRESS, data: "0x" }], {
    onSigned() {
      signed = true;
    },
  });
  await delay(0);
  assert.equal(signed, true);
  release();
  assert.equal(await pending, `0x${"44".repeat(32)}`);
});

test("does not hand off or submit when signing is cancelled", async () => {
  const instance = relay();
  let signed = false;
  let submitted = false;
  instance.signSafeOperation = async () => {
    throw new Error("Approval cancelled");
  };
  instance.executeTransaction = async () => {
    submitted = true;
    return "0x";
  };
  const session = await createPasskeyAccount(
    { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage: createStorage() },
    dependencies({
      async initRelay() {
        return instance;
      },
    }),
  );
  await assert.rejects(
    session.sendTransaction([{ to: SAFE_ADDRESS, data: "0x" }], {
      onSigned() {
        signed = true;
      },
    }),
    /Approval cancelled/,
  );
  assert.equal(signed, false);
  assert.equal(submitted, false);
});

test("reconnects through the deployed Safe after the first mined action", async () => {
  const storage = createStorage();
  const initOptions = [];
  let firstRelayCalls = 0;
  let secondRelayCalls = 0;
  const relays = [relay(), relay(), relay(), relay()];
  for (const [index, instance] of relays.entries()) {
    const original = instance.createTransaction;
    instance.createTransaction = async (...args) => {
      if (index === 0) firstRelayCalls += 1;
      else secondRelayCalls += 1;
      return original(...args);
    };
  }

  const session = await createPasskeyAccount(
    { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage },
    dependencies({
      async getCode() {
        return "0x6000";
      },
      async initRelay(options) {
        initOptions.push(options);
        return relays[initOptions.length - 1];
      },
    }),
  );

  const calls = [{ to: SAFE_ADDRESS, data: "0x" }];
  await session.sendTransaction(calls);
  await session.sendTransaction(calls);

  assert.equal(initOptions.length, 4);
  assert.equal(initOptions[2].options.safeAddress, SAFE_ADDRESS);
  assert.equal(
    initOptions[2].customContracts.safeWebAuthnSharedSignerAddress,
    SHARED_SIGNER_ADDRESS,
  );
  assert.deepEqual([firstRelayCalls, secondRelayCalls], [0, 2]);
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
      async getCode() {
        return "0x6000";
      },
      async initRelay() {
        initCount += 1;
        if (initCount <= 2) return relay();
        if (initCount === 3) throw new Error("temporary RPC failure");
        return deployedRelay;
      },
    }),
  );
  const calls = [{ to: SAFE_ADDRESS, data: "0x" }];

  assert.equal(await session.sendTransaction(calls), `0x${"44".repeat(32)}`);
  assert.equal(initCount, 2);
  await assert.rejects(session.sendTransaction(calls), /temporary RPC failure/);
  assert.equal(deployedCalls, 0);
  assert.equal(await session.sendTransaction(calls), `0x${"44".repeat(32)}`);
  assert.equal(initCount, 5);
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
  assert.equal(initCount, 4);
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
        if (initCount < 4) return relay();
        return firstRelay;
      },
    }),
  );

  await assert.rejects(
    session.sendTransaction([{ to: SAFE_ADDRESS, data: "0x" }]),
    /still pending/,
  );
  assert.equal(initCount, 4);
});

test("submission failures retain gas diagnostics and request only one signature", async () => {
  const instance = relay();
  let signatures = 0;
  let submissions = 0;
  instance.createTransaction = async () => ({
    getUserOperation() {
      return {
        ...finalUserOperation(),
        verificationGasLimit: 650_000n,
        callGasLimit: 1_000_000n,
        preVerificationGas: 60_000n,
        maxFeePerGas: 123n,
        maxPriorityFeePerGas: 100n,
        callData: "secret-calldata",
        signature: "secret-signature",
      };
    },
  });
  instance.signSafeOperation = async (operation) => {
    signatures++;
    return operation;
  };
  instance.executeTransaction = async () => {
    submissions++;
    throw new Error("AA24 signature error");
  };
  const session = await createPasskeyAccount(
    { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage: createStorage() },
    dependencies({
      async initRelay() {
        return instance;
      },
    }),
  );
  await assert.rejects(session.sendTransaction([{ to: SAFE_ADDRESS, data: "0x" }]), (error) => {
    assert.equal(error.passkeyDiagnostics.phase, "submission");
    assert.equal(error.passkeyDiagnostics.aaCode, "AA24");
    assert.equal(error.passkeyDiagnostics.submittedVerificationGas, "650000");
    assert.equal(error.passkeyDiagnostics.submittedMaxFeePerGas, "123");
    assert.doesNotMatch(
      JSON.stringify(error.passkeyDiagnostics),
      /secret|sender|callData|signature|0x/,
    );
    return true;
  });
  assert.equal(signatures, 1);
  assert.equal(submissions, 1);
});

test("estimation failures are identified before any passkey signature", async () => {
  const instance = relay();
  instance.createTransaction = async () => {
    throw new Error("RPC unavailable");
  };
  instance.signSafeOperation = async () => {
    assert.fail("must not sign");
  };
  const session = await createPasskeyAccount(
    { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage: createStorage() },
    dependencies({
      async initRelay() {
        return instance;
      },
    }),
  );
  await assert.rejects(session.sendTransaction([{ to: SAFE_ADDRESS, data: "0x" }]), (error) => {
    assert.equal(error.passkeyDiagnostics.phase, "estimation");
    return true;
  });
});
