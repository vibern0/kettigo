import assert from "node:assert/strict";

import { encodeAbiParameters, encodeEventTopics } from "viem";

import { confidentialPrizePoolAbi } from "../../../../protocol/src/index.ts";
import { compileCandidateWorkload } from "./eoa-workload-definition.mjs";
import {
  workloadDefinitionFixture,
  workloadManifestFixture,
} from "./eoa-workload-test-fixture.mjs";
import { h32, proofFixture } from "./history-test-fixture.mjs";

const hash = (value) => `0x${value.toString(16).padStart(64, "0")}`;
const event = (name) =>
  confidentialPrizePoolAbi.find((entry) => entry.type === "event" && entry.name === name);
const data = (abi, values) =>
  encodeAbiParameters(
    abi.inputs.filter((input) => !input.indexed),
    values,
  );
function canonicalDrawEvidence({
  producer,
  pool,
  proof,
  transactionHash,
  blockHash,
  snapshotDrawId,
  snapshotLogIndex,
}) {
  const log = (abi, args, logIndex) => ({
    address: pool,
    topics: encodeEventTopics({ abi: confidentialPrizePoolAbi, eventName: abi.name, args }),
    data: data(
      abi,
      Object.values(args).filter((_, index) => !abi.inputs[index].indexed),
    ),
    transactionHash,
    blockHash,
    blockNumber: 1234n,
    logIndex,
  });
  const draw = { drawId: 19n, randomTicket: h32("d"), prizeAmount: h32("e") };
  const snapshot = {
    drawId: snapshotDrawId,
    rootHash: proof.rootHash,
    rootSum: proof.rootSum,
    ticket: proof.ticket,
    prize: h32("f"),
    remaining: h32("1"),
    upperBound: BigInt(proof.upperBound),
    closeBlockNumber: 1234n,
  };
  return {
    producer: {
      kind: "eoa",
      actionId: producer.id,
      actor: producer.actor,
      canonicalRecovery: {
        kind: "eoa",
        actionId: producer.id,
        transactionHash,
        blockNumber: "1234",
        blockHash,
      },
    },
    receipt: {
      transactionHash,
      status: "success",
      blockNumber: 1234n,
      blockHash,
      logs: [
        log(event("DrawClosed"), draw, 16),
        log(event("DrawSnapshotClosed"), snapshot, snapshotLogIndex),
      ],
    },
    header: { number: 1234n, hash: blockHash },
  };
}

export function historicResolverInput({
  proof = undefined,
  producerActionId = "close-draw-8",
  snapshotDrawId = 19n,
  snapshotLogIndex = 17,
} = {}) {
  const compiled = compileCandidateWorkload(workloadDefinitionFixture(), workloadManifestFixture());
  const actionId = "check-stage8-eoa-00";
  const producer = compiled.actions.find((action) => action.id === producerActionId);
  const account = compiled.actions.find((action) => action.id === actionId).actor;
  const pool = compiled.definition.contracts.candidatePool;
  const validProof = proof ?? proofFixture({ pool, account });
  const transactionHash = hash(77);
  const blockHash = h32("c");
  return {
    compiled,
    actionId,
    sdk: { encrypt: async () => assert.fail("history-only action must not encrypt") },
    evidence: {
      "close-draw-8": {
        ...canonicalDrawEvidence({
          producer,
          pool,
          proof: validProof,
          transactionHash,
          blockHash,
          snapshotDrawId,
          snapshotLogIndex,
        }),
      },
    },
    historic: {
      baseUrl: "https://archive.example/",
      fetch: async () =>
        new globalThis.Response(JSON.stringify({ proof: validProof }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      readSnapshot: async () => ({
        rootHash: validProof.rootHash,
        rootSum: validProof.rootSum,
        ticket: validProof.ticket,
        upperBound: BigInt(validProof.upperBound),
        closeBlockNumber: 1234n,
      }),
      readBlockHash: async () => blockHash,
    },
  };
}
