import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { URL } from "node:url";
import { getAddress } from "ethers";
import { Interface, concat, toBeHex } from "ethers";

import { CandidateRunJournal, ORIGINAL_ENVELOPE } from "./journal.mjs";
import {
  SafeBudgetAdapter,
  canonicalizeUserOperation,
  deterministicUserOperationRecord,
  mergePinnedRelayEstimations,
} from "./safe-budget-adapter.mjs";
import { createFixedSafeCallPolicy } from "./safe-call-policy.mjs";

const requireWeb = createRequire(new URL("../../../../web/package.json", import.meta.url));
const { SafeOperationV07, getRelayKitVersion } = requireWeb("@safe-global/relay-kit");
const { delegateForUserDecryptionContract } = requireWeb("@zama-fhe/sdk");
const { encodeFunctionData } = requireWeb("viem");

const SAFE = "0x1111111111111111111111111111111111111111";
const ENTRY_POINT = getAddress("0x0000000071727de22e5e9d8baf0edac6f37da032");
const POOL = "0x2222222222222222222222222222222222222222";
const SIGNATURE = "0x1234";
const HASH = "0x" + "ab".repeat(32);
const MODULE = "0x4444444444444444444444444444444444444444";
const MULTISEND = "0x5555555555555555555555555555555555555555";
const WRAPPER = "0x6666666666666666666666666666666666666666";
const USDC = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ACL = "0x7777777777777777777777777777777777777777";
const DELEGATE = "0x8888888888888888888888888888888888888888";
const FACTORY = "0x9999999999999999999999999999999999999999";
const EXECUTE = new Interface([
  "function executeUserOp(address to,uint256 value,bytes data,uint8 operation)",
]);
const MULTISEND_ABI = new Interface(["function multiSend(bytes transactions)"]);
const WRAPPER_ABI = new Interface([
  "function wrap(address to,uint256 amount)",
  "function confidentialTransferAndCall(address to,bytes32 encryptedAmount,bytes inputProof,bytes data)",
  "function multicall(bytes[] data)",
]);
const ERC20_ABI = new Interface(["function approve(address spender,uint256 amount)"]);

function packedCall({ operation = 0, to, value = 0n, data }) {
  return concat([
    toBeHex(operation, 1),
    to,
    toBeHex(value, 32),
    toBeHex((data.length - 2) / 2, 32),
    data,
  ]);
}

function fixedCallFixture({
  pool = POOL,
  delegatedContract = WRAPPER,
  spender = WRAPPER,
  proof = "0x1234",
} = {}) {
  const handle = "0x" + "11".repeat(32);
  const wrapData = WRAPPER_ABI.encodeFunctionData("wrap", [SAFE, 7n]);
  const transferData = WRAPPER_ABI.encodeFunctionData("confidentialTransferAndCall", [
    pool,
    handle,
    proof,
    "0x",
  ]);
  const wrapperData = WRAPPER_ABI.encodeFunctionData("multicall", [[wrapData, transferData]]);
  const aclData = encodeFunctionData(
    delegateForUserDecryptionContract(ACL, DELEGATE, delegatedContract, 123n),
  );
  const approveData = ERC20_ABI.encodeFunctionData("approve", [spender, 7n]);
  const calls = [
    { to: USDC, value: 0n, data: approveData },
    { to: ACL, value: 0n, data: aclData },
    { to: WRAPPER, value: 0n, data: wrapperData },
  ];
  const multiSendData = MULTISEND_ABI.encodeFunctionData("multiSend", [
    concat(calls.map(packedCall)),
  ]);
  const callData = EXECUTE.encodeFunctionData("executeUserOp", [MULTISEND, 0n, multiSendData, 1]);
  const directCallData = EXECUTE.encodeFunctionData("executeUserOp", [WRAPPER, 0n, wrapperData, 0]);
  return {
    handle,
    proof,
    pool,
    delegatedContract,
    spender,
    calls,
    callData,
    directCallData,
    wrapperData,
    aclData,
  };
}

