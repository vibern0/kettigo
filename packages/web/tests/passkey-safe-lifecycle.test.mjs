import {
  assert,
  test,
  delay,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  entryPoint07Abi,
  entryPoint07Address,
  SAFE_ADDRESS,
  VERIFIER_ADDRESS,
  RAW_ID,
  COORDINATES,
  createStorage,
  dependencies,
  relay,
  finalUserOperation,
} from "./passkey-safe-fixtures.mjs";

import {
  createPasskeyAccount,
  getSafeUserOperationIdentity,
  restorePasskeyAccount,
  SafeUserOperationNotSubmittedError,
  SafeUserOperationPendingError,
} from "../src/lib/passkey-safe.ts";

test("anchors a successful operation to its EntryPoint v0.7 event and canonical block", async () => {
  const operation = Object.freeze({
    chainId: 11155111,
    entryPoint: getAddress(entryPoint07Address),
    sender: SAFE_ADDRESS,
    userOperationHash: `0x${"33".repeat(32)}`,
  });
  const transactionHash = `0x${"44".repeat(32)}`;
  const blockHash = `0x${"55".repeat(32)}`;
  const topics = encodeEventTopics({
    abi: entryPoint07Abi,
    eventName: "UserOperationEvent",
    args: {
      userOpHash: operation.userOperationHash,
      sender: SAFE_ADDRESS,
      paymaster: "0x0000000000000000000000000000000000000000",
      nonce: 0n,
      success: true,
      actualGasCost: 1n,
      actualGasUsed: 1n,
    },
  });
  const data = encodeAbiParameters(
    [{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }],
    [0n, true, 1n, 1n],
  );
  const session = await createPasskeyAccount(
    { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage: createStorage() },
    dependencies({
      async getTransactionReceipt() {
        return {
          transactionHash,
          status: "success",
          blockHash,
          blockNumber: 42n,
          logs: [
            {
              topics,
              data,
              address: getAddress(entryPoint07Address),
              transactionHash,
              blockHash,
              blockNumber: 42n,
            },
          ],
        };
      },
      async getBlock() {
        return { hash: blockHash, number: 42n };
      },
      async initRelay() {
        const instance = relay();
        instance.getUserOperationReceipt = async () => ({
          success: true,
          userOpHash: operation.userOperationHash,
          sender: SAFE_ADDRESS,
          receipt: { transactionHash },
        });
        return instance;
      },
    }),
  );

  assert.deepEqual(await session.lookupUserOperation(operation), {
    state: "confirmed",
    operation,
    transactionHash,
    blockNumber: 42n,
    blockHash,
  });
});

test("polls the expected submitted hash until canonical confirmation", async () => {
  const instance = relay();
  const expectedHash = getSafeUserOperationIdentity(finalUserOperation()).userOperationHash;
  const events = [];
  let receipts = 0;
  instance.executeTransaction = async () => {
    events.push("send");
    return expectedHash;
  };
  instance.getUserOperationReceipt = async (hash) => {
    events.push(`read:${hash}`);
    receipts += 1;
    return receipts === 1
      ? null
      : {
          success: true,
          userOpHash: expectedHash,
          sender: SAFE_ADDRESS,
          receipt: { transactionHash: `0x${"44".repeat(32)}` },
        };
  };
  const session = await createPasskeyAccount(
    { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage: createStorage() },
    dependencies({
      receiptTimeoutMs: 50,
      receiptPollMs: 0,
      async sleep() {
        events.push("sleep");
      },
      async initRelay() {
        return instance;
      },
    }),
  );
  assert.equal(
    await session.sendTransaction([{ to: SAFE_ADDRESS, data: "0x" }]),
    `0x${"44".repeat(32)}`,
  );
  assert.deepEqual(events, ["send", `read:${expectedHash}`, "sleep", `read:${expectedHash}`]);
});

