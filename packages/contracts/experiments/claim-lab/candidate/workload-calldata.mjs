import { Interface, getAddress, isAddress, keccak256 } from "ethers";

import {
  validateCompiledCandidateWorkload,
  workloadFingerprint,
} from "./eoa-workload-definition.mjs";
import { canonical } from "./journal-values.mjs";

const ZERO = "0x";
const UINT64_MAX = 2n ** 64n - 1n;
const FUNCTIONS = new Set([
  "nativeTransfer()",
  "transfer(address,uint256)",
  "approve(address,uint256)",
  "setMorphoYieldAdapter(address,uint256)",
  "multicall(bytes[])",
  "wrap(address,uint256)",
  "confidentialTransferAndCall(address,bytes32,bytes,bytes)",
  "finalizeAdmission(address,uint256,bool,bytes)",
  "closeDraw()",
  "checkPrize(uint256,address,uint256,uint64,bytes32,bytes32[],bytes32[],bytes32[])",
  "claimPrize()",
  "claimPrizeToSavings()",
  "requestMorphoPrincipalUnwrap()",
  "finalizeUnwrap(bytes32,uint64,bytes)",
  "supplyAvailableMorphoPrincipal()",
  "exitMembership()",
  "closeWithdrawalBatch(uint256)",
  "settleWithdrawalBatch(uint256,uint64,uint64,bytes)",
  "processWithdrawal(uint256,address)",
  "requestWithdrawal(bytes32,bytes)",
]);
const CONSTRUCTORS = new Set([
  "wrapper(address)",
  "pool(address,uint256,uint256)",
  "adapter(address,address,address,address,(address,address,address,address,uint256))",
]);
const fail = (message) => {
  throw new Error(`candidate workload calldata: ${message}`);
};
const hex = (value, label, bytes) => {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) fail(`invalid ${label}`);
  if (bytes !== undefined && value.length !== 2 + bytes * 2) fail(`invalid ${label} width`);
  return value.toLowerCase();
};
const uint = (value, label, maximum = 2n ** 256n - 1n) => {
  try {
    const result = BigInt(value);
    if (result < 0n || result > maximum) throw new Error();
    return result;
  } catch {
    fail(`invalid ${label}`);
  }
};
const address = (value, label) => {
  if (!isAddress(value)) fail(`invalid ${label}`);
  return getAddress(value);
};
const decimalMicro = (micro) => {
  const value = uint(micro, "USDC allocation");
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
};

/**
 * Turns one already-compiled EOA graph action plus its scoped, resolved inputs
 * into the data-only part of a DurableEoaSender request.  Resolution, signing,
 * nonces, and transport deliberately remain outside this boundary.
 */
export function encodeCandidateEoaAction({ compiled, actionId, resolved } = {}) {
  const workload = validateCompiledCandidateWorkload(compiled);
  const action = eoaAction(workload, actionId);
  assertResolvedScope(workload, action, resolved);
  const records = new RecordIndex(resolved.references ?? []);
  const data =
    action.target === null
      ? encodeCreation(action, workload, resolved)
      : encodeOperation(action.operation, action, workload, records);
  const value = uint(action.operation.value ?? "0", "action value");
  records.assertConsumed();
  return requestFor(action, workload, data, value);
}

function eoaAction(workload, actionId) {
  if (typeof actionId !== "string") fail("invalid action ID");
  const action = workload.actions.find((entry) => entry.id === actionId);
  if (!action) fail("unknown action ID");
  if (action.kind !== "eoa") fail("external Safe barrier cannot be EOA encoded");
  return action;
}

function assertResolvedScope(workload, action, resolved) {
  if (!resolved || typeof resolved !== "object" || Array.isArray(resolved))
    fail("invalid resolved data");
  if (
    resolved.workloadFingerprint !== undefined &&
    resolved.workloadFingerprint !== workloadFingerprint(workload)
  )
    fail("resolved data belongs to a different workload");
  if (resolved.actionId !== undefined && resolved.actionId !== action.id)
    fail("resolved data belongs to a different action");
}

function requestFor(action, workload, data, value) {
  const target = action.target === null ? null : address(action.target, "action target");
  if (
    target !== null &&
    action.operation.signature !== "nativeTransfer()" &&
    !workload.definition.allowedEoaTargets.includes(target)
  )
    fail("action target is not allowed");
  return Object.freeze({
    intentId: action.id,
    sender: address(action.actor, "action actor"),
    to: target,
    data,
    value,
    fundingWei: value,
    usdcCommitment:
      action.id === "bootstrap-usdc" ? decimalMicro(action.allocation.usdcMicro) : "0",
  });
}

function encodeCreation(action, workload, resolved) {
  const creation = action.provenance;
  if (!creation || !CONSTRUCTORS.has(creation.constructor?.signature))
    fail("unsupported creation action");
  const bytecode = hex(resolved.creationBytecode, "creation bytecode");
  if (bytecode === ZERO || keccak256(bytecode).toLowerCase() !== creation.creationBytecodeHash)
    fail("creation bytecode hash mismatch");
  const types = creation.constructor.signature.slice(
    creation.constructor.signature.indexOf("(") + 1,
    -1,
  );
  const input = `${bytecode}${new Interface([`constructor(${types})`]).encodeDeploy(creation.constructor.args).slice(2)}`;
  if (keccak256(input).toLowerCase() !== creation.inputDigest)
    fail("creation input digest mismatch");
  if (!workload.definition.creationInputDigests.includes(creation.inputDigest))
    fail("creation input is unapproved");
  return input;
}

