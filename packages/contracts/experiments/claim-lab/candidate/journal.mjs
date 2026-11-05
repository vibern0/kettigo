import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { acquireLease, assertLease, persist, releaseLease } from "./persistence.mjs";
import {
  findIntent,
  serializeReceipt,
  validateReceipt,
  validateStoredReceipt,
} from "./receipt.mjs";
import {
  assertBudget,
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
import {
  isNatural,
  validBudget,
  validClock,
  validTarget as validTargetShape,
  validTransition,
} from "./state-shape-validation.mjs";
import { loadState } from "./state-storage.mjs";
import { assertOpen, assertSigningAllowed } from "./journal-guards.mjs";

export const ORIGINAL_ENVELOPE = Object.freeze({
  id: "merkle-fhe-v2-sepolia-2026-11-04",
  chainId: 11155111,
  maxSignedTransactions: 600,
  maxFeeWei: "3000000000000000",
  maxFundingWei: "5000000000000000",
  maxUsdcMicro: "100000000",
  maxGasPriceWei: "100000",
  durationMs: 7_200_000,
});

const VERSION = 1;
const JOURNAL = "journal.json";
const LOCK = "writer.lock";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const MAX_INTENT_ID = 256;
const MAX_INPUT = 262_144;
const MAX_RAW = 524_288;
const MAX_ERROR = 2_048;
const MAX_JOURNAL_BYTES = 2_000_000;

const fail = (message) => {
  throw new Error(`candidate journal: ${message}`);
};
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function canonical(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}
function envelopeIdentity(envelope) {
  return createHash("sha256").update(canonical(envelope)).digest("hex");
}
function validAddress(value) {
  return typeof value === "string" && ADDRESS.test(value);
}
function validHash(value) {
  return typeof value === "string" && HASH.test(value);
}
function decimalMicro(value) {
  if (
    typeof value !== "string" ||
    value.length > 80 ||
    !/^(0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(value)
  )
    fail("invalid USDC commitment");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(`${fraction}000000`.slice(0, 6));
}
function natural(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`invalid ${label}`);
  return value;
}
function unsigned(value, label) {
  if (typeof value !== "bigint" || value < 0n) fail(`invalid ${label}`);
  return value;
}
function budgetZero() {
  return {
    signedCount: 0,
    feeReservedWei: "0",
    feeActualWei: "0",
    fundingCommittedWei: "0",
    usdcCommittedMicro: "0",
  };
}
function validateEnvelope(envelope) {
  if (!envelope || envelope.chainId !== 11155111 || typeof envelope.id !== "string" || !envelope.id)
    fail("foreign or invalid envelope");
  natural(envelope.maxSignedTransactions, "signature cap");
  natural(envelope.durationMs, "duration");
  for (const key of ["maxFeeWei", "maxFundingWei", "maxUsdcMicro", "maxGasPriceWei"])
    if (!UINT.test(envelope[key] ?? "")) fail(`invalid envelope ${key}`);
}
function validateState(state, envelope, identity) {
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
    !validBudget(state.budget)
  )
    fail("invalid journal structure");
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
  const shared =
    Boolean(intent) &&
    [
      typeof intent.intentId === "string" &&
        Boolean(intent.intentId) &&
        intent.intentId.length <= MAX_INTENT_ID,
      validAddress(intent.sender),
      isNatural(intent.nonce),
      validHash(intent.unsignedDigest),
      isNatural(intent.offeredAt),
      validTarget(intent.to, intent.input),
      validIntentBudget(intent),
      Array.isArray(intent.attempts),
      intent.observations === undefined || Array.isArray(intent.observations),
    ].every(Boolean);
  if (!shared) return false;
  if (intent.kind === undefined) return true;
  if (intent.kind !== "user-operation" || !intent.userOperation) return false;
  const metadata = intent.userOperation;
  return (
    Object.keys(metadata).length === 6 &&
    ["chainId", "entryPoint", "sender", "userOperationHash", "nonce", "wireDigest"].every((key) =>
      Object.hasOwn(metadata, key),
    ) &&
    metadata.chainId === 11155111 &&
    validAddress(metadata.entryPoint) &&
    metadata.sender === intent.sender &&
    validHash(metadata.userOperationHash) &&
    UINT.test(metadata.nonce) &&
    BigInt(metadata.nonce) === BigInt(intent.nonce) &&
    (metadata.wireDigest === null || validHash(metadata.wireDigest))
  );
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
function newState(envelope, identity) {
  return {
    version: VERSION,
    runId: randomUUID(),
    chainId: 11155111,
    envelopeId: envelope.id,
    envelopeIdentity: identity,
    startedAt: null,
    deadlineAt: null,
    budget: budgetZero(),
    intents: [],
  };
}

export class CandidateRunJournal {
  static async open({ directory, envelope, now = Date.now, failPublish = false } = {}) {
    validateEnvelope(envelope);
    if (typeof directory !== "string" || !directory) fail("state directory required");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const identity = envelopeIdentity(envelope);
    const lockPath = join(directory, LOCK);
    const token = randomUUID();
    await acquireLease(lockPath, token);
    try {
      const statePath = join(directory, JOURNAL);
      const { state, created } = await loadState({
        statePath,
        maxBytes: MAX_JOURNAL_BYTES,
        fail,
        create: () => newState(envelope, identity),
      });
      validateState(state, envelope, identity);
      if (created) await persist(statePath, state, failPublish);
      return new CandidateRunJournal({
        directory,
        envelope,
        identity,
        now,
        token,
        state,
        failPublish,
      });
    } catch (error) {
      await releaseLease(lockPath, token);
      throw error;
    }
  }

  constructor(options) {
    Object.assign(this, options);
    this.closed = false;
    this.closing = false;
    this.poisoned = null;
    this.tail = Promise.resolve();
  }
  snapshot() {
    return clone(this.state);
  }
  intent(intentId) {
    const intent = this.state.intents.find((entry) => entry.intentId === intentId);
    return intent ? clone(intent) : undefined;
  }
  actualSendCount(intentId) {
    const intent = this.state.intents.find((entry) => entry.intentId === intentId);
    if (!intent) fail("unknown intent");
    return actualAttemptCount(intent);
  }
  async close() {
    if (this.closed) return;
    if (this.closing) return this.tail;
    this.closing = true;
    const operation = this.tail.then(async () => {
      this.closed = true;
      await releaseLease(join(this.directory, LOCK), this.token);
    });
    this.tail = operation.catch(() => {});
    return operation;
  }

  async reserve(request) {
    return this.#mutate(async () => {
      validateRequest(request);
      const existing = this.state.intents.find((entry) => entry.intentId === request.intentId);
      if (existing) {
        if (sameRequest(existing, request)) return { replay: true, intent: clone(existing) };
        fail("duplicate intent has different unsigned request");
      }
      if (
        this.state.intents.some(
          (entry) =>
            entry.sender.toLowerCase() === request.sender.toLowerCase() &&
            entry.nonce === request.nonce,
        )
      )
        fail("sender nonce collision");
      const proposed = clone(this.state);
      addReservation(proposed, request, this.envelope, this.now, (budget, fee, funding, usdc) =>
        assertBudget({ state: this.state, budget, envelope: this.envelope, fee, funding, usdc }),
      );
      if (
        this.state.intents.some(
          (entry) =>
            entry.sender.toLowerCase() === request.sender.toLowerCase() &&
            entry.intentId !== request.intentId &&
            !entry.terminal,
        )
      )
        fail("sender has unresolved intent");
      await this.#commit(proposed);
      return { replay: false, intent: this.intent(request.intentId) };
    });
  }

  async saveSigned(intentId, raw, hash) {
    return this.#mutate(async () => {
      assertSigningAllowed(this, fail);
      if (!HEX.test(raw) || !validHash(hash)) fail("invalid signed payload");
      const proposed = clone(this.state);
      const intent = findIntent(proposed, intentId);
      if (intent.signed) {
        if (intent.signed.raw === raw && intent.signed.hash === hash) return clone(intent);
        fail("signature replacement refused");
      }
      intent.signed = { raw, hash };
      if (intent.kind === "user-operation")
        intent.userOperation.wireDigest = `0x${createHash("sha256").update(raw).digest("hex")}`;
      intent.state = "signed";
      await this.#commit(proposed);
      return this.intent(intentId);
    });
  }

  async assertSigningPermit() {
    return this.#mutate(async () => {
      assertSigningAllowed(this, fail);
      return true;
    });
  }

  async recordAttempt(intentId, { at = this.now(), error = null, unrecoverable = false } = {}) {
    return this.#mutate(async () => {
      assertSigningAllowed(this, fail);
      natural(at, "attempt time");
      if (error !== null && (typeof error !== "string" || !error)) fail("invalid attempt error");
      const proposed = clone(this.state);
      const intent = findIntent(proposed, intentId);
      if (!intent.signed) fail("attempt without durable signature");
      if (intent.terminal) fail("attempt after terminal");
      intent.attempts.push({
        at,
        error,
        unrecoverable: Boolean(unrecoverable),
        outcome: "started-or-unknown",
      });
      if (error && !intent.firstError) intent.firstError = error;
      if (error && unrecoverable && !intent.firstUnrecoverableError)
        intent.firstUnrecoverableError = error;
      intent.state = "broadcast-attempted";
      await this.#commit(proposed);
      return this.intent(intentId);
    });
  }

  async attemptWithPermit(intentId, send) {
    if (typeof send !== "function") fail("send callback required");
    return this.#mutate(async () => {
      assertSigningAllowed(this, fail);
      const proposed = clone(this.state);
      const intent = findIntent(proposed, intentId);
      if (!intent.signed) fail("attempt without durable signature");
      if (intent.terminal) fail("attempt after terminal");
      intent.attempts.push({
        at: this.now(),
        error: null,
        unrecoverable: false,
        outcome: "pre-send",
      });
      intent.state = "broadcast-attempted";
      await this.#commit(proposed);
      try {
        assertSigningAllowed(this, fail);
      } catch (error) {
        const suppressed = clone(this.state);
        const saved = findIntent(suppressed, intentId);
        saved.attempts.at(-1).outcome = "suppressed";
        saved.state = "signed";
        try {
          await this.#commit(suppressed);
        } catch {
          // The durable pre-send record remains conservatively unknown; keep the permit cause.
        }
        throw error;
      }
      return send();
    });
  }

  async recordObservation(intentId, { at = this.now(), stage, error, unrecoverable = false } = {}) {
    return this.#mutate(async () => {
      natural(at, "observation time");
      if (typeof stage !== "string" || !stage || stage.length > 64)
        fail("invalid observation stage");
      if (typeof error !== "string" || !error || error.length > MAX_ERROR)
        fail("invalid observation error");
      const proposed = clone(this.state);
      const intent = findIntent(proposed, intentId);
      if (!intent.signed) fail("observation without durable signature");
      (intent.observations ??= []).push({
        at,
        stage,
        error,
        unrecoverable: Boolean(unrecoverable),
      });
      if (!intent.firstError) intent.firstError = error;
      if (unrecoverable && !intent.firstUnrecoverableError) intent.firstUnrecoverableError = error;
      await this.#commit(proposed);
      return this.intent(intentId);
    });
  }

  async recordTerminal(intentId, receipt) {
    return this.#mutate(async () => {
      const proposed = clone(this.state);
      const intent = findIntent(proposed, intentId);
      validateReceipt(receipt, intent);
      if (!actualAttemptCount(intent)) fail("terminal requires broadcast attempt");
      if (BigInt(receipt.feeWei) > BigInt(intent.maxFeeWei)) fail("actual fee exceeds reservation");
      if (intent.terminal) {
        if (canonical(intent.terminal) === canonical(serializeReceipt(receipt)))
          return this.intent(intentId);
        fail("terminal receipt replacement refused");
      }
      intent.terminal = serializeReceipt(receipt);
      intent.state = "terminal";
      proposed.budget.feeActualWei = (
        BigInt(proposed.budget.feeActualWei) + BigInt(receipt.feeWei)
      ).toString();
      await this.#commit(proposed);
      return this.intent(intentId);
    });
  }

  async #commit(next) {
    validateState(next, this.envelope, this.identity);
    try {
      await persist(join(this.directory, JOURNAL), next, this.failPublish);
    } catch (error) {
      this.poisoned ??= error;
      throw error;
    }
    this.state = next;
  }
  async #mutate(operation) {
    if (this.closing) fail("journal is closed");
    if (this.closed || this.poisoned) assertOpen(this, fail);
    const next = this.tail.then(async () => {
      assertOpen(this, fail);
      await assertLease(join(this.directory, LOCK), this.token);
      return operation();
    });
    this.tail = next.catch(() => {});
    return next;
  }
}

