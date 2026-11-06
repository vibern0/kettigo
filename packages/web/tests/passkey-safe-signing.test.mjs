import {
  assert,
  test,
  EthSafeSignature,
  PimlicoFeeEstimator,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  hashTypedData,
  RpcRequestError,
  entryPoint07Abi,
  entryPoint07Address,
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

import {
  buildPasskeySigner,
  createPasskeyAccount,
  getSafeUserOperationIdentity,
  restorePasskeyAccount,
  SafeUserOperationNotSubmittedError,
  SafeUserOperationPendingError,
  SafeUserOperationRejectedError,
  signSafeTypedData,
  waitForUserOperationTransaction,
} from "../src/lib/passkey-safe.ts";

test("immediate and prepared actions measure the configured verifier before signing once", async (t) => {
  t.mock.method(
    PimlicoFeeEstimator.prototype,
    "postEstimateUserOperationGas",
    async ({ userOperation }) => ({
      verificationGasLimit: userOperation.verificationGasLimit,
    }),
  );
  for (const prepared of [false, true]) {
    let measured = false;
    let signatures = 0;
    const instance = relay();
    instance.createTransaction = async ({ options }) => {
      const gas = await options.feeEstimator.postEstimateUserOperationGas({
        userOperation: { verificationGasLimit: 308_778n },
      });
      assert.equal(gas.verificationGasLimit, 912_500n);
      return {
        getUserOperation() {
          return { ...finalUserOperation(), ...gas };
        },
      };
    };
    instance.signSafeOperation = async (operation) => {
      assert.equal(measured, true);
      signatures++;
      return operation;
    };
    instance.executeTransaction = async ({ executable }) =>
      getSafeUserOperationIdentity(executable.getUserOperation()).userOperationHash;
    instance.getUserOperationReceipt = async (hash) => ({
      success: true,
      userOpHash: hash,
      sender: SAFE_ADDRESS,
      receipt: { transactionHash: hash },
    });
    const session = await createPasskeyAccount(
      { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage: createStorage() },
      dependencies({
        async initRelay() {
          return instance;
        },
        async getTransactionReceipt({ hash }) {
          const topics = encodeEventTopics({
            abi: entryPoint07Abi,
            eventName: "UserOperationEvent",
            args: {
              userOpHash: hash,
              sender: SAFE_ADDRESS,
              paymaster: "0x0000000000000000000000000000000000000000",
              nonce: 0n,
              success: true,
              actualGasCost: 1n,
              actualGasUsed: 1n,
            },
          });
          const blockHash = `0x${"55".repeat(32)}`;
          return {
            transactionHash: hash,
            status: "success",
            blockHash,
            blockNumber: 42n,
            logs: [
              {
                address: getAddress(entryPoint07Address),
                topics,
                data: encodeAbiParameters(
                  [{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }],
                  [0n, true, 1n, 1n],
                ),
              },
            ],
          };
        },
        async estimateVerifierGas(address) {
          assert.equal(address, VERIFIER_ADDRESS);
          measured = true;
          return 650_000n;
        },
      }),
    );
    const calls = [{ to: SAFE_ADDRESS, data: "0x" }];
    if (prepared) await (await session.prepareTransaction(calls)).send();
    else await session.sendTransaction(calls);
    assert.equal(signatures, 1);
  }
});

test("paymaster failures retain the sponsorship phase and requested budget", async (t) => {
  t.mock.method(PimlicoFeeEstimator.prototype, "postEstimateUserOperationGas", async () => {
    throw new Error("paymaster unavailable");
  });
  const instance = relay();
  instance.createTransaction = async ({ options }) =>
    options.feeEstimator.postEstimateUserOperationGas({
      userOperation: { verificationGasLimit: 308_778n },
    });
  const session = await createPasskeyAccount(
    { rpId: "app.kettigo.xyz", rpName: "Kettigo", storage: createStorage() },
    dependencies({
      async initRelay() {
        return instance;
      },
      async estimateVerifierGas() {
        return 356_759n;
      },
    }),
  );
  await assert.rejects(session.sendTransaction([{ to: SAFE_ADDRESS, data: "0x" }]), (error) => {
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
    async signMessage() {
      return "0x";
    },
  };
  const safeProvider = {
    signer: { rawId: RAW_ID },
    async getExternalSigner() {
      return externalSigner;
    },
  };
  const instance = relay(SAFE_ADDRESS, safeProvider);

  await restorePasskeyAccount(
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
    return "0x60a9c26f9c932173953974fad9377bd05b94e7af3f01dfdb93482ac70b4265a5";
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
      {
        async getUserOperationReceipt() {
          return { success: false, receipt: { transactionHash: `0x${"55".repeat(32)}` } };
        },
      },
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
    {
      rawId: RAW_ID,
      coordinates: COORDINATES,
      verifierAddress: VERIFIER_ADDRESS,
      safeAddress: SAFE_ADDRESS,
    },
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
        instance.createTransaction = async () => {
          events.push("prepare");
          return relay().createTransaction();
        };
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
  const pending = prepared.send({
    onSigned() {
      events.push("signed");
    },
  });
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
        instance.signSafeOperation = async (operation) => {
          await options.signer.getFn({});
          return operation;
        };
        instance.executeTransaction = async () => {
          submissions++;
          return "0x";
        };
        return instance;
      },
      async getCredential() {
        credentials++;
        return { id: "credential" };
      },
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
        instance.signSafeOperation = async () => {
          throw new Error("RPC unavailable");
        };
        return instance;
      },
      async getCredential() {
        assert.fail("must not request credentials");
      },
    }),
  );
  await assert.rejects(
    session.prepareTransaction([{ to: SAFE_ADDRESS, data: "0x" }]),
    /RPC unavailable/,
  );
});

