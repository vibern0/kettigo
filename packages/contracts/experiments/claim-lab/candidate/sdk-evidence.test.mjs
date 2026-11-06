import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, encodeEventTopics, getAddress } from "viem";
import { entryPoint07Abi } from "viem/account-abstraction";

import { readAdmission, readWithdrawalUnwrap } from "./canonical-event.ts";
import { resolveConditionalCredit } from "./workload-conditions.ts";
import { FIXED_ENTRY_POINT_07 } from "./workload-completion.ts";
import { compileCandidateWorkload } from "./eoa-workload-definition.mjs";
import {
  workloadDefinitionFixture,
  workloadManifestFixture,
} from "./eoa-workload-test-fixture.mjs";

const pool = getAddress("0x00000000000000000000000000000000000000aa");
const wrapper = getAddress("0x00000000000000000000000000000000000000bb");
const account = getAddress("0x00000000000000000000000000000000000000cc");
const hash = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const admissionAbi = [
  {
    type: "event",
    name: "AdmissionRequested",
    inputs: [
      { indexed: true, name: "account", type: "address" },
      { indexed: false, name: "nonce", type: "uint256" },
      { indexed: false, name: "marker", type: "bytes32" },
    ],
  },
];
const unwrapAbi = [
  {
    type: "event",
    name: "WithdrawalClaimedToUsdc",
    inputs: [
      { indexed: true, name: "account", type: "address" },
      { indexed: true, name: "batchId", type: "uint256" },
      { indexed: true, name: "to", type: "address" },
      { indexed: false, name: "amount", type: "bytes32" },
      { indexed: false, name: "unwrapRequestId", type: "bytes32" },
    ],
  },
  {
    type: "event",
    name: "UnwrapRequested",
    inputs: [
      { indexed: true, name: "receiver", type: "address" },
      { indexed: true, name: "unwrapRequestId", type: "bytes32" },
      { indexed: false, name: "amount", type: "bytes32" },
    ],
  },
];
const log = (address, abi, eventName, args, logIndex) => {
  const event = abi.find((item) => item.name === eventName),
    argsArray = event.inputs.filter((item) => !item.indexed);
  return {
    address,
    topics: encodeEventTopics({ abi, eventName, args }),
    data: encodeAbiParameters(
      argsArray,
      argsArray.map((item) => args[item.name]),
    ),
    transactionHash: hash(1),
    blockHash: hash(7),
    blockNumber: 7n,
    logIndex,
  };
};
const evidence = (logs) => ({
  producer: {
    kind: "eoa",
    actionId: "eoa-00-deposit",
    actor: account,
    canonicalRecovery: {
      kind: "eoa",
      actionId: "eoa-00-deposit",
      transactionHash: hash(1),
      blockNumber: "7",
      blockHash: hash(7),
    },
  },
  receipt: {
    transactionHash: hash(1),
    status: "success",
    blockNumber: 7n,
    blockHash: hash(7),
    logs,
  },
  header: { number: 7n, hash: hash(7) },
});

const safeEvidence = (logs, { userOperationHash = hash(11), sender = account } = {}) => ({
  producer: {
    kind: "safe",
    actionId: "safe-conditional-wallet-claim",
    safe: sender,
    canonicalRecovery: {
      kind: "safe",
      actionId: "safe-conditional-wallet-claim",
      entryPoint: FIXED_ENTRY_POINT_07,
      sender,
      userOperationHash,
      outerTransactionHash: hash(1),
      blockNumber: "7",
      blockHash: hash(7),
    },
  },
  receipt: {
    transactionHash: hash(1),
    status: "success",
    blockNumber: 7n,
    blockHash: hash(7),
    logs,
  },
  header: { number: 7n, hash: hash(7) },
});

const entryPointLog = (eventName, args, logIndex) =>
  log(FIXED_ENTRY_POINT_07, entryPoint07Abi, eventName, args, logIndex);
const userOperation = (userOpHash, sender, success, logIndex) =>
  entryPointLog(
    "UserOperationEvent",
    {
      userOpHash,
      sender,
      paymaster: "0x0000000000000000000000000000000000000000",
      nonce: 0n,
      success,
      actualGasCost: 0n,
      actualGasUsed: 0n,
    },
    logIndex,
  );