test("does not poll a returned hash that differs from the signed operation", async () => {
  const instance = relay();
  let receiptReads = 0;
  instance.executeTransaction = async () => `0x${"99".repeat(32)}`;
  instance.getUserOperationReceipt = async () => {
    receiptReads += 1;
    return null;
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
    session.sendTransaction([{ to: SAFE_ADDRESS, data: "0x" }]),
    /different operation hash/i,
  );
  assert.equal(receiptReads, 0);
});

test("bounds a non-cooperative polling sleep and preserves the submitted identity", async () => {
  const instance = relay();
  const expectedHash = getSafeUserOperationIdentity(finalUserOperation()).userOperationHash;
  let receiptReads = 0;
  instance.executeTransaction = async () => expectedHash;
  instance.getUserOperationReceipt = async () => {
    receiptReads += 1;
    return null;
  };
  const session = await createPasskeyAccount(
    { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage: createStorage() },
    dependencies({
      receiptTimeoutMs: 15,
      receiptPollMs: 0,
      sleep: () => new Promise(() => {}),
      async initRelay() {
        return instance;
      },
    }),
  );
  await assert.rejects(
    session.sendTransaction([{ to: SAFE_ADDRESS, data: "0x" }]),
    (error) =>
      error instanceof SafeUserOperationPendingError &&
      error.operation.userOperationHash === expectedHash,
  );
  assert.equal(receiptReads, 1);
});

test("a restored counterfactual lookup selects a deployed relay only after code is observed", async () => {
  const metadata = {
    rawId: RAW_ID,
    coordinates: COORDINATES,
    verifierAddress: VERIFIER_ADDRESS,
    safeAddress: SAFE_ADDRESS,
  };
  const firstRelay = relay();
  const refreshedRelay = relay();
  let initialCreates = 0;
  let sends = 0;
  let initCount = 0;
  firstRelay.createTransaction = async () => {
    initialCreates += 1;
    return relay().createTransaction();
  };
  firstRelay.executeTransaction = async () => {
    sends += 1;
    return "0x";
  };
  const session = await restorePasskeyAccount(
    { metadata, rpId: "app.kettigo.xyz" },
    dependencies({
      async getCode() {
        return "0x6000";
      },
      async initRelay(options) {
        initCount += 1;
        if (initCount === 1) return firstRelay;
        assert.equal(options.options.safeAddress, SAFE_ADDRESS);
        return refreshedRelay;
      },
    }),
  );
  const operation = getSafeUserOperationIdentity(finalUserOperation());
  assert.equal((await session.lookupUserOperation(operation)).state, "confirmed");
  assert.equal(initialCreates, 0);
  assert.equal(sends, 0);
  await session.sendTransaction([{ to: SAFE_ADDRESS, data: "0x" }]);
  assert.equal(initCount, 4);
});

test("bounds a stalled send once and keeps its identity pending without late polling", async () => {
  const instance = relay();
  const expectedHash = getSafeUserOperationIdentity(finalUserOperation()).userOperationHash;
  let resolveSend;
  let receiptReads = 0;
  let sends = 0;
  instance.executeTransaction = async () => {
    sends += 1;
    return new Promise((resolve) => {
      resolveSend = resolve;
    });
  };
  instance.getUserOperationReceipt = async () => {
    receiptReads += 1;
    return null;
  };
  const session = await createPasskeyAccount(
    { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage: createStorage() },
    dependencies({
      receiptTimeoutMs: 15,
      async initRelay() {
        return instance;
      },
    }),
  );
  await assert.rejects(
    session.sendTransaction([{ to: SAFE_ADDRESS, data: "0x" }]),
    (error) =>
      error instanceof SafeUserOperationPendingError &&
      error.operation.userOperationHash === expectedHash,
  );
  resolveSend(expectedHash);
  await delay(0);
  assert.equal(sends, 1);
  assert.equal(receiptReads, 0);
});

