import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { confidentialPrizePoolAbi, confidentialUsdcAbi } from "../../../../protocol/src/index.ts";

import { compileCandidateWorkload } from "./eoa-workload-definition.mjs";
import {
  workloadDefinitionFixture,
  workloadManifestFixture,
} from "./eoa-workload-test-fixture.mjs";
import { encodeCandidateEoaAction } from "./workload-calldata.mjs";
import { resolveCandidateAction } from "./workload-resolver.ts";

const hash = (value) => `0x${value.toString(16).padStart(64, "0")}`;
const workload = () =>
  compileCandidateWorkload(workloadDefinitionFixture(), workloadManifestFixture());
const eventLog = (address, abi, eventName, args, transactionHash, logIndex) => {
  const event = abi.find((entry) => entry.type === "event" && entry.name === eventName);
  const inputs = event.inputs.filter((entry) => !entry.indexed);
  return {
    address,
    topics: encodeEventTopics({ abi, eventName, args }),
    data: encodeAbiParameters(
      inputs,
      inputs.map((entry) => args[entry.name]),
    ),
    transactionHash,
    blockHash: hash(8),
    blockNumber: 8n,
    logIndex,
  };
};
const receiptEvidence = (actionId, actor, logs, transactionHash = hash(20)) => ({
  producer: {
    kind: "eoa",
    actionId,
    actor,
    canonicalRecovery: {
      kind: "eoa",
      actionId,
      transactionHash,
      blockNumber: "8",
      blockHash: hash(8),
    },
  },
  receipt: { transactionHash, status: "success", blockNumber: 8n, blockHash: hash(8), logs },
  header: { number: 8n, hash: hash(8) },
});
const encodedUints = (values) =>
  encodeAbiParameters(
    values.map(() => ({ type: "uint64" })),
    values,
  );
const encoded = (compiled, actionId, references) =>
  encodeCandidateEoaAction({
    compiled,
    actionId,
    resolved: { actionId, workloadFingerprint: compiled.fingerprint, references },
  }).data;

function settlementEvidence(compiled, account, batchId, total, restore) {
  const pool = compiled.definition.contracts.candidatePool;
  return {
    "final-request-eoa-00": receiptEvidence("final-request-eoa-00", account, [
      eventLog(
        pool,
        confidentialPrizePoolAbi,
        "WithdrawalRequested",
        { account, batchId, amount: hash(1) },
        hash(20),
        1,
      ),
    ]),
    "final-batch-close": receiptEvidence(
      "final-batch-close",
      compiled.definition.actors.sponsor,
      [
        eventLog(
          pool,
          confidentialPrizePoolAbi,
          "WithdrawalBatchClosed",
          { batchId, total, morphoRestoreTotal: restore },
          hash(21),
          2,
        ),
      ],
      hash(21),
    ),
  };
}

export async function assertBatchSettlement() {
  const compiled = workload(),
    account = compiled.definition.actors.eoaParticipants[0],
    total = hash(31),
    restore = hash(32);
  let calls = 0;
  const references = await resolveCandidateAction({
    compiled,
    actionId: "final-batch-settle",
    evidence: settlementEvidence(compiled, account, 9n, total, restore),
    sdk: {
      decryption: {
        decryptPublicValues: async (handles) => {
          calls += 1;
          assert.deepEqual(handles, [total, restore]);
          return {
            clearValues: { [total]: 4n, [restore]: 2n },
            abiEncodedClearValues: encodedUints([4n, 2n]),
            decryptionProof: "0x1234",
          };
        },
      },
    },
  });
  assert.equal(calls, 1);
  assert.match(encoded(compiled, "final-batch-settle", references), /^0x/);
}

function withdrawalEvidence(compiled, account, request, amount) {
  const pool = compiled.definition.contracts.candidatePool,
    wrapper = compiled.definition.contracts.wrapper,
    tx = hash(23);
  return {
    "final-process-eoa-00": receiptEvidence(
      "final-process-eoa-00",
      compiled.definition.actors.sponsor,
      [
        eventLog(
          pool,
          confidentialPrizePoolAbi,
          "WithdrawalClaimedToUsdc",
          { account, batchId: 9n, to: account, amount: hash(4), unwrapRequestId: request },
          tx,
          1,
        ),
        eventLog(
          wrapper,
          confidentialUsdcAbi,
          "UnwrapRequested",
          { receiver: account, unwrapRequestId: request, amount },
          tx,
          2,
        ),
      ],
      tx,
    ),
    "final-request-eoa-00": settlementEvidence(compiled, account, 9n, hash(1), hash(2))[
      "final-request-eoa-00"
    ],
  };
}
const clear = {
  decryption: {
    decryptPublicValues: async (handles) => ({
      clearValues: { [handles[0]]: 5n },
      abiEncodedClearValues: encodedUints([5n]),
      decryptionProof: "0x1234",
    }),
  },
};

async function assertWithdrawalUnwrap(compiled, account, request, amount) {
  const evidence = withdrawalEvidence(compiled, account, request, amount);
  const references = await resolveCandidateAction({
    compiled,
    actionId: "final-finalize-eoa-00",
    sdk: clear,
    evidence,
  });
  assert.match(encoded(compiled, "final-finalize-eoa-00", references), /^0x/);
  evidence["final-process-eoa-00"].receipt.logs[1].topics = eventLog(
    compiled.definition.contracts.wrapper,
    confidentialUsdcAbi,
    "UnwrapRequested",
    { receiver: compiled.definition.actors.eoaParticipants[1], unwrapRequestId: request, amount },
    hash(23),
    2,
  ).topics;
  await assert.rejects(
    () =>
      resolveCandidateAction({
        compiled,
        actionId: "final-finalize-eoa-00",
        sdk: clear,
        evidence,
      }),
    /exactly one/,
  );
}
function morphoEvidence(compiled, request, amount) {
  const tx = hash(23),
    pool = compiled.definition.contracts.candidatePool,
    wrapper = compiled.definition.contracts.wrapper;
  return {
    "morpho-request-initial": receiptEvidence(
      "morpho-request-initial",
      compiled.definition.actors.sponsor,
      [
        eventLog(
          pool,
          confidentialPrizePoolAbi,
          "MorphoPrincipalUnwrapRequested",
          { unwrapRequestId: request, depositCount: 1n },
          tx,
          1,
        ),
        eventLog(
          wrapper,
          confidentialUsdcAbi,
          "UnwrapRequested",
          { receiver: compiled.definition.contracts.adapter, unwrapRequestId: request, amount },
          tx,
          2,
        ),
      ],
      tx,
    ),
  };
}
async function assertMorphoUnwrap(compiled, request, amount) {
  const references = await resolveCandidateAction({
    compiled,
    actionId: "morpho-finalize-initial",
    sdk: clear,
    evidence: morphoEvidence(compiled, request, amount),
  });
  assert.match(encoded(compiled, "morpho-finalize-initial", references), /^0x/);
}

export async function assertReceiverBoundUnwraps() {
  const compiled = workload(),
    account = compiled.definition.actors.eoaParticipants[0],
    request = hash(41),
    amount = hash(42);
  await assertWithdrawalUnwrap(compiled, account, request, amount);
  await assertMorphoUnwrap(compiled, request, amount);
}