test("canonical admission rejects a duplicate scoped log rather than selecting one", () => {
  const args = { account, nonce: 5n, marker: hash(2) };
  assert.throws(
    () =>
      readAdmission({
        evidence: evidence([
          log(pool, admissionAbi, "AdmissionRequested", args, 1),
          log(pool, admissionAbi, "AdmissionRequested", args, 2),
        ]),
        pool,
        account,
      }),
    /exactly one/,
  );
});

test("canonical admission rejects a saved certificate from another block", () => {
  const args = { account, nonce: 5n, marker: hash(2) };
  const input = evidence([log(pool, admissionAbi, "AdmissionRequested", args, 1)]);
  input.producer.canonicalRecovery = { ...input.producer.canonicalRecovery, blockHash: hash(8) };
  assert.throws(() => readAdmission({ evidence: input, pool, account }), /canonical producer/);
});

test("canonical Safe admission uses only the saved UserOperation interval in a bundled outer transaction", () => {
  const ownHash = hash(11),
    otherHash = hash(12),
    other = getAddress("0x00000000000000000000000000000000000000dd");
  const ownAdmission = log(
    pool,
    admissionAbi,
    "AdmissionRequested",
    { account, nonce: 5n, marker: hash(2) },
    2,
  );
  const otherAdmission = log(
    pool,
    admissionAbi,
    "AdmissionRequested",
    { account, nonce: 6n, marker: hash(3) },
    4,
  );
  assert.deepEqual(
    readAdmission({
      evidence: safeEvidence(
        [
          entryPointLog("BeforeExecution", {}, 0),
          ownAdmission,
          userOperation(ownHash, account, true, 3),
          otherAdmission,
          userOperation(otherHash, other, true, 5),
        ],
        { userOperationHash: ownHash },
      ),
      pool,
      account,
    }),
    { nonce: "5", marker: hash(2) },
  );
});

test("canonical Safe admission rejects missing, wrong, reverted, or mismatched saved UserOperation evidence", () => {
  const ownHash = hash(11),
    other = getAddress("0x00000000000000000000000000000000000000dd");
  const build = (event) =>
    safeEvidence(
      [
        entryPointLog("BeforeExecution", {}, 0),
        log(pool, admissionAbi, "AdmissionRequested", { account, nonce: 5n, marker: hash(2) }, 1),
        event,
      ],
      { userOperationHash: ownHash },
    );
  const cases = [
    build(userOperation(hash(12), account, true, 2)),
    build(userOperation(ownHash, other, true, 2)),
    build(userOperation(ownHash, account, false, 2)),
    safeEvidence([entryPointLog("BeforeExecution", {}, 0)], { userOperationHash: ownHash }),
  ];
  const outerMismatched = build(userOperation(ownHash, account, true, 2));
  outerMismatched.producer.canonicalRecovery.outerTransactionHash = hash(2);
  cases.push(outerMismatched);
  for (const source of cases)
    assert.throws(
      () => readAdmission({ evidence: source, pool, account }),
      /Safe own user operation|Safe producer/,
    );
});

test("canonical Safe admission cannot satisfy its event from another bundled UserOperation", () => {
  const ownHash = hash(11),
    otherHash = hash(12),
    other = getAddress("0x00000000000000000000000000000000000000dd");
  assert.throws(
    () =>
      readAdmission({
        evidence: safeEvidence(
          [
            entryPointLog("BeforeExecution", {}, 0),
            log(
              pool,
              admissionAbi,
              "AdmissionRequested",
              { account: other, nonce: 5n, marker: hash(2) },
              1,
            ),
            userOperation(ownHash, account, true, 2),
            log(
              pool,
              admissionAbi,
              "AdmissionRequested",
              { account, nonce: 6n, marker: hash(3) },
              3,
            ),
            userOperation(otherHash, other, true, 4),
          ],
          { userOperationHash: ownHash },
        ),
        pool,
        account,
      }),
    /exactly one/,
  );
});

