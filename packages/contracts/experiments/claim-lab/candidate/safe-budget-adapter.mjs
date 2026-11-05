import { createHash } from "node:crypto";
import { getAddress, isAddress } from "ethers";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const FIELDS = Object.freeze([
  "sender",
  "nonce",
  "factory",
  "factoryData",
  "callData",
  "callGasLimit",
  "verificationGasLimit",
  "preVerificationGas",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "paymaster",
  "paymasterVerificationGasLimit",
  "paymasterPostOpGasLimit",
  "paymasterData",
  "signature",
]);
const UNSIGNED_FIELDS = FIELDS.filter((field) => field !== "signature");
const SPONSOR_FIELDS = Object.freeze([
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "verificationGasLimit",
  "preVerificationGas",
  "callGasLimit",
  "paymasterPostOpGasLimit",
  "paymasterVerificationGasLimit",
  "paymaster",
  "paymasterData",
]);

function fail(message) {
  throw new Error(`safe budget adapter: ${message}`);
}
function bytes(value, label) {
  if (typeof value !== "string" || !BYTES.test(value)) fail(`invalid ${label}`);
  return value.toLowerCase();
}
function addressOrEmpty(value, label) {
  if (value === "0x") return "0x";
  if (typeof value !== "string" || !ADDRESS.test(value) || !isAddress(value)) fail(`invalid ${label}`);
  return getAddress(value);
}
function quantity(value, label) {
  let result;
  try {
    if (typeof value === "string" && !/^(0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(value)) throw new Error();
    result = BigInt(value);
  } catch {
    fail(`invalid ${label}`);
  }
  if (result < 0n) fail(`invalid ${label}`);
  return result;
}
function normalQuantity(value, label) {
  return quantity(value, label).toString();
}
function normalizedFields(operation) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) fail("operation required");
  const keys = Object.keys(operation);
  if (keys.length !== FIELDS.length || keys.some((key) => !FIELDS.includes(key))) fail("unknown or missing UserOperation field");
  const result = {
    sender: addressOrEmpty(operation.sender, "sender"),
    nonce: normalQuantity(operation.nonce, "nonce"),
    factory: addressOrEmpty(operation.factory, "factory"),
    factoryData: bytes(operation.factoryData, "factory data"),
    callData: bytes(operation.callData, "call data"),
    callGasLimit: normalQuantity(operation.callGasLimit, "call gas limit"),
    verificationGasLimit: normalQuantity(operation.verificationGasLimit, "verification gas limit"),
    preVerificationGas: normalQuantity(operation.preVerificationGas, "pre-verification gas"),
    maxFeePerGas: normalQuantity(operation.maxFeePerGas, "max fee per gas"),
    maxPriorityFeePerGas: normalQuantity(operation.maxPriorityFeePerGas, "priority fee"),
    paymaster: addressOrEmpty(operation.paymaster, "paymaster"),
    paymasterVerificationGasLimit: normalQuantity(operation.paymasterVerificationGasLimit, "paymaster verification gas"),
    paymasterPostOpGasLimit: normalQuantity(operation.paymasterPostOpGasLimit, "paymaster post-operation gas"),
    paymasterData: bytes(operation.paymasterData, "paymaster data"),
    signature: bytes(operation.signature, "signature"),
  };
  if ((result.factory === "0x") !== (result.factoryData === "0x")) fail("incoherent factory fields");
  const paymasterEmpty = result.paymaster === "0x";
  const paymasterGas = BigInt(result.paymasterVerificationGasLimit) + BigInt(result.paymasterPostOpGasLimit);
  if (paymasterEmpty && (result.paymasterData !== "0x" || paymasterGas !== 0n))
    fail("incoherent paymaster fields");
  if (!paymasterEmpty && (result.paymasterData === "0x" || paymasterGas === 0n))
    fail("incoherent paymaster fields");
  return result;
}
function unsignedEqual(left, right) {
  return UNSIGNED_FIELDS.every((field) => left[field] === right[field]);
}
function encodedRecord(record) {
  return `0x${Buffer.from(JSON.stringify(record), "utf8").toString("hex")}`;
}
function digest(record) {
  return `0x${createHash("sha256").update(JSON.stringify(record)).digest("hex")}`;
}
function expectedAddress(value, label) {
  if (typeof value !== "string" || !isAddress(value)) fail(`invalid expected ${label}`);
  return getAddress(value);
}

/** Strict v0.7 input validation; SDK conversion is deliberately not used as a validator. */
export function canonicalizeUserOperation(operation) {
  const result = normalizedFields(operation);
  const units =
    BigInt(result.callGasLimit) +
    BigInt(result.verificationGasLimit) +
    BigInt(result.preVerificationGas) +
    BigInt(result.paymasterVerificationGasLimit) +
    BigInt(result.paymasterPostOpGasLimit);
  return Object.freeze({
    ...result,
    units,
    worstFeeWei: units * BigInt(result.maxFeePerGas),
  });
}