function policyFor(fixture) {
  return createFixedSafeCallPolicy({
    module: MODULE,
    multiSend: MULTISEND,
    deployedCalls: [fixture.calls[2]],
    counterfactual: { factory: FACTORY, factoryData: "0xaabb", calls: fixture.calls },
    roles: {
      deposit: {
        token: WRAPPER,
        user: SAFE,
        pool: fixture.pool,
        amount: 7n,
        handle: fixture.handle,
        proof: fixture.proof,
      },
      delegations: [
        { acl: ACL, delegate: DELEGATE, contract: fixture.delegatedContract, expiration: 123n },
      ],
      approvals: [{ token: USDC, spender: fixture.spender, amount: 7n }],
    },
  });
}

function executeBatch(calls) {
  return EXECUTE.encodeFunctionData("executeUserOp", [
    MULTISEND,
    0n,
    MULTISEND_ABI.encodeFunctionData("multiSend", [concat(calls.map(packedCall))]),
    1,
  ]);
}

function wrongWrapperDeposit(fixture) {
  return WRAPPER_ABI.encodeFunctionData("multicall", [
    [
      WRAPPER_ABI.encodeFunctionData("wrap", [POOL, 7n]),
      WRAPPER_ABI.encodeFunctionData("confidentialTransferAndCall", [
        POOL,
        fixture.handle,
        fixture.proof,
        "0x",
      ]),
    ],
  ]);
}

function operation(overrides = {}) {
  return {
    sender: SAFE,
    nonce: 0n,
    factory: "0x",
    factoryData: "0x",
    callData: "0x1234",
    callGasLimit: 1n,
    verificationGasLimit: 2n,
    preVerificationGas: 3n,
    maxFeePerGas: 4n,
    maxPriorityFeePerGas: 1n,
    paymaster: "0x",
    paymasterVerificationGasLimit: 0n,
    paymasterPostOpGasLimit: 0n,
    paymasterData: "0x",
    signature: "0x",
    ...overrides,
  };
}

async function journal(options = {}) {
  return CandidateRunJournal.open({
    directory: await mkdtemp(join(tmpdir(), "kettigo-safe-budget-")),
    envelope: ORIGINAL_ENVELOPE,
    now: () => 1000,
    ...options,
  });
}

function adapter(journal, options = {}) {
  return new SafeBudgetAdapter({
    journal,
    expected: { chainId: 11155111, entryPoint: ENTRY_POINT, safe: SAFE, journalTarget: POOL },
    callPolicy: {
      assert: ({ callData }) => {
        if (callData !== "0x1234") throw new Error("unapproved nested call target");
      },
    },
    identity: () => ({
      chainId: 11155111,
      entryPoint: ENTRY_POINT,
      sender: SAFE,
      userOperationHash: HASH,
    }),
    now: () => 1000,
    ...options,
  });
}

test("canonicalizes every v0.7 field and refuses unknown or incoherent optional fields", () => {
  const result = canonicalizeUserOperation(operation());
  assert.equal(result.maxFeePerGas, "4");
  assert.equal(result.signature, "0x");
  assert.equal(result.worstFeeWei, 24n);
  assert.throws(() => canonicalizeUserOperation({ ...operation(), unknown: 1n }), /unknown/);
  assert.throws(() => canonicalizeUserOperation(operation({ factory: SAFE })), /factory/);
  assert.throws(() => canonicalizeUserOperation(operation({ paymaster: SAFE })), /paymaster/);
});

