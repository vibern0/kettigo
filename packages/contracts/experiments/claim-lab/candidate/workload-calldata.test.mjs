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

test("rejects scoped record substitutions and noncanonical resolved uint values", () => {
  const compiled = workload();
  const admission = compiled.actions.find((entry) => entry.id === "eoa-00-admit");
  const receipt = resolvedFor(compiled, admission);
  receipt.references.find(
    (record) => record.reference.kind === "receiptEvent",
  ).scope.reference.producer = "eoa-01-deposit";
  assert.throws(
    () => encodeCandidateEoaAction({ compiled, actionId: admission.id, resolved: receipt }),
    /provenance|scope/,
  );

  const withdrawal = compiled.actions.find((entry) => entry.id === "final-request-eoa-00");
  const principal = resolvedFor(compiled, withdrawal);
  principal.references.find(
    (record) => record.reference.kind === "sdkInput",
  ).scope.encryption.actor = compiled.definition.actors.eoaParticipants[1];
  assert.throws(
    () => encodeCandidateEoaAction({ compiled, actionId: withdrawal.id, resolved: principal }),
    /encryption|provenance/,
  );

  const settlement = compiled.actions.find((entry) => entry.id === "final-batch-settle");
  const uints = resolvedFor(compiled, settlement);
  uints.references.find((record) => record.reference.abiType === "uint64").value = true;
  assert.throws(
    () => encodeCandidateEoaAction({ compiled, actionId: settlement.id, resolved: uints }),
    /invalid uint64/,
  );
});

test("decodes nested deposits, prize proofs, settlements, unwraps, and current-principal requests exactly", () => {
  const compiled = workload();
  assertDepositEncoding(compiled);
  assertPrizeAndWithdrawalEncoding(compiled);
});

function assertDepositEncoding(compiled) {
  const deposit = encoded(compiled, "eoa-00-deposit");
  const wrapper = new Interface([
    "function multicall(bytes[])",
    "function wrap(address,uint256)",
    "function confidentialTransferAndCall(address,bytes32,bytes,bytes)",
  ]);
  const calls = wrapper.decodeFunctionData("multicall", deposit.data)[0];
  assert.equal(calls.length, 2);
  const wrapped = wrapper.decodeFunctionData("wrap", calls[0]);
  assert.equal(wrapped[0], compiled.definition.actors.eoaParticipants[0]);
  assert.equal(wrapped[1], 3000000n);
  const transfer = wrapper.decodeFunctionData("confidentialTransferAndCall", calls[1]);
  assert.equal(transfer[0], compiled.definition.contracts.candidatePool);
  assert.equal(transfer[1], `0x${"11".repeat(32)}`);
  assert.equal(transfer[2], "0x1234");
  assert.equal(transfer[3], "0x1234");
}

function assertPrizeAndWithdrawalEncoding(compiled) {
  const pool = new Interface([
    "function checkPrize(uint256,address,uint256,uint64,bytes32,bytes32[],bytes32[],bytes32[])",
    "function settleWithdrawalBatch(uint256,uint64,uint64,bytes)",
    "function requestWithdrawal(bytes32,bytes)",
  ]);
  const check = pool.decodeFunctionData(
    "checkPrize",
    encoded(compiled, "check-stage8-eoa-00").data,
  );
  assert.equal(check.length, 8);
  assert.equal(check[1], compiled.definition.actors.eoaParticipants[0]);
  assert.equal(check[2], 1n);
  assert.equal(check[3], 1n);
  assert.equal(check[4], `0x${"11".repeat(32)}`);
  assert.equal(check[5].length, 32);
  assert.equal(check[6].length, 32);
  assert.equal(check[7].length, 32);

  const settlement = pool.decodeFunctionData(
    "settleWithdrawalBatch",
    encoded(compiled, "final-batch-settle").data,
  );
  assert.deepEqual([...settlement], [1n, 1n, 1n, "0x1234"]);
  const unwrap = new Interface([
    "function finalizeUnwrap(bytes32,uint64,bytes)",
  ]).decodeFunctionData("finalizeUnwrap", encoded(compiled, "final-finalize-eoa-00").data);
  assert.deepEqual([...unwrap], [`0x${"11".repeat(32)}`, 1n, "0x1234"]);
  assert.deepEqual(
    [
      ...pool.decodeFunctionData(
        "requestWithdrawal",
        encoded(compiled, "final-request-eoa-00").data,
      ),
    ],
    [`0x${"11".repeat(32)}`, "0x1234"],
  );
}