/** A deterministic UserOperation journal record, not an Ethereum transaction. */
export function deterministicUserOperationRecord(operation) {
  const canonical = FIELDS.every((field) => Object.hasOwn(operation ?? {}, field))
    ? operation
    : canonicalizeUserOperation(operation);
  return Object.freeze(Object.fromEntries(FIELDS.map((field) => [field, canonical[field]])));
}

/** Mirrors Relay Kit 6.1.1's intentionally truthy sponsored-estimation merge. */
export function mergePinnedRelayEstimations(userOperation, estimations) {
  if (!estimations || typeof estimations !== "object" || Array.isArray(estimations)) fail("estimations required");
  if (Object.keys(estimations).some((key) => !SPONSOR_FIELDS.includes(key))) fail("unknown sponsor field");
  const merged = { ...userOperation };
  for (const field of SPONSOR_FIELDS) {
    if (estimations[field]) merged[field] = estimations[field];
  }
  return merged;
}

export class SafeBudgetAdapter {
  constructor({ journal, expected, verifyCallData, identity, now = Date.now, marker = () => {} } = {}) {
    if (!journal || typeof journal.reserve !== "function" || typeof journal.saveSigned !== "function" || typeof journal.attemptWithPermit !== "function") fail("journal dependency required");
    if (typeof verifyCallData !== "function" || typeof identity !== "function") fail("validation dependencies required");
    this.journal = journal;
    this.expected = {
      chainId: expected?.chainId,
      entryPoint: expectedAddress(expected?.entryPoint, "entry point"),
      safe: expectedAddress(expected?.safe, "safe"),
      journalTarget: expectedAddress(expected?.journalTarget, "journal target"),
    };
    if (this.expected.chainId !== 11155111) fail("expected chain must be Sepolia");
    this.verifyCallData = verifyCallData;
    this.identity = identity;
    this.now = now;
    this.marker = marker;
    this.routed = new Set();
  }

  async reserve({ intentId, operation, offeredAt }) {
    this.marker("sponsored-created");
    const canonical = this.#validate(operation, false);
    if (!Number.isSafeInteger(Number(BigInt(canonical.nonce))) || BigInt(canonical.nonce) > BigInt(Number.MAX_SAFE_INTEGER))
      fail("Safe nonce is not safely representable");
    const unsigned = deterministicUserOperationRecord(canonical);
    const unsignedDigest = digest(unsigned);
    const reserved = await this.journal.reserve({
      intentId,
      sender: canonical.sender,
      nonce: Number(canonical.nonce),
      unsignedDigest,
      to: this.expected.journalTarget,
      input: canonical.callData,
      offeredAt,
      maxFeeWei: canonical.worstFeeWei,
      maxGasPriceWei: BigInt(canonical.maxFeePerGas),
      fundingWei: 0n,
      usdcCommitment: "0",
    });
    const reservation = Object.freeze({ intentId, unsigned, unsignedDigest, canonical, journal: reserved.intent });
    this.marker("reserved");
    return reservation;
  }

  async saveSigned({ reservation, operation }) {
    if (!reservation?.intentId || !reservation.unsigned) fail("reservation required");
    const canonical = this.#validate(operation, true);
    const signed = deterministicUserOperationRecord(canonical);
    if (!unsignedEqual(signed, reservation.unsigned)) fail("signed operation differs from reserved unsigned operation");
    if (signed.signature === "0x") fail("nonempty signature required");
    const raw = encodedRecord(signed);
    const saved = await this.journal.saveSigned(reservation.intentId, raw, reservation.unsignedDigest);
    this.marker("signed-persisted");
    return Object.freeze({ ...reservation, signed, raw, saved });
  }

  async route({ reservation, wire, entryPoint, send }) {
    if (!reservation?.signed || typeof send !== "function") fail("persisted signed reservation required");
    if (this.routed.has(reservation.intentId)) fail("duplicate route attempt");
    if (expectedAddress(entryPoint, "route entry point") !== this.expected.entryPoint) fail("wrong route entry point");
    const canonical = this.#validate(wire, true);
    const received = deterministicUserOperationRecord(canonical);
    if (JSON.stringify(received) !== JSON.stringify(reservation.signed)) fail("route payload differs from persisted signed operation");
    this.routed.add(reservation.intentId);
    return this.journal.attemptWithPermit(reservation.intentId, async () => {
      this.marker("actual-send");
      return send();
    });
  }

  #validate(operation, signed) {
    const canonical = canonicalizeUserOperation(operation);
    if (canonical.sender !== this.expected.safe) fail("wrong Safe sender");
    if (!this.verifyCallData(canonical.callData)) fail("unapproved nested call target");
    if (signed ? canonical.signature === "0x" : canonical.signature !== "0x") fail("unexpected signature state");
    const operationIdentity = this.identity(operation);
    if (
      !operationIdentity ||
      operationIdentity.chainId !== this.expected.chainId ||
      expectedAddress(operationIdentity.entryPoint, "identity entry point") !== this.expected.entryPoint ||
      expectedAddress(operationIdentity.sender, "identity sender") !== this.expected.safe ||
      typeof operationIdentity.userOperationHash !== "string" ||
      !HASH.test(operationIdentity.userOperationHash)
    )
      fail("invalid UserOperation identity");
    return canonical;
  }
}