test("matches the pinned Relay Kit 6.1.1 sponsored merge, including its truthy zero behavior", () => {
  assert.equal(getRelayKitVersion(), "6.1.1");
  const base = operation();
  const estimations = {
    maxFeePerGas: 9n,
    maxPriorityFeePerGas: 2n,
    verificationGasLimit: 8n,
    preVerificationGas: 7n,
    callGasLimit: 6n,
    paymasterPostOpGasLimit: 5n,
    paymasterVerificationGasLimit: 4n,
    paymaster: POOL,
    paymasterData: "0xabcd",
  };
  const sdk = new SafeOperationV07(base, {
    chainId: 11155111,
    entryPoint: ENTRY_POINT,
    moduleAddress: SAFE,
    validAfter: 0,
    validUntil: 0,
  });
  sdk.addEstimations(estimations);
  assert.deepEqual(mergePinnedRelayEstimations(base, estimations), sdk.userOperation);
  sdk.addEstimations({ maxFeePerGas: 0n, paymasterData: "" });
  assert.equal(sdk.userOperation.maxFeePerGas, 9n);
  assert.equal(
    mergePinnedRelayEstimations(sdk.userOperation, { maxFeePerGas: 0n }).maxFeePerGas,
    9n,
  );
  assert.throws(() => mergePinnedRelayEstimations(base, { chainId: 1 }), /unknown sponsor/);
});

test("fixed Safe policy binds real wrapper/ACL roles for direct, batch, deployed, and counterfactual operations", () => {
  const fixture = fixedCallFixture();
  const policy = policyFor(fixture);
  assert.doesNotThrow(() =>
    policy.assert({ factory: FACTORY, factoryData: "0xaabb", callData: fixture.callData }),
  );
  assert.doesNotThrow(() =>
    policy.assert({ factory: "0x", factoryData: "0x", callData: fixture.directCallData }),
  );
  const forbidden = executeBatch([
    { to: "0xAdB8F835E565aC7e71d2DF6cFBd0FC003fa22C27", data: fixture.aclData },
    fixture.calls[2],
  ]);
  assert.throws(
    () => policy.assert({ factory: FACTORY, factoryData: "0xaabb", callData: forbidden }),
    /forbidden|expected/,
  );
  const altered = executeBatch([
    fixture.calls[0],
    fixture.calls[1],
    { to: WRAPPER, data: wrongWrapperDeposit(fixture) },
  ]);
  assert.throws(
    () => policy.assert({ factory: FACTORY, factoryData: "0xaabb", callData: altered }),
    /roles|expected/,
  );
});

test("denies forbidden decoded wrapper, ACL, and approval roles even when expected roles agree", () => {
  for (const forbidden of [
    "0xe65D6459a7Ce01315FbB0998C37233c6FeE3aB8b",
    "0x9c23E5f7143612dc1232FC643A57300291e0d719",
    "0xAdB8F835E565aC7e71d2DF6cFBd0FC003fa22C27",
  ]) {
    for (const override of [
      { pool: forbidden },
      { delegatedContract: forbidden },
      { spender: forbidden },
    ]) {
      const fixture = fixedCallFixture(override);
      assert.throws(
        () =>
          policyFor(fixture).assert({
            factory: FACTORY,
            factoryData: "0xaabb",
            callData: fixture.callData,
          }),
        /forbidden/,
      );
    }
  }
});

test("accepts opaque proof bytes that merely contain a forbidden address", () => {
  const proof = "0x" + "AdB8F835E565aC7e71d2DF6cFBd0FC003fa22C27".slice(2).toLowerCase() + "00";
  const fixture = fixedCallFixture({ proof });
  assert.doesNotThrow(() =>
    policyFor(fixture).assert({
      factory: FACTORY,
      factoryData: "0xaabb",
      callData: fixture.callData,
    }),
  );
});

test("reserves the complete unsigned operation before any credential and binds signature persistence", async () => {
  const j = await journal();
  const events = [];
  const fence = adapter(j, { marker: (stage) => events.push(stage) });
  const reservation = await fence.reserve({
    intentId: "safe-1",
    operation: operation(),
    offeredAt: 1000,
  });
  assert.equal(j.intent("safe-1").state, "reserved");
  const signed = operation({ signature: SIGNATURE });
  await fence.saveSigned({ reservation, operation: signed });
  assert.deepEqual(events, ["sponsored-created", "reserved", "signed-persisted"]);
  assert.match(j.intent("safe-1").signed.raw, /^0x[0-9a-f]+$/);
  await j.close();
});