test("onSigned failure retains identity and prevents execution", async () => {
  const instance = relay();
  const expectedHash = getSafeUserOperationIdentity(finalUserOperation()).userOperationHash;
  let sends = 0;
  instance.executeTransaction = async () => {
    sends += 1;
    return expectedHash;
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
        throw new Error("persist failed");
      },
    }),
    (error) =>
      error instanceof SafeUserOperationNotSubmittedError &&
      error.operation.userOperationHash === expectedHash,
  );
  assert.equal(sends, 0);
});

test("preparation refreshes recovered counterfactual deployment mode from observed code", async () => {
  for (const [code, deployed] of [
    ["0x6000", true],
    ["0x", false],
  ]) {
    let initCount = 0;
    const metadata = {
      rawId: RAW_ID,
      coordinates: COORDINATES,
      verifierAddress: VERIFIER_ADDRESS,
      safeAddress: SAFE_ADDRESS,
    };
    const session = await restorePasskeyAccount(
      { metadata, rpId: "app.kettigo.xyz" },
      dependencies({
        async getCode() {
          return code;
        },
        async initRelay(options) {
          initCount += 1;
          if (initCount === 1) return relay();
          if (initCount === 2 && !deployed) return relay();
          assert.equal("safeAddress" in options.options, deployed);
          const instance = relay();
          instance.signSafeOperation = async (operation) => {
            await options.signer.getFn({});
            return operation;
          };
          return instance;
        },
      }),
    );
    await session.lookupUserOperation(getSafeUserOperationIdentity(finalUserOperation()));
    const prepared = await session.prepareTransaction([{ to: SAFE_ADDRESS, data: "0x" }]);
    prepared.cancel();
  }
});

test("failed deployment probes stop preparation and permit an explicit retry", async () => {
  for (const probe of [
    async () => {
      throw new Error("rpc unavailable");
    },
    () => new Promise(() => {}),
  ]) {
    let probeCount = 0;
    let signingCalls = 0;
    let transactionCalls = 0;
    const session = await createPasskeyAccount(
      { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage: createStorage() },
      dependencies({
        receiptTimeoutMs: 10,
        async getCode() {
          probeCount += 1;
          if (probeCount === 1) return probe();
          return "0x6000";
        },
        async initRelay(options) {
          const instance = relay();
          instance.createTransaction = async (...args) => {
            transactionCalls += 1;
            return relay().createTransaction(...args);
          };
          instance.signSafeOperation = async (operation) => {
            signingCalls += 1;
            await options.signer.getFn({});
            return operation;
          };
          return instance;
        },
      }),
    );
    await session.lookupUserOperation(getSafeUserOperationIdentity(finalUserOperation()));
    await assert.rejects(session.prepareTransaction([{ to: SAFE_ADDRESS, data: "0x" }]));
    assert.equal(transactionCalls, 0);
    assert.equal(signingCalls, 0);
    const prepared = await session.prepareTransaction([{ to: SAFE_ADDRESS, data: "0x" }]);
    prepared.cancel();
    assert.equal(transactionCalls, 1);
  }
});

test("counterfactual recovery switches to deployed mode only after code appears", async () => {
  let codeReads = 0;
  let preparedWithDeployedRelay = false;
  const metadata = {
    rawId: RAW_ID,
    coordinates: COORDINATES,
    verifierAddress: VERIFIER_ADDRESS,
    safeAddress: SAFE_ADDRESS,
  };
  const session = await restorePasskeyAccount(
    { metadata, rpId: "app.kettigo.xyz" },
    dependencies({
      async getCode() {
        codeReads += 1;
        return codeReads === 1 ? "0x" : "0x6000";
      },
      async initRelay(options) {
        const instance = relay();
        if (codeReads > 1) preparedWithDeployedRelay = "safeAddress" in options.options;
        instance.signSafeOperation = async (operation) => {
          await options.signer.getFn({});
          return operation;
        };
        return instance;
      },
    }),
  );
  await session.lookupUserOperation(getSafeUserOperationIdentity(finalUserOperation()));
  const prepared = await session.prepareTransaction([{ to: SAFE_ADDRESS, data: "0x" }]);
  prepared.cancel();
  assert.equal(preparedWithDeployedRelay, true);
});