test("rejects every record scope boundary, malformed widths, and graph mutation", () => {
  const compiled = workload();
  const vectors = [
    ["eoa-00-admit", (record) => (record.scope.contract = compiled.definition.contracts.wrapper)],
    ["eoa-00-admit", (record) => (record.scope.reference.event = "WrongEvent")],
    [
      "final-finalize-eoa-00",
      (record) => (record.scope.reference.receiver = compiled.definition.actors.eoaParticipants[1]),
    ],
    [
      "eoa-00-deposit",
      (record) => record.reference.kind === "sdkProof" && (record.scope.inputReference = {}),
    ],
    [
      "final-request-eoa-00",
      (record) =>
        record.reference.kind === "sdkInput" &&
        (record.scope.currentPrincipal.account = compiled.definition.actors.eoaParticipants[1]),
    ],
  ];
  for (const [actionId, mutate] of vectors) {
    const action = compiled.actions.find((entry) => entry.id === actionId);
    const resolved = resolvedFor(compiled, action);
    resolved.references.forEach(mutate);
    assert.throws(() => encodeCandidateEoaAction({ compiled, actionId, resolved }));
  }
  const settlement = compiled.actions.find((entry) => entry.id === "final-batch-settle");
  for (const value of ["01", "+1", "1.0", " 1", true, 1, 1n, "18446744073709551616"]) {
    const resolved = resolvedFor(compiled, settlement);
    resolved.references.find((record) => record.reference.abiType === "uint64").value = value;
    assert.throws(
      () => encodeCandidateEoaAction({ compiled, actionId: settlement.id, resolved }),
      /invalid uint64/,
    );
  }
  const malformed = resolvedFor(compiled, settlement);
  malformed.references.find((record) => record.reference.abiType === "bytes").value = "0x0";
  assert.throws(
    () => encodeCandidateEoaAction({ compiled, actionId: settlement.id, resolved: malformed }),
    /invalid bytes/,
  );
  const changed = globalThis.structuredClone(compiled);
  changed.actions[0].target = compiled.definition.contracts.wrapper;
  assert.throws(
    () => encodeCandidateEoaAction({ compiled: changed, actionId: "bootstrap-eth", resolved: {} }),
    /compiled workload differs/,
  );
});

function encoded(compiled, actionId) {
  const action = compiled.actions.find((entry) => entry.id === actionId);
  return encodeCandidateEoaAction({ compiled, actionId, resolved: resolvedFor(compiled, action) });
}

function resolvedFor(compiled, action) {
  const all = refs(action.operation).filter((reference) => reference.kind !== "abiBytes");
  const references = refs(action.operation)
    .filter((reference) => reference.kind !== "abiBytes")
    .map((reference) => ({
      reference,
      value: valueFor(reference),
      scope: {
        actionId: action.id,
        workloadFingerprint: compiled.fingerprint,
        reference: globalThis.structuredClone(reference),
        contract: reference.contractRole
          ? compiled.definition.contracts[reference.contractRole]
          : null,
        ...(reference.kind === "sdkInput"
          ? {
              producer: reference.producer,
              contractRole: reference.contractRole,
              actor: reference.actor,
              purpose: reference.purpose,
              ...(reference.amount?.kind === "currentPrincipal"
                ? { currentPrincipal: globalThis.structuredClone(reference.amount) }
                : {}),
              encryption: {
                contract: compiled.definition.contracts[reference.contractRole],
                actor: reference.actor,
                type: "euint64",
              },
            }
          : {}),
        ...(reference.kind === "sdkProof"
          ? {
              inputReference: all.find(
                (entry) => entry.kind === "sdkInput" && entry.producer === reference.producer,
              ),
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