test("rejects every unsigned mutation after reservation and never replaces a signature", async () => {
  const j = await journal();
  const fence = adapter(j);
  const reservation = await fence.reserve({
    intentId: "safe-2",
    operation: operation(),
    offeredAt: 1000,
  });
  for (const [field, value] of Object.entries({
    sender: "0x3333333333333333333333333333333333333333",
    nonce: 1n,
    callData: "0x5678",
    callGasLimit: 9n,
    verificationGasLimit: 9n,
    preVerificationGas: 9n,
    maxFeePerGas: 9n,
    maxPriorityFeePerGas: 2n,
  })) {
    await assert.rejects(
      fence.saveSigned({
        reservation,
        operation: operation({ signature: SIGNATURE, [field]: value }),
      }),
    );
  }
  await fence.saveSigned({ reservation, operation: operation({ signature: SIGNATURE }) });
  await assert.rejects(
    fence.saveSigned({ reservation, operation: operation({ signature: "0x5678" }) }),
    /signature/,
  );
  await j.close();
});

test("route fence accepts exactly one persisted SDK wire operation and records attempt before continuation", async () => {
  const j = await journal();
  const fence = adapter(j);
  const reservation = await fence.reserve({
    intentId: "safe-3",
    operation: operation(),
    offeredAt: 1000,
  });
  const signed = operation({ signature: SIGNATURE });
  const persisted = await fence.saveSigned({ reservation, operation: signed });
  const wire = deterministicUserOperationRecord(signed);
  let sent = 0;
  await fence.route({
    reservation: persisted,
    wire,
    entryPoint: ENTRY_POINT,
    send: async () => {
      sent += 1;
      return HASH;
    },
  });
  assert.equal(sent, 1);
  assert.equal(j.actualSendCount("safe-3"), 1);
  await assert.rejects(
    fence.route({ reservation: persisted, wire, entryPoint: ENTRY_POINT, send: async () => HASH }),
    /duplicate/,
  );
  await j.close();
});

test("original policy rejects the known high fee before a credential boundary", async () => {
  const j = await journal();
  const fence = adapter(j);
  await assert.rejects(
    fence.reserve({
      intentId: "safe-expensive",
      operation: operation({ callGasLimit: 3_993_284n, maxFeePerGas: 1_210_000_003n }),
      offeredAt: 1000,
    }),
    /gas price|fee budget/,
  );
  assert.equal(j.snapshot().intents.length, 0);
  await j.close();
});

test("rejects keyed or unsafe UserOperation nonces before reserving", async () => {
  const j = await journal();
  const fence = adapter(j);
  for (const nonce of [9007199254740992n, 1n << 64n]) {
    await assert.rejects(
      fence.reserve({
        intentId: `unsafe-${nonce}`,
        operation: operation({ nonce }),
        offeredAt: 1000,
      }),
      /nonce/,
    );
  }
  assert.equal(j.snapshot().intents.length, 0);
  await j.close();
});

test("reconciles a persisted Safe operation using only its own canonical event cost", async () => {
  const j = await journal();
  const fence = adapter(j);
  const reservation = await fence.reserve({
    intentId: "safe-reconcile",
    operation: operation(),
    offeredAt: 1000,
  });
  await fence.saveSigned({ reservation, operation: operation({ signature: SIGNATURE }) });
  await j.recordAttempt("safe-reconcile");
  const result = await fence.reconcile("safe-reconcile", {
    lookup: async (identity) => ({
      state: "failed",
      operation: identity,
      transactionHash: `0x${"22".repeat(32)}`,
      blockNumber: 42n,
      blockHash: `0x${"33".repeat(32)}`,
      nonce: 0n,
      actualGasCost: 7n,
    }),
  });
  assert.deepEqual(result, { state: "reverted" });
  assert.equal(j.intent("safe-reconcile").terminal.feeWei, "7");
  await fence.reconcile("safe-reconcile", {
    lookup: async (identity) => ({
      state: "failed",
      operation: identity,
      transactionHash: `0x${"22".repeat(32)}`,
      blockNumber: 42n,
      blockHash: `0x${"33".repeat(32)}`,
      nonce: 0n,
      actualGasCost: 7n,
    }),
  });
  assert.equal(j.snapshot().budget.feeActualWei, "7");
  await j.close();
});

