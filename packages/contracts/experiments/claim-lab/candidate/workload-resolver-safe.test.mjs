import assert from "node:assert/strict";
import test from "node:test";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics } from "viem";
import { entryPoint07Abi } from "viem/account-abstraction";
import { confidentialPrizePoolAbi } from "../../../../protocol/src/index.ts";

import { FIXED_ENTRY_POINT_07 } from "./workload-completion.ts";
import { compileCandidateWorkload } from "./eoa-workload-definition.mjs";
import {
  workloadDefinitionFixture,
  workloadManifestFixture,
} from "./eoa-workload-test-fixture.mjs";
import { encodeCandidateEoaAction } from "./workload-calldata.mjs";
import { resolveCandidateAction } from "./workload-resolver.ts";

const hash = (value) => `0x${value.toString(16).padStart(64, "0")}`;
const rawLog = (address, abi, eventName, args, logIndex) => {
  const event = abi.find((item) => item.type === "event" && item.name === eventName);
  const inputs = event.inputs.filter((item) => !item.indexed);
  return {
    address,
    topics: encodeEventTopics({ abi, eventName, args }),
    data: encodeAbiParameters(
      inputs,
      inputs.map((input) => args[input.name]),
    ),
    transactionHash: hash(97),
    blockHash: hash(98),
    blockNumber: 99n,
    logIndex,
  };
};
const userOperation = (userOpHash, sender, logIndex) =>
  rawLog(
    FIXED_ENTRY_POINT_07,
    entryPoint07Abi,
    "UserOperationEvent",
    {
      userOpHash,
      sender,
      paymaster: "0x0000000000000000000000000000000000000000",
      nonce: 0n,
      success: true,
      actualGasCost: 0n,
      actualGasUsed: 0n,
    },
    logIndex,
  );
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
const safeEvidence = (compiled, certificateHash, certificateSender, eventHash, eventSender) => ({
  producer: {
    kind: "safe",
    actionId: "safe-exit-membership",
    safe: compiled.definition.actors.safeParticipant,
    canonicalRecovery: {
      kind: "safe",
      actionId: "safe-exit-membership",
      entryPoint: FIXED_ENTRY_POINT_07,
      sender: certificateSender,
      userOperationHash: certificateHash,
      outerTransactionHash: hash(97),
      blockNumber: "99",
      blockHash: hash(98),
    },
  },
  receipt: {
    transactionHash: hash(97),
    status: "success",
    blockNumber: 99n,
    blockHash: hash(98),
    logs: [
      rawLog(FIXED_ENTRY_POINT_07, entryPoint07Abi, "BeforeExecution", {}, 0),
      rawLog(
        compiled.definition.contracts.candidatePool,
        confidentialPrizePoolAbi,
        "WithdrawalRequested",
        { account: compiled.definition.actors.safeParticipant, batchId: 7n, amount: hash(1) },
        1,
      ),
      userOperation(eventHash, eventSender, 2),
      userOperation(hash(96), compiled.definition.actors.bootstrapOperator, 3),
    ],
  },
  header: { number: 99n, hash: hash(98) },
});

const eoaWithdrawalEvidence = (compiled) => ({
  producer: {
    kind: "eoa",
    actionId: "eoa-00-deposit",
    actor: compiled.definition.actors.eoaParticipants[0],
    canonicalRecovery: {
      kind: "eoa",
      actionId: "eoa-00-deposit",
      transactionHash: hash(97),
      blockNumber: "99",
      blockHash: hash(98),
    },
  },
  receipt: {
    transactionHash: hash(97),
    status: "success",
    blockNumber: 99n,
    blockHash: hash(98),
    logs: [
      rawLog(
        compiled.definition.contracts.candidatePool,
        confidentialPrizePoolAbi,
        "WithdrawalRequested",
        { account: compiled.definition.actors.safeParticipant, batchId: 7n, amount: hash(1) },
        1,
      ),
    ],
  },
  header: { number: 99n, hash: hash(98) },
});

const safeAdmissionEvidence = (compiled) => {
  const safe = compiled.definition.actors.safeParticipant;
  const account = compiled.definition.actors.eoaParticipants[0];
  return {
    producer: {
      kind: "safe",
      actionId: "safe-exit-membership",
      safe,
      canonicalRecovery: {
        kind: "safe",
        actionId: "safe-exit-membership",
        entryPoint: FIXED_ENTRY_POINT_07,
        sender: safe,
        userOperationHash: hash(95),
        outerTransactionHash: hash(97),
        blockNumber: "99",
        blockHash: hash(98),
      },
    },
    receipt: {
      transactionHash: hash(97),
      status: "success",
      blockNumber: 99n,
      blockHash: hash(98),
      logs: [
        rawLog(FIXED_ENTRY_POINT_07, entryPoint07Abi, "BeforeExecution", {}, 0),
        rawLog(
          compiled.definition.contracts.candidatePool,
          admissionAbi,
          "AdmissionRequested",
          { account, nonce: 9n, marker: hash(2) },
          1,
        ),
        userOperation(hash(95), safe, 2),
      ],
    },
    header: { number: 99n, hash: hash(98) },
  };
};

test("resolver encodes only the canonical Safe withdrawal batch for initial close", async () => {
  const compiled = compileCandidateWorkload(workloadDefinitionFixture(), workloadManifestFixture());
  const owner = compiled.definition.actors.safeParticipant;
  const ownHash = hash(95);
  const resolve = (eventHash = ownHash, eventSender = owner) =>
    resolveCandidateAction({
      compiled,
      actionId: "initial-batch-close",
      sdk: {},
      evidence: {
        "safe-exit-membership": safeEvidence(compiled, ownHash, owner, eventHash, eventSender),
      },
    });
  await assert.rejects(() => resolve(hash(94)), /Safe own user operation/);
  await assert.rejects(
    () => resolve(ownHash, compiled.definition.actors.bootstrapOperator),
    /Safe own user operation/,
  );
  const references = await resolve();
  const encoded = encodeCandidateEoaAction({
    compiled,
    actionId: "initial-batch-close",
    resolved: {
      actionId: "initial-batch-close",
      workloadFingerprint: compiled.fingerprint,
      references,
    },
  });
  assert.equal(references[0].value, "7");
  assert.deepEqual(decodeFunctionData({ abi: confidentialPrizePoolAbi, data: encoded.data }), {
    functionName: "closeWithdrawalBatch",
    args: [7n],
  });
});

test("resolver rejects self-consistent EOA evidence under the Safe producer key", async () => {
  const compiled = compileCandidateWorkload(workloadDefinitionFixture(), workloadManifestFixture());
  await assert.rejects(
    () =>
      resolveCandidateAction({
        compiled,
        actionId: "initial-batch-close",
        sdk: { decryption: { decryptPublicValues: async () => assert.fail("unexpected decrypt") } },
        evidence: { "safe-exit-membership": eoaWithdrawalEvidence(compiled) },
      }),
    /producer evidence/,
  );
});

test("resolver rejects self-consistent Safe evidence under the EOA producer key before decrypting", async () => {
  const compiled = compileCandidateWorkload(workloadDefinitionFixture(), workloadManifestFixture());
  await assert.rejects(
    () =>
      resolveCandidateAction({
        compiled,
        actionId: "eoa-00-admit",
        sdk: { decryption: { decryptPublicValues: async () => assert.fail("unexpected decrypt") } },
        evidence: { "eoa-00-deposit": safeAdmissionEvidence(compiled) },
      }),
    /producer evidence/,
  );
});