test("canonical unwrap binds the pool request to its same-receipt wrapper receiver", () => {
  const request = hash(3);
  const poolLog = log(
    pool,
    unwrapAbi,
    "WithdrawalClaimedToUsdc",
    { account, batchId: 9n, to: account, amount: hash(4), unwrapRequestId: request },
    1,
  );
  const wrapperLog = log(
    wrapper,
    unwrapAbi,
    "UnwrapRequested",
    { receiver: account, unwrapRequestId: request, amount: hash(5) },
    2,
  );
  assert.deepEqual(
    readWithdrawalUnwrap({
      evidence: evidence([poolLog, wrapperLog]),
      pool,
      wrapper,
      account,
      batchId: "9",
    }),
    { unwrapRequestId: request, amount: hash(5) },
  );
});

const graph = () =>
  compileCandidateWorkload(workloadDefinitionFixture(), workloadManifestFixture());
const completion = (compiled, id) => ({
  kind: "canonical-success",
  actionId: id,
  evidence: {
    kind: id.startsWith("safe-") ? "safe" : "eoa",
    actionId: id,
    ...(id.startsWith("safe-")
      ? {
          userOperationHash: hash(1),
          entryPoint: FIXED_ENTRY_POINT_07,
          sender: compiled.actions.find((a) => a.id === id).actor,
          outerTransactionHash: hash(2),
        }
      : { transactionHash: hash(1) }),
    blockNumber: "9",
    blockHash: hash(9),
  },
});
test("conditional credit rechecks the read header after owned decryption", async () => {
  let checks = 0;
  const compiled = graph(),
    action = compiled.actions.find((a) => a.id === "claim-stage8-eoa-00"),
    saved = completion(compiled, action.dependencies[0]);
  const result = await resolveConditionalCredit({
    compiled,
    actionId: action.id,
    readBlock: { number: "10", hash: hash(10) },
    dependencyCompletions: [saved],
    authority: {
      readEncryptedWinningsAt: async () => hash(6),
      decryptOwnedUint64: async () => 0n,
      blockAt: async () => ({ number: "10", hash: checks++ ? hash(10) : hash(10) }),
      completionFor: async () => saved,
    },
  });
  assert.equal(result.kind, "SKIPPED");
  assert.equal(result.evidence.resolution, "user-decrypt");
  assert.equal(result.evidence.clearCredit, "0");
  assert.equal(checks, 2);
});

test("conditional credit rejects an unowned Safe substitution", async () => {
  const compiled = graph(),
    action = compiled.actions.find((a) => a.id === "safe-conditional-wallet-claim"),
    saved = action.dependencies.map((id) => completion(compiled, id));
  await assert.rejects(
    () =>
      resolveConditionalCredit({
        compiled,
        actionId: action.id,
        readBlock: { number: "10", hash: hash(10) },
        dependencyCompletions: saved,
        authority: {
          readEncryptedWinningsAt: async () => hash(6),
          decryptOwnedUint64: async () => 0n,
          blockAt: async () => ({ number: "10", hash: hash(10) }),
          completionFor: async (id) => saved.find((entry) => entry.actionId === id),
        },
      }),
    /Safe owned read authority/,
  );
});

const conditionalRequest = (compiled, actionId, dependencyCompletions, authority) =>
  resolveConditionalCredit({
    compiled,
    actionId,
    readBlock: { number: "10", hash: hash(10) },
    dependencyCompletions,
    authority,
  });
const matchingHeader = async () => ({ number: "10", hash: hash(10) });

test("conditional credit rejects changed, missing, and reordered saved dependencies before any owned read", async () => {
  const compiled = graph(),
    action = compiled.actions.find((a) => a.id === "safe-conditional-wallet-claim");
  const saved = action.dependencies.map((id) => completion(compiled, id));
  const cases = [
    [],
    [...saved].reverse(),
    [{ ...saved[0], evidence: { ...saved[0].evidence, blockHash: hash(8) } }, saved[1]],
  ];
  for (const submitted of cases) {
    let decrypts = 0;
    await assert.rejects(
      () =>
        conditionalRequest(compiled, action.id, submitted, {
          readEncryptedWinningsAt: async () => hash(6),
          decryptSafeOwnedUint64: async () => ((decrypts += 1), 0n),
          blockAt: matchingHeader,
          completionFor: async (id) => saved.find((entry) => entry.actionId === id),
        }),
      /conditional dependenc|incomplete/,
    );
    assert.equal(decrypts, 0);
  }
});