function validateRequest(request) {
  if (
    !request ||
    typeof request.intentId !== "string" ||
    !request.intentId ||
    !validAddress(request.sender) ||
    !isNatural(request.nonce) ||
    !validHash(request.unsignedDigest) ||
    !validTarget(request.to, request.input) ||
    !isNatural(request.offeredAt) ||
    typeof request.maxGasPriceWei !== "bigint"
  )
    fail("invalid intent");
  if (request.kind !== undefined) {
    const meta = request.userOperation;
    if (
      request.kind !== "user-operation" ||
      !meta ||
      Object.keys(meta).length !== 5 ||
      !["chainId", "entryPoint", "sender", "userOperationHash", "nonce"].every((key) =>
        Object.hasOwn(meta, key),
      ) ||
      meta.chainId !== 11155111 ||
      !validAddress(meta.entryPoint) ||
      meta.sender !== request.sender ||
      !validHash(meta.userOperationHash) ||
      !UINT.test(meta.nonce) ||
      BigInt(meta.nonce) !== BigInt(request.nonce)
    )
      fail("invalid UserOperation intent");
  }
}
function sameRequest(intent, request) {
  return (
    intent.sender === request.sender &&
    intent.nonce === request.nonce &&
    intent.unsignedDigest === request.unsignedDigest &&
    intent.to === request.to &&
    intent.input === request.input &&
    intent.offeredAt === request.offeredAt &&
    intent.maxFeeWei === request.maxFeeWei.toString() &&
    intent.maxGasPriceWei === request.maxGasPriceWei.toString() &&
    intent.fundingWei === request.fundingWei.toString() &&
    intent.usdcCommitmentMicro === decimalMicro(request.usdcCommitment).toString()
  );
}
function addReservation(state, request, envelope, now, assertBudget) {
  const startedAt = state.startedAt ?? now();
  const deadlineAt = state.deadlineAt ?? startedAt + envelope.durationMs;
  if (now() >= deadlineAt) fail("deadline reached");
  const fee = unsigned(request.maxFeeWei, "fee reservation");
  const gasPrice = unsigned(request.maxGasPriceWei, "gas price");
  const funding = unsigned(request.fundingWei, "funding reservation");
  const usdc = decimalMicro(request.usdcCommitment);
  if (gasPrice > BigInt(envelope.maxGasPriceWei)) fail("gas price exceeds approved cap");
  assertBudget(state.budget, fee, funding, usdc);
  state.startedAt = startedAt;
  state.deadlineAt = deadlineAt;
  state.budget.signedCount += 1;
  state.budget.feeReservedWei = (BigInt(state.budget.feeReservedWei) + fee).toString();
  state.budget.fundingCommittedWei = (
    BigInt(state.budget.fundingCommittedWei) + funding
  ).toString();
  state.budget.usdcCommittedMicro = (BigInt(state.budget.usdcCommittedMicro) + usdc).toString();
  state.intents.push(savedIntent(request, fee, gasPrice, funding, usdc));
}
function savedIntent(request, fee, gasPrice, funding, usdc) {
  const intent = {
    ...request,
    maxFeeWei: fee.toString(),
    maxGasPriceWei: gasPrice.toString(),
    fundingWei: funding.toString(),
    usdcCommitmentMicro: usdc.toString(),
    state: "reserved",
    signed: null,
    attempts: [],
    observations: [],
    firstError: null,
    firstUnrecoverableError: null,
    terminal: null,
  };
  delete intent.usdcCommitment;
  if (intent.kind === "user-operation")
    intent.userOperation = { ...intent.userOperation, wireDigest: null };
  return intent;
}