test("binds the final operation sender before observing or submitting", async () => {
  const events = [];
  const instance = relay();
  instance.signSafeOperation = async () => ({
    getUserOperation() {
      return finalUserOperation(getAddress("0x00000000000000000000000000000000000000cc"));
    },
  });
  instance.executeTransaction = async () => {
    events.push("send");
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
      onOperationPrepared() {
        events.push("observe");
      },
    }),
    /not for this Safe/i,
  );
  assert.deepEqual(events, []);
});

test("awaits the frozen observer before one submission and stops on observer failure", async () => {
  const instance = relay();
  const events = [];
  const hash = getSafeUserOperationIdentity(finalUserOperation()).userOperationHash;
  instance.executeTransaction = async () => {
    events.push("send");
    return hash;
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
      async onOperationPrepared(identity) {
        events.push("observe");
        assert.equal(Object.isFrozen(identity), true);
        throw new Error("observer unavailable");
      },
    }),
    (error) =>
      error instanceof SafeUserOperationNotSubmittedError &&
      error.operation.userOperationHash === hash,
  );
  assert.deepEqual(events, ["observe"]);
});

test("uses only a genuine eth_sendUserOperation RpcRequestError as a definitive rejection", async () => {
  const hash = getSafeUserOperationIdentity(finalUserOperation()).userOperationHash;
  const cases = [
    {
      name: "genuine submission rejection",
      error: new RpcRequestError({
        body: { method: "eth_sendUserOperation", params: [] },
        error: { code: -32500, message: "validation failed" },
        url: "https://bundler.invalid",
      }),
      expected: SafeUserOperationRejectedError,
    },
    {
      name: "lookalike rejection",
      error: { name: "RpcRequestError", code: -32500, message: "validation failed" },
      expected: SafeUserOperationPendingError,
    },
    {
      name: "unrelated rpc method",
      error: new RpcRequestError({
        body: { method: "eth_getBalance", params: [] },
        error: { code: -32500, message: "validation failed" },
        url: "https://bundler.invalid",
      }),
      expected: SafeUserOperationPendingError,
    },
  ];
  for (const scenario of cases) {
    const instance = relay();
    instance.executeTransaction = async () => {
      throw scenario.error;
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
      (error) => error instanceof scenario.expected && error.operation.userOperationHash === hash,
      scenario.name,
    );
  }
});
