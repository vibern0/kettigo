import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { acquireLease, assertLease, persist, releaseLease } from "./persistence.mjs";
import { findIntent, serializeReceipt, validateReceipt } from "./receipt.mjs";
import { assertBudget } from "./budget-validation.mjs";
import { actualAttemptCount } from "./attempt-observation-validation.mjs";
import { loadState } from "./state-storage.mjs";
import { assertOpen, assertSigningAllowed } from "./journal-guards.mjs";
import { canonical, clone, decimalMicro, envelopeIdentity } from "./journal-values.mjs";
import { persistedSafePolicy } from "./safe-approved-policy.mjs";
import {
  validateJournalEnvelope,
  validateJournalRequest,
  validatePersistedJournalState,
  validJournalSignedPayload,
} from "./journal-validation.mjs";

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

const JOURNAL = "journal.json";
const LOCK = "writer.lock";
const MAX_ERROR = 2_048;
const MAX_JOURNAL_BYTES = 2_000_000;

const fail = (message) => {
  throw new Error(`candidate journal: ${message}`);
};
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
function newState(envelope, identity) {
  return {
    version: 1,
    runId: randomUUID(),
    chainId: 11155111,
    envelopeId: envelope.id,
    envelopeIdentity: identity,
    safePolicy: null,
    safePolicyIdentity: null,
    workloadDefinition: null,
    startedAt: null,
    deadlineAt: null,
    budget: budgetZero(),
    intents: [],
  };
}

export class CandidateRunJournal {
  static async open({
    directory,
    envelope,
    safePolicy = null,
    now = Date.now,
    failPublish = false,
  } = {}) {
    validateJournalEnvelope(envelope);
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
      validatePersistedJournalState(state, envelope, identity);
      if (state.safePolicy) {
        const supplied = persistedSafePolicy(safePolicy);
        if (canonical(supplied) !== canonical(state.safePolicy))
          fail("Safe policy identity required");
      } else if (safePolicy !== null) {
        const supplied = persistedSafePolicy(safePolicy);
        if (state.safePolicyIdentity) fail("Safe policy removed from journal");
        if (supplied.baseEnvelopeIdentity !== identity) fail("Safe policy does not bind envelope");
      }
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
  workloadDefinition() {
    return this.state.workloadDefinition ? clone(this.state.workloadDefinition) : null;
  }

  async bindWorkloadDefinition(binding) {
    return this.#mutate(async () => {
      validateWorkloadDefinition(binding);
      if (this.state.workloadDefinition) {
        if (canonical(this.state.workloadDefinition) !== canonical(binding))
          fail("workload definition replacement refused");
        return clone(this.state.workloadDefinition);
      }
      if (this.state.intents.length)
        fail("workload definition must bind before financial reservation");
      const proposed = clone(this.state);
      proposed.workloadDefinition = clone(binding);
      await this.#commit(proposed);
      return clone(proposed.workloadDefinition);
    });
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
      validateJournalRequest(request);
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

  async bindSafePolicy(capability) {
    return this.#mutate(async () => {
      const policy = persistedSafePolicy(capability);
      if (
        policy.runId !== this.state.runId ||
        policy.baseEnvelopeIdentity !== this.identity ||
        policy.durationMs !== this.envelope.durationMs
      )
        fail("Safe policy does not bind this run");
      if (this.state.safePolicy) {
        if (canonical(this.state.safePolicy) !== canonical(policy))
          fail("Safe policy replacement refused");
        return clone(this.state.safePolicy);
      }
      const proposed = clone(this.state);
      proposed.safePolicy = policy;
      proposed.safePolicyIdentity = policy.policyIdentity;
      await this.#commit(proposed);
      return clone(policy);
    });
  }

  async saveSigned(intentId, raw, hash) {
    return this.#mutate(async () => {
      assertSigningAllowed(this, fail);
      if (!validJournalSignedPayload(raw, hash)) fail("invalid signed payload");
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

  async attemptWithPermit(intentId, send, permit = () => {}) {
    if (typeof send !== "function") fail("send callback required");
    if (typeof permit !== "function") fail("permit callback required");
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
        permit();
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
    validatePersistedJournalState(next, this.envelope, this.identity);
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
    intent.usdcCommitmentMicro === decimalMicro(request.usdcCommitment, fail).toString()
  );
}
function validateWorkloadDefinition(binding) {
  if (
    !binding ||
    Object.getPrototypeOf(binding) !== Object.prototype ||
    Object.keys(binding).length !== 3 ||
    binding.version !== 1 ||
    typeof binding.fingerprint !== "string" ||
    !/^0x[0-9a-f]{64}$/.test(binding.fingerprint) ||
    !Array.isArray(binding.phaseIds) ||
    binding.phaseIds.length < 1 ||
    binding.phaseIds.length > 32 ||
    binding.phaseIds.some((id) => typeof id !== "string" || !id || id.length > 128) ||
    new Set(binding.phaseIds).size !== binding.phaseIds.length
  )
    fail("invalid workload definition");
}
function addReservation(state, request, envelope, now, assertBudget) {
  const startedAt = state.startedAt ?? now();
  const deadlineAt = state.deadlineAt ?? startedAt + envelope.durationMs;
  if (now() >= deadlineAt) fail("deadline reached");
  const fee = unsigned(request.maxFeeWei, "fee reservation");
  const gasPrice = unsigned(request.maxGasPriceWei, "gas price");
  const funding = unsigned(request.fundingWei, "funding reservation");
  const usdc = decimalMicro(request.usdcCommitment, fail);
  const gasCap =
    state.safePolicy &&
    request.kind === "user-operation" &&
    request.sender === state.safePolicy.safe
      ? state.safePolicy.caps.maxSafeFeePerGas
      : envelope.maxGasPriceWei;
  if (gasPrice > BigInt(gasCap)) fail("gas price exceeds approved cap");
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
