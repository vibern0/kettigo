import assert from "node:assert/strict";
import { test } from "node:test";

import { Interface, keccak256 } from "ethers";

import { encodeCandidateEoaAction } from "./workload-calldata.mjs";
import { compileCandidateWorkload } from "./eoa-workload-definition.mjs";
import {
  workloadDefinitionFixture,
  workloadManifestFixture,
} from "./eoa-workload-test-fixture.mjs";

function workload() {
  return compileCandidateWorkload(workloadDefinitionFixture(), workloadManifestFixture());
}

test("encodes native funding as a data-only EOA request with decimal USDC", () => {
  const compiled = workload();
  const result = encodeCandidateEoaAction({ compiled, actionId: "bootstrap-eth", resolved: {} });
  assert.deepEqual(result, {
    intentId: "bootstrap-eth",
    sender: compiled.definition.actors.bootstrapOperator,
    to: compiled.definition.actors.sponsor,
    data: "0x",
    value: 1000000000000000n,
    fundingWei: 1000000000000000n,
    usdcCommitment: "0",
  });
});

test("encodes bootstrap USDC in decimal units rather than micro units", () => {
  const compiled = workload();
  const result = encodeCandidateEoaAction({ compiled, actionId: "bootstrap-usdc", resolved: {} });
  const abi = new Interface(["function transfer(address,uint256)"]);
  const decoded = abi.decodeFunctionData("transfer", result.data);
  assert.equal(decoded[0], compiled.definition.actors.sponsor);
  assert.equal(decoded[1], 78000000n);
  assert.equal(result.usdcCommitment, "78");
});

test("rejects Safe barriers and rejects creation whose bytecode hash or full input digest is wrong", () => {
  const compiled = workload();
  assert.throws(
    () => encodeCandidateEoaAction({ compiled, actionId: "safe-initial-deposit", resolved: {} }),
    /external Safe barrier/,
  );
  assert.throws(
    () =>
      encodeCandidateEoaAction({
        compiled,
        actionId: "deploy-wrapper",
        resolved: { creationBytecode: "0x6000" },
      }),
    /creation bytecode hash/,
  );
});

test("encodes a creation only when the bytecode and complete constructor input match both manifests", () => {
  const definition = workloadDefinitionFixture();
  const manifest = workloadManifestFixture();
  const bytecode = "0x6000";
  const constructor = new Interface(["constructor(address)"]).encodeDeploy([
    definition.contracts.underlying,
  ]);
  const input = `${bytecode}${constructor.slice(2)}`;
  definition.deploymentCreationHashes[0] = keccak256(bytecode);
  definition.creationInputDigests[0] = keccak256(input);
  manifest.creations[0].creationBytecodeHash = keccak256(bytecode);
  manifest.creations[0].inputDigest = keccak256(input);
  const compiled = compileCandidateWorkload(definition, manifest);
  const result = encodeCandidateEoaAction({
    compiled,
    actionId: "deploy-wrapper",
    resolved: { creationBytecode: bytecode },
  });
  assert.equal(result.to, null);
  assert.equal(result.data, input);
});

test("requires exact scoped SDK records for nested deposits", () => {
  const compiled = workload();
  assert.throws(
    () => encodeCandidateEoaAction({ compiled, actionId: "eoa-00-deposit", resolved: {} }),
    /unresolved reference/,
  );
});

test("encodes every closed non-creation EOA ABI family from one scoped record per reference", () => {
  const compiled = workload();
  for (const action of compiled.actions.filter(
    (entry) => entry.kind === "eoa" && entry.target !== null,
  )) {
    const result = encodeCandidateEoaAction({
      compiled,
      actionId: action.id,
      resolved: resolvedFor(compiled, action),
    });
    assert.equal(result.intentId, action.id);
    assert.equal(result.fundingWei, result.value);
    assert.notEqual(result.usdcCommitment, "78000000");
  }
});

test("rejects a checkPrize proof assembled from more than one historical bundle", () => {
  const compiled = workload();
  const action = compiled.actions.find((entry) => entry.id === "check-stage8-eoa-00");
  const resolved = resolvedFor(compiled, action);
  const proof = resolved.references.find((record) => record.reference.kind === "historicalProof");
  proof.scope.bundleId = "other-bundle";
  assert.throws(
    () => encodeCandidateEoaAction({ compiled, actionId: action.id, resolved }),
    /mixed historical proof bundle/,
  );
});

function resolvedFor(compiled, action) {
  const references = refs(action.operation)
    .filter((reference) => reference.kind !== "abiBytes")
    .map((reference) => ({
      reference,
      value: valueFor(reference),
      scope: {
        actionId: action.id,
        workloadFingerprint: compiled.fingerprint,
        ...(reference.kind === "sdkInput"
          ? {
              producer: reference.producer,
              contractRole: reference.contractRole,
              actor: reference.actor,
              ...(reference.amount?.kind === "currentPrincipal"
                ? { currentPrincipal: reference.amount }
                : {}),
            }
          : {}),
        ...(reference.kind === "historicalProof"
          ? {
              producer: reference.producer,
              contractRole: reference.contractRole,
              beneficiary: reference.beneficiary,
              depth: 32,
              bundleId: "single-bundle",
            }
          : {}),
      },
    }));
  return { workloadFingerprint: compiled.fingerprint, actionId: action.id, references };
}

function refs(value, found = []) {
  if (Array.isArray(value)) value.forEach((entry) => refs(entry, found));
  else if (value && typeof value === "object") {
    if (typeof value.kind === "string") found.push(value);
    else Object.values(value).forEach((entry) => refs(entry, found));
  }
  return found;
}

function valueFor(reference) {
  if (reference.kind === "delegateData") return "0x1234";
  if (reference.abiType === "uint64" || reference.abiType === "uint256") return "1";
  if (reference.abiType === "bytes32") return `0x${"11".repeat(32)}`;
  if (reference.abiType === "bytes") return "0x1234";
  if (reference.abiType === "bytes32[]")
    return Array.from({ length: 32 }, () => `0x${"22".repeat(32)}`);
  throw new Error(`fixture lacks ${reference.abiType}`);
}