function encodeOperation(operation, action, workload, records) {
  if (!operation || typeof operation !== "object" || !FUNCTIONS.has(operation.signature))
    fail("unsupported ABI operation");
  if (operation.signature === "nativeTransfer()") {
    if (operation.data !== ZERO || operation.args.length) fail("invalid native transfer");
    return ZERO;
  }
  const values = operation.args.map((arg) => resolveValue(arg, action, workload, records));
  validateOperation(operation.signature, values);
  try {
    return new Interface([`function ${operation.signature}`]).encodeFunctionData(
      operation.signature,
      values,
    );
  } catch {
    fail("ABI argument encoding failed");
  }
}

function resolveValue(value, action, workload, records) {
  if (Array.isArray(value))
    return value.map((entry) => resolveValue(entry, action, workload, records));
  if (!value || typeof value !== "object") return value;
  if (typeof value.signature === "string") return encodeOperation(value, action, workload, records);
  if (typeof value.kind !== "string") return value;
  if (value.kind === "abiBytes") {
    const data = hex(value.data, "ABI bytes");
    if (value.tag !== "0x506aab00" || value.length !== 36 || data.length !== 74)
      fail("invalid prize funding data");
    const amount = uint(value.encoded?.value, "prize funding amount", UINT64_MAX);
    if (data !== `0x506aab00${amount.toString(16).padStart(64, "0")}`)
      fail("invalid prize funding amount");
    return data;
  }
  const record = records.take(value, action, workload);
  return checkedResolvedValue(value, record.value);
}

function checkedResolvedValue(reference, value) {
  const type = reference.abiType ?? (reference.kind === "delegateData" ? "bytes" : undefined);
  if (type === "bytes32") return hex(value, "bytes32 reference", 32);
  if (type === "bytes") return hex(value, "bytes reference");
  if (type === "uint64") return uint(value, "uint64 reference", UINT64_MAX);
  if (type === "uint256") return uint(value, "uint256 reference");
  if (type === "bytes32[]") {
    if (!Array.isArray(value) || value.length !== 32) fail("invalid depth-32 proof");
    return value.map((entry) => hex(entry, "proof node", 32));
  }
  fail("unsupported resolved ABI type");
}

function validateOperation(signature, values) {
  if (signature === "finalizeAdmission(address,uint256,bool,bytes)" && values[2] !== true)
    fail("admission must be positive");
  if (
    signature === "checkPrize(uint256,address,uint256,uint64,bytes32,bytes32[],bytes32[],bytes32[])"
  ) {
    if (![values[5], values[6], values[7]].every((proof) => proof.length === 32))
      fail("invalid prize proof depth");
  }
}

class RecordIndex {
  constructor(records) {
    if (!Array.isArray(records)) fail("invalid resolved references");
    this.records = records.map((record) => {
      if (!record || typeof record !== "object" || Array.isArray(record) || !record.reference)
        fail("invalid resolved reference");
      return { ...record, used: false };
    });
    this.proofBundles = new Map();
  }

  take(reference, action, workload) {
    const matches = this.records.filter(
      (record) => !record.used && canonical(record.reference) === canonical(reference),
    );
    if (matches.length !== 1) fail("unresolved reference or mixed provenance");
    const record = matches[0];
    const scope = record.scope;
    if (
      !scope ||
      typeof scope !== "object" ||
      scope.actionId !== action.id ||
      scope.workloadFingerprint !== workloadFingerprint(workload)
    )
      fail("resolved reference has wrong scope");
    if (reference.kind === "sdkInput") {
      if (
        scope.producer !== reference.producer ||
        scope.contractRole !== reference.contractRole ||
        scope.actor !== reference.actor
      )
        fail("SDK input provenance mismatch");
      if (
        reference.amount?.kind === "currentPrincipal" &&
        canonical(scope.currentPrincipal) !== canonical(reference.amount)
      )
        fail("current principal provenance mismatch");
    }
    if (reference.kind === "historicalProof") this.#proofScope(reference, scope, action.id);
    record.used = true;
    return record;
  }

  #proofScope(reference, scope, actionId) {
    if (
      scope.producer !== reference.producer ||
      scope.contractRole !== reference.contractRole ||
      scope.beneficiary !== reference.beneficiary ||
      scope.depth !== 32 ||
      typeof scope.bundleId !== "string" ||
      !scope.bundleId
    )
      fail("historical proof provenance mismatch");
    const prior = this.proofBundles.get(actionId);
    if (prior && prior !== scope.bundleId) fail("mixed historical proof bundle");
    this.proofBundles.set(actionId, scope.bundleId);
  }

  assertConsumed() {
    if (this.records.some((record) => !record.used)) fail("unrelated resolved reference");
  }
}
