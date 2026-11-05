import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { chmod, lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

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
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(value))
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
  validateStateStructure(state);
  for (const intent of state.intents) validatePersistedIntent(intent);
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
function validateStateStructure(state) {
  if (
    !Array.isArray(state.intents) ||
    !state.budget ||
    (state.startedAt !== null && !Number.isSafeInteger(state.startedAt))
  )
    fail("invalid journal structure");
}
function validatePersistedIntent(intent) {
  if (
    !intent ||
    typeof intent.intentId !== "string" ||
    !validAddress(intent.sender) ||
    !natural(intent.nonce, "nonce") ||
    !validHash(intent.unsignedDigest) ||
    !natural(intent.offeredAt, "offered time") ||
    !validIntentBudget(intent) ||
    !Array.isArray(intent.attempts)
  )
    fail("invalid persisted intent");
  if (intent.signed && (!HEX.test(intent.signed.raw) || !validHash(intent.signed.hash)))
    fail("invalid persisted signature");
}
async function loadState(statePath, envelope, identity) {
  try {
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
  static async open({
    directory,
    envelope,
    now = Date.now,
    failPublish = false,
    processAlive = defaultProcessAlive,
  } = {}) {
    validateEnvelope(envelope);
    if (typeof directory !== "string" || !directory) fail("state directory required");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const identity = envelopeIdentity(envelope);
    const lockPath = join(directory, LOCK);
    const token = randomUUID();
    await acquireLease(lockPath, token, processAlive);
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
  }
  snapshot() {
    return clone(this.state);
  }
  intent(intentId) {
    const intent = this.state.intents.find((entry) => entry.intentId === intentId);
    return intent ? clone(intent) : undefined;
  }
  async close() {
    if (!this.closed) {
      this.closed = true;
      await releaseLease(join(this.directory, LOCK), this.token);
    }
  }

  async reserve(request) {
    this.#assertOpen();
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
  }

  async saveSigned(intentId, raw, hash) {
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
  }

  async recordAttempt(intentId, { at = this.now(), error = null, unrecoverable = false } = {}) {
    this.#assertSigningAllowed();
    natural(at, "attempt time");
    if (error !== null && (typeof error !== "string" || !error)) fail("invalid attempt error");
    const proposed = clone(this.state);
    const intent = findIntent(proposed, intentId);
    if (!intent.signed) fail("attempt without durable signature");
    intent.attempts.push({ at, error, unrecoverable: Boolean(unrecoverable) });
    if (error && !intent.firstError) intent.firstError = error;
    if (error && unrecoverable && !intent.firstUnrecoverableError)
      intent.firstUnrecoverableError = error;
    intent.state = "broadcast-attempted";
    await this.#commit(proposed);
    return this.intent(intentId);
  }

  async recordTerminal(intentId, receipt) {
    const proposed = clone(this.state);
    const intent = findIntent(proposed, intentId);
    validateReceipt(receipt, intent);
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
  }

  #assertOpen() {
    if (this.closed) fail("journal is closed");
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
    if (BigInt(budget.feeReservedWei) + fee > BigInt(this.envelope.maxFeeWei))
      fail("fee budget exceeded");
    if (BigInt(budget.fundingCommittedWei) + funding > BigInt(this.envelope.maxFundingWei))
      fail("funding budget exceeded");
    if (BigInt(budget.usdcCommittedMicro) + usdc > BigInt(this.envelope.maxUsdcMicro))
      fail("USDC budget exceeded");
  }
  async #commit(next) {
    validateState(next, this.envelope, this.identity);
    await persist(join(this.directory, JOURNAL), next, this.failPublish);
    this.state = next;
  }
}

function validateRequest(request) {
  if (
    !request ||
    typeof request.intentId !== "string" ||
    !request.intentId ||
    !validAddress(request.sender) ||
    !natural(request.nonce, "nonce") ||
    !validHash(request.unsignedDigest) ||
    !validAddress(request.to) ||
    !HEX.test(request.input) ||
    !natural(request.offeredAt, "offered time") ||
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
function findIntent(state, intentId) {
  const intent = state.intents.find((entry) => entry.intentId === intentId);
  if (!intent) fail("unknown intent");
  return intent;
}
function validateReceipt(receipt, intent) {
  if (
    !receipt ||
    !validHash(receipt.hash) ||
    receipt.hash !== intent.signed.hash ||
    ![0, 1].includes(receipt.status) ||
    receipt.from !== intent.sender ||
    receipt.to !== intent.to ||
    receipt.input !== intent.input ||
    receipt.nonce !== intent.nonce ||
    receipt.chainId !== 11155111 ||
    typeof receipt.feeWei !== "bigint" ||
    receipt.feeWei < 0n
  )
    fail("invalid canonical receipt");
}
function serializeReceipt(receipt) {
  return { ...receipt, feeWei: receipt.feeWei.toString() };
}
async function persist(path, state, failPublish) {
  if (failPublish) fail("persist failed");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const text = JSON.stringify(state);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(text);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await chmod(path, 0o600);
    const directory = await open(join(path, ".."), "r");
    await directory.sync();
    await directory.close();
  } catch (error) {
    if (handle) await handle.close();
    await unlink(temporary).catch(() => {});
    fail(`persist failed: ${error.message}`);
  }
}
async function acquireLease(path, token, processAlive) {
  const record = JSON.stringify({ pid: process.pid, token });
  try {
    await writeFile(path, record, { flag: "wx", mode: 0o600 });
    return;
  } catch (error) {
    if (error?.code !== "EEXIST") fail("unable to acquire lease");
  }
  let prior;
  try {
    prior = JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail("foreign lease");
  }
  if (
    !Number.isSafeInteger(prior.pid) ||
    prior.pid <= 0 ||
    typeof prior.token !== "string" ||
    processAlive(prior.pid)
  )
    fail("active or foreign lease");
  const observed = await lstat(path);
  const check = await lstat(path);
  if (observed.ino !== check.ino) fail("lease changed during recovery");
  await unlink(path);
  return acquireLease(path, token, processAlive);
}
async function releaseLease(path, token) {
  try {
    const current = JSON.parse(await readFile(path, "utf8"));
    if (equalToken(current.token, token)) await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
function equalToken(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
