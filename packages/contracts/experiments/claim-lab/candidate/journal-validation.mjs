import { createHash } from "node:crypto";

import {
  validatePersistedCaps,
  validatePersistedUniqueness,
  validateRecomputedBudget,
  validIntentBudget,
} from "./budget-validation.mjs";
import {
  actualAttemptCount,
  validAttempt,
  validateObservations,
  validatePersistedErrors,
} from "./attempt-observation-validation.mjs";
import { validateStoredReceipt } from "./receipt.mjs";
import { validPersistedIntentFields as validFields, validRequest } from "./intent-validation.mjs";
import { validPersistedSafePolicy } from "./safe-approved-policy.mjs";
import {
  isNatural,
  validBudget,
  validClock,
  validTarget as validTargetShape,
  validTransition,
} from "./state-shape-validation.mjs";
import { validateWorkloadJournalBinding } from "./workload-journal-binding.mjs";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const MAX_INTENT_ID = 256;
const MAX_INPUT = 262_144;
const MAX_RAW = 524_288;
const VERSION = 1;

const fail = (message) => {
  throw new Error(`candidate journal: ${message}`);
};
const validAddress = (value) => typeof value === "string" && ADDRESS.test(value);
const validHash = (value) => typeof value === "string" && HASH.test(value);

function natural(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`invalid ${label}`);
  return value;
}

export function validateJournalEnvelope(envelope) {
  if (!envelope || envelope.chainId !== 11155111 || typeof envelope.id !== "string" || !envelope.id)
    fail("foreign or invalid envelope");
  natural(envelope.maxSignedTransactions, "signature cap");
  natural(envelope.durationMs, "duration");
  for (const key of ["maxFeeWei", "maxFundingWei", "maxUsdcMicro", "maxGasPriceWei"])
    if (!UINT.test(envelope[key] ?? "")) fail(`invalid envelope ${key}`);
}

export function validatePersistedJournalState(state, envelope, identity) {
  validateStateIdentity(state, envelope, identity);
  validateStateStructure(state, envelope);
  for (const intent of state.intents) validatePersistedIntent(intent);
  validateRecomputedBudget(state);
  validatePersistedCaps(state, envelope);
  validatePersistedUniqueness(state);
}

function validateStateIdentity(state, envelope, identity) {
  if (
    !state ||
    state.version !== VERSION ||
    typeof state.runId !== "string" ||
    state.chainId !== 11155111 ||
    state.envelopeId !== envelope.id ||
    state.envelopeIdentity !== identity
  )
    fail("invalid journal identity");
}

function validateStateStructure(state, envelope) {
  if (
    !Array.isArray(state.intents) ||
    !state.budget ||
    !validClock(state, envelope) ||
    !validBudget(state.budget) ||
    !validStateMetadata(state)
  )
    fail("invalid journal structure");
}

function validStateMetadata(state) {
  const validPolicy = state.safePolicy == null || validPersistedSafePolicy(state.safePolicy);
  const validPolicyIdentity =
    state.safePolicyIdentity == null || typeof state.safePolicyIdentity === "string";
  const validWorkload =
    state.workloadDefinition === undefined ||
    state.workloadDefinition === null ||
    validWorkloadDefinition(state.workloadDefinition);
  const policyMatches =
    !state.safePolicy || state.safePolicyIdentity === state.safePolicy.policyIdentity;
  const noDanglingIdentity =
    state.safePolicy || state.safePolicyIdentity === undefined || state.safePolicyIdentity === null;
  return validPolicy && validPolicyIdentity && validWorkload && policyMatches && noDanglingIdentity;
}

function validWorkloadDefinition(value) {
  try {
    validateWorkloadJournalBinding(value);
    return true;
  } catch {
    return false;
  }
}

function validatePersistedIntent(intent) {
  if (!validPersistedIntentFields(intent)) fail("invalid persisted intent");
  if (
    intent.signed &&
    (!HEX.test(intent.signed.raw) ||
      intent.signed.raw.length > MAX_RAW ||
      !validHash(intent.signed.hash))
  )
    fail("invalid persisted signature");
  if (
    intent.kind === "user-operation" &&
    intent.signed &&
    (intent.signed.hash !== intent.userOperation.userOperationHash ||
      !intent.userOperation.wireDigest ||
      createHash("sha256").update(intent.signed.raw).digest("hex") !==
        intent.userOperation.wireDigest.slice(2))
  )
    fail("invalid persisted UserOperation signature");
  validatePersistedTransition(intent);
}

function validPersistedIntentFields(intent) {
  return validFields(intent, {
    validAddress,
    validHash,
    isNatural,
    validTarget,
    validIntentBudget,
    uint: UINT,
    maxIntentId: MAX_INTENT_ID,
  });
}

function validTarget(to, input) {
  return validTargetShape(to, input, { validAddress, hex: HEX, maxInput: MAX_INPUT });
}

function validatePersistedTransition(intent) {
  const hasSigned = Boolean(intent.signed);
  const terminal = intent.terminal;
  if (!validTransition(intent.state, hasSigned, actualAttemptCount(intent), terminal))
    fail("invalid persisted transition");
  validatePersistedErrors(intent, validAttempt);
  validateObservations(intent);
  if (terminal) {
    if (intent.state !== "terminal" || !actualAttemptCount(intent))
      fail("invalid persisted terminal");
    validateStoredReceipt(terminal, intent);
  } else if (intent.state === "terminal") fail("invalid persisted terminal");
}

export function validateJournalRequest(request) {
  if (
    !validRequest(request, {
      validAddress,
      validHash,
      isNatural,
      validTarget,
      uint: UINT,
      maxIntentId: MAX_INTENT_ID,
    })
  )
    fail("invalid intent");
}

export const validJournalSignedPayload = (raw, hash) => HEX.test(raw) && validHash(hash);
