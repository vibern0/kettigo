import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, encodeEventTopics } from "viem";

import { compileCandidateWorkload } from "./eoa-workload-definition.mjs";
import {
  workloadDefinitionFixture,
  workloadManifestFixture,
} from "./eoa-workload-test-fixture.mjs";
import { encodeCandidateEoaAction } from "./workload-calldata.mjs";
import { resolveCandidateAction } from "./workload-resolver.ts";
import {
  assertBatchSettlement,
  assertReceiverBoundUnwraps,
} from "./workload-resolver-runtime-cases.mjs";

const handle = (byte) => `0x${byte.repeat(32)}`;
const workload = () =>
  compileCandidateWorkload(workloadDefinitionFixture(), workloadManifestFixture());
const sdk = {
  encrypt: async () => ({ encryptedValues: [handle("ab")], inputProof: "0x1234" }),
};
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

test("resolver returns graph-scoped deposit records that encode through the approved EOA encoder", async () => {
  const compiled = workload();
  const actionId = "eoa-00-deposit";
  const references = await resolveCandidateAction({ compiled, actionId, sdk });
  const encoded = encodeCandidateEoaAction({
    compiled,
    actionId,
    resolved: { actionId, workloadFingerprint: compiled.fingerprint, references },
  });
  assert.match(encoded.data, /^0x/);
  assert.equal(references.length, 3);
  assert.equal(references[2].value, "0x");
  for (const record of references) {
    assert.equal(record.scope.actionId, actionId);
    assert.equal(record.scope.workloadFingerprint, compiled.fingerprint);
    assert.strictEqual(record.scope.reference, record.reference);
  }
});

test("resolver rejects creation and Safe barriers before it invokes the SDK", async () => {
  const compiled = workload();
  let calls = 0;
  const countingSdk = { encrypt: async () => ((calls += 1), await sdk.encrypt()) };
  await assert.rejects(
    () => resolveCandidateAction({ compiled, actionId: "deploy-wrapper", sdk: countingSdk }),
    /creation|EOA/,
  );
  await assert.rejects(
    () => resolveCandidateAction({ compiled, actionId: "safe-initial-deposit", sdk: countingSdk }),
    /EOA/,
  );
  assert.equal(calls, 0);
});

test("resolver supplies one paired SDK input and proof for every EOA prize-funding family", async () => {
  const compiled = workload();
  for (const actionId of ["prize-fund-A", "prize-fund-B", "prize-fund-8", "prize-fund-33"]) {
    const references = await resolveCandidateAction({ compiled, actionId, sdk });
    const encoded = encodeCandidateEoaAction({
      compiled,
      actionId,
      resolved: { actionId, workloadFingerprint: compiled.fingerprint, references },
    });
    assert.match(encoded.data, /^0x/);
    assert.equal(references.length, 2);
    assert.equal(references[0].value, handle("ab"));
    assert.equal(references[1].value, "0x1234");
  }
});

test("every reference-free EOA action resolves empty records without touching the SDK", async () => {
  const compiled = workload();
  const dynamic = new Set([
    "sdkInput",
    "sdkProof",
    "delegateData",
    "receiptEvent",
    "publicDecrypt",
    "historicalProof",
  ]);
  const refs = (value, found = []) => {
    if (Array.isArray(value)) value.forEach((entry) => refs(entry, found));
    else if (value && typeof value === "object") {
      if (typeof value.kind === "string") found.push(value);
      else Object.values(value).forEach((entry) => refs(entry, found));
    }
    return found;
  };
  const actions = compiled.actions.filter(
    (action) =>
      action.kind === "eoa" &&
      action.target !== null &&
      !refs(action.operation).some((ref) => dynamic.has(ref.kind)),
  );
  assert.ok(actions.length > 0);
  for (const action of actions) {
    const records = await resolveCandidateAction({
      compiled,
      actionId: action.id,
      sdk: { encrypt: async () => assert.fail("unexpected SDK call") },
    });
    assert.deepEqual(records, []);
    assert.match(
      encodeCandidateEoaAction({
        compiled,
        actionId: action.id,
        resolved: {
          actionId: action.id,
          workloadFingerprint: compiled.fingerprint,
          references: records,
        },
      }).data,
      /^0x/,
    );
  }
});