test("positive owned credit is claim-eligible rather than a skip certificate", async () => {
  const compiled = graph(),
    action = compiled.actions.find((a) => a.id === "claim-stage8-eoa-00");
  const saved = [completion(compiled, action.dependencies[0])];
  const result = await conditionalRequest(compiled, action.id, saved, {
    readEncryptedWinningsAt: async () => hash(6),
    decryptOwnedUint64: async () => 7n,
    blockAt: matchingHeader,
    completionFor: async () => saved[0],
  });
  assert.deepEqual(result, { kind: "claim-eligible", clearCredit: "7" });
});

test("conditional credit rejects a same-height reorganization after owned decryption", async () => {
  let reads = 0,
    decrypts = 0;
  const compiled = graph(),
    action = compiled.actions.find((a) => a.id === "claim-stage8-eoa-00");
  const saved = [completion(compiled, action.dependencies[0])];
  await assert.rejects(
    () =>
      conditionalRequest(compiled, action.id, saved, {
        readEncryptedWinningsAt: async () => hash(6),
        decryptOwnedUint64: async () => ((decrypts += 1), 0n),
        blockAt: async () => ({ number: "10", hash: reads++ ? hash(11) : hash(10) }),
        completionFor: async () => saved[0],
      }),
    /block changed/,
  );
  assert.equal(decrypts, 1);
});

test("zero conditional handle never invokes an owned reader but still rechecks its block", async () => {
  let headers = 0,
    decrypts = 0;
  const compiled = graph(),
    action = compiled.actions.find((a) => a.id === "claim-stage8-eoa-00");
  const saved = [completion(compiled, action.dependencies[0])];
  const result = await conditionalRequest(compiled, action.id, saved, {
    readEncryptedWinningsAt: async () => `0x${"00".repeat(32)}`,
    decryptOwnedUint64: async () => ((decrypts += 1), 0n),
    blockAt: async () => ((headers += 1), await matchingHeader()),
    completionFor: async () => saved[0],
  });
  assert.equal(result.kind, "SKIPPED");
  assert.equal(decrypts, 0);
  assert.equal(headers, 2);
});

test("conditional owned read rejects non-uint64 and overflowing clear values", async () => {
  const compiled = graph(),
    action = compiled.actions.find((a) => a.id === "claim-stage8-eoa-00");
  const saved = [completion(compiled, action.dependencies[0])];
  for (const clear of [1, 1n << 64n]) {
    await assert.rejects(
      () =>
        conditionalRequest(compiled, action.id, saved, {
          readEncryptedWinningsAt: async () => hash(6),
          decryptOwnedUint64: async () => clear,
          blockAt: matchingHeader,
          completionFor: async () => saved[0],
        }),
      /invalid conditional clear credit/,
    );
  }
});

test("conditional credit rejects a class receiver instead of trusting caller-supplied graph state", async () => {
  class CompiledWorkload {
    constructor(value) {
      Object.assign(this, value);
    }
  }
  const compiled = graph(),
    action = compiled.actions.find((a) => a.id === "claim-stage8-eoa-00");
  const saved = [completion(compiled, action.dependencies[0])];
  await assert.rejects(
    () =>
      conditionalRequest(new CompiledWorkload(compiled), action.id, saved, {
        readEncryptedWinningsAt: async () => hash(6),
        decryptOwnedUint64: async () => 0n,
        blockAt: matchingHeader,
        completionFor: async () => saved[0],
      }),
    /compiled workload/,
  );
});

test("Safe conditional credit accepts both saved checks only through the Safe-owned reader", async () => {
  let ordinaryReads = 0,
    safeReads = 0;
  const compiled = graph(),
    action = compiled.actions.find((a) => a.id === "safe-conditional-wallet-claim");
  const saved = action.dependencies.map((id) => completion(compiled, id));
  const result = await conditionalRequest(compiled, action.id, saved, {
    readEncryptedWinningsAt: async () => hash(6),
    decryptOwnedUint64: async () => ((ordinaryReads += 1), 0n),
    decryptSafeOwnedUint64: async () => ((safeReads += 1), 0n),
    blockAt: matchingHeader,
    completionFor: async (id) => saved.find((entry) => entry.actionId === id),
  });
  assert.equal(result.kind, "SKIPPED");
  assert.equal(safeReads, 1);
  assert.equal(ordinaryReads, 0);
  assert.deepEqual(
    result.evidence.dependencies.map((entry) => entry.actionId),
    action.dependencies,
  );
});
