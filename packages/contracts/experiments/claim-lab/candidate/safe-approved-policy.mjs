import { createHash } from "node:crypto";
import { getAddress, isAddress } from "ethers";

import { canonical } from "./journal-values.mjs";

const UINT = /^(0|[1-9][0-9]*)$/;
const HASH = /^[0-9a-f]{64}$/;
const fail = (message) => {
  throw new Error(`safe approved policy: ${message}`);
};

function address(value, label) {
  if (typeof value !== "string" || !isAddress(value)) fail(`invalid ${label}`);
  return getAddress(value);
}
function caps(value) {
  if (
    !value ||
    Object.keys(value).length !== 3 ||
    !UINT.test(value.maxAggregateFeeWei ?? "") ||
    !UINT.test(value.maxSafeFeePerGas ?? "") ||
    !Number.isSafeInteger(value.maxSafeIntents) ||
    value.maxSafeIntents < 1
  )
    fail("invalid caps");
  return Object.freeze({
    maxAggregateFeeWei: value.maxAggregateFeeWei,
    maxSafeFeePerGas: value.maxSafeFeePerGas,
    maxSafeIntents: value.maxSafeIntents,
  });
}

function validateApprovalReferenceAndExpiry(approval, now) {
  if (
    !approval ||
    Object.keys(approval).length !== 4 ||
    typeof approval.reference !== "string" ||
    !approval.reference
  )
    fail("invalid approval reference");
  if (!Number.isSafeInteger(approval.expiresAt) || now() >= approval.expiresAt)
    fail("approval expired");
}

function validateJournalRunBinding(journal, approval) {
  if (
    !journal ||
    typeof journal.runId !== "string" ||
    typeof journal.envelopeIdentity !== "string" ||
    !HASH.test(journal.envelopeIdentity) ||
    (journal.startedAt === null) !== (journal.deadlineAt === null)
  )
    fail("invalid run binding");
  if (
    !approval.binding ||
    Object.keys(approval.binding).length !== 2 ||
    approval.binding.runId !== journal.runId ||
    approval.binding.baseEnvelopeIdentity !== journal.envelopeIdentity
  )
    fail("wrong run binding");
}

function validateFixedSafeExpectation(expected) {
  if (expected?.chainId !== 11155111 || (expected?.durationMs ?? 7_200_000) !== 7_200_000)
    fail("invalid fixed chain or duration");
}

function buildSafePolicyRecord({ approval, journal, expected }) {
  return {
    runId: journal.runId,
    baseEnvelopeIdentity: journal.envelopeIdentity,
    safe: address(expected.safe, "Safe"),
    entryPoint: address(expected.entryPoint, "EntryPoint"),
    chainId: 11155111,
    durationMs: expected.durationMs ?? 7_200_000,
    approvalReference: approval.reference,
    expiresAt: approval.expiresAt,
    caps: caps(approval.caps),
  };
}

function policyIdentity(record) {
  return createHash("sha256").update(canonical(record)).digest("hex");
}

/** Builds an inactive, operator-injected Safe-only policy capability. */
export function createSafePolicyCapability({ approval, journal, expected, now = Date.now } = {}) {
  validateApprovalReferenceAndExpiry(approval, now);
  validateJournalRunBinding(journal, approval);
  validateFixedSafeExpectation(expected);
  const capability = buildSafePolicyRecord({ approval, journal, expected });
  return Object.freeze({ ...capability, policyIdentity: policyIdentity(capability) });
}

export function persistedSafePolicy(capability) {
  if (
    !capability ||
    typeof capability.policyIdentity !== "string" ||
    !HASH.test(capability.policyIdentity)
  )
    fail("invalid capability");
  if (Object.keys(capability).length !== 10) fail("invalid capability fields");
  return {
    policyIdentity: capability.policyIdentity,
    runId: capability.runId,
    baseEnvelopeIdentity: capability.baseEnvelopeIdentity,
    safe: capability.safe,
    entryPoint: capability.entryPoint,
    chainId: capability.chainId,
    durationMs: capability.durationMs,
    approvalReference: capability.approvalReference,
    expiresAt: capability.expiresAt,
    caps: capability.caps,
  };
}

export function validPersistedSafePolicy(value) {
  try {
    if (!value || Object.keys(value).length !== 10) return false;
    const record = persistedSafePolicy(value);
    return (
      record.chainId === 11155111 &&
      record.durationMs === 7_200_000 &&
      Number.isSafeInteger(record.expiresAt) &&
      typeof record.runId === "string" &&
      HASH.test(record.baseEnvelopeIdentity) &&
      address(record.safe, "Safe") === record.safe &&
      address(record.entryPoint, "EntryPoint") === record.entryPoint &&
      caps(record.caps).maxSafeIntents === record.caps.maxSafeIntents &&
      createHash("sha256")
        .update(
          canonical({
            runId: record.runId,
            baseEnvelopeIdentity: record.baseEnvelopeIdentity,
            safe: record.safe,
            entryPoint: record.entryPoint,
            chainId: record.chainId,
            durationMs: record.durationMs,
            approvalReference: record.approvalReference,
            expiresAt: record.expiresAt,
            caps: record.caps,
          }),
        )
        .digest("hex") === record.policyIdentity
    );
  } catch {
    return false;
  }
}