test("resolver only encodes an admission after its canonical marker decrypts true", async () => {
  const compiled = workload(),
    actionId = "eoa-00-admit",
    account = compiled.definition.actors.eoaParticipants[0],
    marker = hash(2);
  const event = admissionAbi[0],
    values = { account, nonce: 9n, marker };
  const evidence = {
    "eoa-00-deposit": {
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
        logs: [
          {
            address: compiled.definition.contracts.candidatePool,
            topics: encodeEventTopics({
              abi: admissionAbi,
              eventName: "AdmissionRequested",
              args: values,
            }),
            data: encodeAbiParameters(
              event.inputs.filter((item) => !item.indexed),
              [values.nonce, values.marker],
            ),
            transactionHash: hash(1),
            blockHash: hash(7),
            blockNumber: 7n,
            logIndex: 1,
          },
        ],
      },
      header: { number: 7n, hash: hash(7) },
    },
  };
  const admissionSdk = {
    decryption: {
      decryptPublicValues: async (handles) => ({
        clearValues: { [handles[0]]: true },
        abiEncodedClearValues: `0x${"00".repeat(31)}01`,
        decryptionProof: "0x1234",
      }),
    },
  };
  const references = await resolveCandidateAction({
    compiled,
    actionId,
    sdk: admissionSdk,
    evidence,
  });
  assert.match(
    encodeCandidateEoaAction({
      compiled,
      actionId,
      resolved: { actionId, workloadFingerprint: compiled.fingerprint, references },
    }).data,
    /^0x/,
  );
  await assert.rejects(
    () =>
      resolveCandidateAction({
        compiled,
        actionId,
        sdk: {
          decryption: {
            decryptPublicValues: async (handles) => ({
              clearValues: { [handles[0]]: false },
              abiEncodedClearValues: `0x${"00".repeat(32)}`,
              decryptionProof: "0x1234",
            }),
          },
        },
        evidence,
      }),
    /marker is not true/,
  );
});

test("resolver rejects a valid other EOA action receipt under the expected event key before decrypting", async () => {
  const compiled = workload();
  const account = compiled.definition.actors.eoaParticipants[0];
  const source = {
    producer: {
      kind: "eoa",
      actionId: "eoa-01-deposit",
      actor: compiled.definition.actors.eoaParticipants[1],
      canonicalRecovery: {
        kind: "eoa",
        actionId: "eoa-01-deposit",
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
      logs: [
        {
          address: compiled.definition.contracts.candidatePool,
          topics: encodeEventTopics({
            abi: admissionAbi,
            eventName: "AdmissionRequested",
            args: { account, nonce: 9n, marker: hash(2) },
          }),
          data: encodeAbiParameters(
            admissionAbi[0].inputs.filter((item) => !item.indexed),
            [9n, hash(2)],
          ),
          transactionHash: hash(1),
          blockHash: hash(7),
          blockNumber: 7n,
          logIndex: 1,
        },
      ],
    },
    header: { number: 7n, hash: hash(7) },
  };
  await assert.rejects(
    () =>
      resolveCandidateAction({
        compiled,
        actionId: "eoa-00-admit",
        sdk: { decryption: { decryptPublicValues: async () => assert.fail("unexpected decrypt") } },
        evidence: { "eoa-00-deposit": source },
      }),
    /producer evidence/,
  );
});

test("resolver rejects same-kind EOA evidence from the wrong compiled actor before decrypting", async () => {
  const compiled = workload();
  const account = compiled.definition.actors.eoaParticipants[0];
  const source = {
    producer: {
      kind: "eoa",
      actionId: "eoa-00-deposit",
      actor: compiled.definition.actors.eoaParticipants[1],
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
      logs: [
        {
          address: compiled.definition.contracts.candidatePool,
          topics: encodeEventTopics({
            abi: admissionAbi,
            eventName: "AdmissionRequested",
            args: { account, nonce: 9n, marker: hash(2) },
          }),
          data: encodeAbiParameters(
            admissionAbi[0].inputs.filter((item) => !item.indexed),
            [9n, hash(2)],
          ),
          transactionHash: hash(1),
          blockHash: hash(7),
          blockNumber: 7n,
          logIndex: 1,
        },
      ],
    },
    header: { number: 7n, hash: hash(7) },
  };
  await assert.rejects(
    () =>
      resolveCandidateAction({
        compiled,
        actionId: "eoa-00-admit",
        sdk: { decryption: { decryptPublicValues: async () => assert.fail("unexpected decrypt") } },
        evidence: { "eoa-00-deposit": source },
      }),
    /producer evidence/,
  );
});

test("resolver batch settlement decrypts the two graph-bound handles once and encodes them", () =>
  assertBatchSettlement());

test("resolver binds withdrawal and Morpho unwraps to their required wrapper receivers", () =>
  assertReceiverBoundUnwraps());
