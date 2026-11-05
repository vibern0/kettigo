import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { acquireLease, assertLease, persist, releaseLease } from "./persistence.mjs";
import {
  findIntent,
  occupiedFee,
  serializeReceipt,
  validateReceipt,
  validateStoredReceipt,
} from "./receipt.mjs";
import {
  validatePersistedCaps,
  validatePersistedUniqueness,
  validateRecomputedBudget,
} from "./budget-validation.mjs";

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

function fail(message) {
  throw new Error(`candidate journal: ${message}`);
}
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
  validatePersistedTransition(intent);
}
function validPersistedIntentFields(intent) {
  return (
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
    ].every(Boolean)
  );
}
function validClock(state, envelope) {
  return state.startedAt === null
    ? state.deadlineAt === null && state.intents.length === 0
    : Number.isSafeInteger(state.startedAt) &&
        Number.isSafeInteger(state.deadlineAt) &&
        state.deadlineAt === state.startedAt + envelope.durationMs;
}
function validBudget(budget) {
  return (
    Number.isSafeInteger(budget.signedCount) &&
    budget.signedCount >= 0 &&
    ["feeReservedWei", "feeActualWei", "fundingCommittedWei", "usdcCommittedMicro"].every((key) =>
      UINT.test(budget[key] ?? ""),
    )
  );
}
function isNatural(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function validTarget(to, input) {
  return (
    (validAddress(to) || to === null) &&
    typeof input === "string" &&
    input.length <= MAX_INPUT &&
    HEX.test(input) &&
    (to !== null || input !== "0x")
  );
}
function validatePersistedTransition(intent) {
  const hasSigned = Boolean(intent.signed);
  const terminal = intent.terminal;
  if (!validTransition(intent.state, hasSigned, intent.attempts.length, terminal))
    fail("invalid persisted transition");
  validateAttempts(intent);
  if (terminal) {
    if (intent.state !== "terminal" || !intent.attempts.length) fail("invalid persisted terminal");
    validateStoredReceipt(terminal, intent);
  } else if (intent.state === "terminal") fail("invalid persisted terminal");
}
function validTransition(state, signed, attempts, terminal) {
  return (
    {
      reserved: !signed && attempts === 0 && !terminal,
      signed: signed && attempts === 0 && !terminal,
      "broadcast-attempted": signed && attempts > 0 && !terminal,
      terminal: signed && attempts > 0 && Boolean(terminal),
    }[state] === true
  );
}
function validateAttempts(intent) {
  let first = null;
  let unrecoverable = null;
  for (const attempt of intent.attempts) {
    if (!validAttempt(attempt)) fail("invalid persisted attempt");
    if (attempt.error && !first) first = attempt.error;
    if (attempt.error && attempt.unrecoverable && !unrecoverable) unrecoverable = attempt.error;
  }
  if (intent.firstError !== first || intent.firstUnrecoverableError !== unrecoverable)
    fail("invalid persisted errors");
}
function validAttempt(attempt) {
  return (
    Boolean(attempt) &&
    isNatural(attempt.at) &&
    (attempt.error === null ||
      (typeof attempt.error === "string" &&
        Boolean(attempt.error) &&
        attempt.error.length <= MAX_ERROR)) &&
    typeof attempt.unrecoverable === "boolean"
  );
}
async function loadState(statePath, envelope, identity) {
  try {
    if ((await stat(statePath)).size > MAX_JOURNAL_BYTES) fail("journal state exceeds size limit");
    return { state: JSON.parse(await readFile(statePath, "utf8")), created: false };
  } catch (error) {
    if (error?.code !== "ENOENT") fail("invalid journal state");
    return { state: newState(envelope, identity), created: true };
  }
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
function validIntentBudget(intent) {
  return (
    UINT.test(intent.maxFeeWei ?? "") &&
    UINT.test(intent.maxGasPriceWei ?? "") &&
    UINT.test(intent.fundingWei ?? "") &&
    UINT.test(intent.usdcCommitmentMicro ?? "")
  );
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
      const { state, created } = await loadState(statePath, envelope, identity);
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
      addReservation(proposed, request, this.envelope, this.now, this.#assertBudget.bind(this));
      await this.#commit(proposed);
      return { replay: false, intent: this.intent(request.intentId) };
    });
  }

  async saveSigned(intentId, raw, hash) {
    return this.#mutate(async () => {
      this.#assertSigningAllowed();
      if (!HEX.test(raw) || !validHash(hash)) fail("invalid signed payload");
      const proposed = clone(this.state);
      const intent = findIntent(proposed, intentId);
      if (intent.signed) {
        if (intent.signed.raw === raw && intent.signed.hash === hash) return clone(intent);
        fail("signature replacement refused");
      }
      intent.signed = { raw, hash };
      intent.state = "signed";
      await this.#commit(proposed);
      return this.intent(intentId);
    });
  }

  async recordAttempt(intentId, { at = this.now(), error = null, unrecoverable = false } = {}) {
    return this.#mutate(async () => {
      this.#assertSigningAllowed();
      natural(at, "attempt time");
      if (error !== null && (typeof error !== "string" || !error)) fail("invalid attempt error");
      const proposed = clone(this.state);
      const intent = findIntent(proposed, intentId);
      if (!intent.signed) fail("attempt without durable signature");
      if (intent.terminal) fail("attempt after terminal");
      intent.attempts.push({ at, error, unrecoverable: Boolean(unrecoverable) });
      if (error && !intent.firstError) intent.firstError = error;
      if (error && unrecoverable && !intent.firstUnrecoverableError)
        intent.firstUnrecoverableError = error;
      intent.state = "broadcast-attempted";
      await this.#commit(proposed);
      return this.intent(intentId);
    });
  }

  async recordTerminal(intentId, receipt) {
    return this.#mutate(async () => {
      const proposed = clone(this.state);
      const intent = findIntent(proposed, intentId);
      validateReceipt(receipt, intent);
      if (!intent.attempts.length) fail("terminal requires broadcast attempt");
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

  #assertOpen() {
    if (this.closed) fail("journal is closed");
    if (this.poisoned) fail("journal persistence is uncertain");
  }
  #assertSigningAllowed() {
    this.#assertOpen();
    if (this.state.startedAt === null || this.now() >= this.state.deadlineAt)
      fail("deadline reached");
    if (this.state.intents.some((intent) => intent.firstUnrecoverableError))
      fail("unrecoverable error stops signatures");
  }
  #assertBudget(budget, fee, funding, usdc) {
    if (budget.signedCount + 1 > this.envelope.maxSignedTransactions)
      fail("signature budget exceeded");
    if (occupiedFee(this.state) + fee > BigInt(this.envelope.maxFeeWei))
      fail("fee budget exceeded");
    if (BigInt(budget.fundingCommittedWei) + funding > BigInt(this.envelope.maxFundingWei))
      fail("funding budget exceeded");
    if (BigInt(budget.usdcCommittedMicro) + usdc > BigInt(this.envelope.maxUsdcMicro))
      fail("USDC budget exceeded");
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
    if (this.closed || this.poisoned) this.#assertOpen();
    const next = this.tail.then(async () => {
      this.#assertOpen();
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
    firstError: null,
    firstUnrecoverableError: null,
    terminal: null,
  };
  delete intent.usdcCommitment;
  return intent;
}