test("reconciles a restarted Safe journal without signing or sending again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kettigo-safe-restart-"));
  const j = await CandidateRunJournal.open({
    directory: dir,
    envelope: ORIGINAL_ENVELOPE,
    now: () => 1000,
  });
  const first = adapter(j);
  const reservation = await first.reserve({
    intentId: "safe-restart",
    operation: operation(),
    offeredAt: 1000,
  });
  await first.saveSigned({ reservation, operation: operation({ signature: SIGNATURE }) });
  await j.recordAttempt("safe-restart");
  await j.close();
  const restarted = await CandidateRunJournal.open({
    directory: dir,
    envelope: ORIGINAL_ENVELOPE,
    now: () => 1000,
  });
  let lookups = 0;
  const result = await adapter(restarted).reconcile("safe-restart", {
    lookup: async (identity) => {
      lookups += 1;
      return {
        state: "confirmed",
        operation: identity,
        transactionHash: `0x${"22".repeat(32)}`,
        blockNumber: 42n,
        blockHash: `0x${"33".repeat(32)}`,
        nonce: 0n,
        actualGasCost: 8n,
      };
    },
  });
  assert.deepEqual(result, { state: "success" });
  assert.equal(lookups, 1);
  assert.equal(restarted.actualSendCount("safe-restart"), 1);
  assert.equal(restarted.snapshot().budget.feeActualWei, "8");
  await restarted.close();
});

test("leaves pending evidence unresolved and rejects altered canonical identity", async () => {
  const j = await journal();
  const fence = adapter(j);
  const reservation = await fence.reserve({
    intentId: "safe-pending",
    operation: operation(),
    offeredAt: 1000,
  });
  await fence.saveSigned({ reservation, operation: operation({ signature: SIGNATURE }) });
  await j.recordAttempt("safe-pending");
  assert.deepEqual(
    await fence.reconcile("safe-pending", { lookup: async () => ({ state: "pending" }) }),
    { state: "unresolved" },
  );
  await assert.rejects(
    fence.reconcile("safe-pending", {
      lookup: async (identity) => ({
        state: "confirmed",
        operation: { ...identity, sender: POOL },
        transactionHash: `0x${"22".repeat(32)}`,
        blockNumber: 42n,
        blockHash: `0x${"33".repeat(32)}`,
        nonce: 0n,
        actualGasCost: 7n,
      }),
    }),
    /evidence mismatch/,
  );
  assert.equal(j.intent("safe-pending").terminal, null);
  await j.close();
});

test("signed persistence failure and an expired reservation prevent route continuation", async () => {
  const j = await journal();
  const fence = adapter(j);
  const reservation = await fence.reserve({
    intentId: "safe-failure",
    operation: operation(),
    offeredAt: 1000,
  });
  j.failPublish = true;
  await assert.rejects(
    fence.saveSigned({ reservation, operation: operation({ signature: SIGNATURE }) }),
    /persist/,
  );
  assert.equal(j.actualSendCount("safe-failure"), 0);
  await j.close();
  let time = 1000;
  const expiredJournal = await journal({ now: () => time });
  const expiredFence = adapter(expiredJournal);
  const expiredReservation = await expiredFence.reserve({
    intentId: "safe-expired",
    operation: operation(),
    offeredAt: 1000,
  });
  time += ORIGINAL_ENVELOPE.durationMs;
  await assert.rejects(
    expiredFence.saveSigned({
      reservation: expiredReservation,
      operation: operation({ signature: SIGNATURE }),
    }),
    /deadline/,
  );
  await expiredJournal.close();
});
