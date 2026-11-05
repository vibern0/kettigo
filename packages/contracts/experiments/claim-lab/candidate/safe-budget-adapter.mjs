import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { getAddress, isAddress } from "ethers";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
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
  if (typeof value !== "string" || value.length > 524_288 || !validBytes(value))
    fail(`invalid ${label}`);
  return value.toLowerCase();
}
function validBytes(value) {
  if (!value.startsWith("0x") || value.length % 2) return false;
  for (let index = 2; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (!((code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102)))
      return false;
  }
  return true;
}
function addressOrEmpty(value, label) {
  if (value === "0x") return "0x";
  if (typeof value !== "string" || !ADDRESS.test(value) || !isAddress(value))
    fail(`invalid ${label}`);
  return getAddress(value);
}
function quantity(value, label) {
  let result;
  try {
    if (typeof value === "string" && !/^(0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(value))
      throw new Error();
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
  if (
    !operation ||
    typeof operation !== "object" ||
    Array.isArray(operation) ||
    Object.getPrototypeOf(operation) !== Object.prototype
  )
    fail("operation required");
  const keys = Object.keys(operation);
  if (keys.length !== FIELDS.length || keys.some((key) => !FIELDS.includes(key)))
    fail("unknown or missing UserOperation field");
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
    paymasterVerificationGasLimit: normalQuantity(
      operation.paymasterVerificationGasLimit,
      "paymaster verification gas",
    ),
    paymasterPostOpGasLimit: normalQuantity(
      operation.paymasterPostOpGasLimit,
      "paymaster post-operation gas",
    ),
    paymasterData: bytes(operation.paymasterData, "paymaster data"),
    signature: bytes(operation.signature, "signature"),
  };
  if ((result.factory === "0x") !== (result.factoryData === "0x"))
    fail("incoherent factory fields");
  const paymasterEmpty = result.paymaster === "0x";
  const paymasterGas =
    BigInt(result.paymasterVerificationGasLimit) + BigInt(result.paymasterPostOpGasLimit);
  if (paymasterEmpty && (result.paymasterData !== "0x" || paymasterGas !== 0n))
    fail("incoherent paymaster fields");
  if (!paymasterEmpty && (result.paymasterData === "0x" || paymasterGas === 0n))
    fail("incoherent paymaster fields");
  return result;
}
function unsignedEqual(left, right) {
  return (
    left.sender === right.sender &&
    left.nonce === right.nonce &&
    left.factory === right.factory &&
    left.factoryData === right.factoryData &&
    left.callData === right.callData &&
    left.callGasLimit === right.callGasLimit &&
    left.verificationGasLimit === right.verificationGasLimit &&
    left.preVerificationGas === right.preVerificationGas &&
    left.maxFeePerGas === right.maxFeePerGas &&
    left.maxPriorityFeePerGas === right.maxPriorityFeePerGas &&
    left.paymaster === right.paymaster &&
    left.paymasterVerificationGasLimit === right.paymasterVerificationGasLimit &&
    left.paymasterPostOpGasLimit === right.paymasterPostOpGasLimit &&
    left.paymasterData === right.paymasterData
  );
}
function encodedRecord(record) {
  return `0x${Buffer.from(JSON.stringify(record), "utf8").toString("hex")}`;
}
function decodedRecord(raw) {
  if (typeof raw !== "string" || !validBytes(raw)) fail("invalid persisted UserOperation wire");
  let value;
  try {
    value = JSON.parse(Buffer.from(raw.slice(2), "hex").toString("utf8"));
  } catch {
    fail("invalid persisted UserOperation wire");
  }
  const canonical = canonicalizeUserOperation(value);
  const record = fixedRecord(canonical);
  if (encodedRecord(record) !== raw) fail("noncanonical persisted UserOperation wire");
  return record;
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
  const canonical = canonicalizeUserOperation(operation);
  return fixedRecord(canonical);
}
function fixedRecord(canonical) {
  return Object.freeze({
    sender: canonical.sender,
    nonce: canonical.nonce,
    factory: canonical.factory,
    factoryData: canonical.factoryData,
    callData: canonical.callData,
    callGasLimit: canonical.callGasLimit,
    verificationGasLimit: canonical.verificationGasLimit,
    preVerificationGas: canonical.preVerificationGas,
    maxFeePerGas: canonical.maxFeePerGas,
    maxPriorityFeePerGas: canonical.maxPriorityFeePerGas,
    paymaster: canonical.paymaster,
    paymasterVerificationGasLimit: canonical.paymasterVerificationGasLimit,
    paymasterPostOpGasLimit: canonical.paymasterPostOpGasLimit,
    paymasterData: canonical.paymasterData,
    signature: canonical.signature,
  });
}

/** Mirrors Relay Kit 6.1.1's intentionally truthy sponsored-estimation merge. */
export function mergePinnedRelayEstimations(userOperation, estimations) {
  if (
    !estimations ||
    typeof estimations !== "object" ||
    Array.isArray(estimations) ||
    Object.getPrototypeOf(estimations) !== Object.prototype
  )
    fail("estimations required");
  if (Object.keys(estimations).some((key) => !SPONSOR_FIELDS.includes(key)))
    fail("unknown sponsor field");
  return {
    ...userOperation,
    maxFeePerGas: estimations.maxFeePerGas || userOperation.maxFeePerGas,
    maxPriorityFeePerGas: estimations.maxPriorityFeePerGas || userOperation.maxPriorityFeePerGas,
    verificationGasLimit: estimations.verificationGasLimit || userOperation.verificationGasLimit,
    preVerificationGas: estimations.preVerificationGas || userOperation.preVerificationGas,
    callGasLimit: estimations.callGasLimit || userOperation.callGasLimit,
    paymasterPostOpGasLimit:
      estimations.paymasterPostOpGasLimit || userOperation.paymasterPostOpGasLimit,
    paymasterVerificationGasLimit:
      estimations.paymasterVerificationGasLimit || userOperation.paymasterVerificationGasLimit,
    paymaster: estimations.paymaster || userOperation.paymaster,
    paymasterData: estimations.paymasterData || userOperation.paymasterData,
  };
}

export class SafeBudgetAdapter {
  constructor({ journal, expected, callPolicy, identity, now = Date.now, marker = () => {} } = {}) {
    if (
      !journal ||
      typeof journal.reserve !== "function" ||
      typeof journal.saveSigned !== "function" ||
      typeof journal.attemptWithPermit !== "function"
    )
      fail("journal dependency required");
    if (!callPolicy || typeof callPolicy.assert !== "function" || typeof identity !== "function")
      fail("validation dependencies required");
    this.journal = journal;
    this.expected = {
      chainId: expected?.chainId,
      entryPoint: expectedAddress(expected?.entryPoint, "entry point"),
      safe: expectedAddress(expected?.safe, "safe"),
      journalTarget: expectedAddress(expected?.journalTarget, "journal target"),
    };
    if (this.expected.chainId !== 11155111) fail("expected chain must be Sepolia");
    this.callPolicy = callPolicy;
    this.identity = identity;
    this.now = now;
    this.marker = marker;
    this.routed = new Set();
  }

  async reserve({ intentId, operation, offeredAt }) {
    this.marker("sponsored-created");
    const canonical = this.#validate(operation, false);
    const fullNonce = BigInt(canonical.nonce);
    if (fullNonce >> 64n !== 0n || fullNonce > BigInt(Number.MAX_SAFE_INTEGER))
      fail("Safe nonce is not safely representable");
    const identity = this.#identity(operation);
    const unsigned = fixedRecord(canonical);
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
      kind: "user-operation",
      userOperation: {
        chainId: identity.chainId,
        entryPoint: identity.entryPoint,
        sender: identity.sender,
        userOperationHash: identity.userOperationHash,
        nonce: canonical.nonce,
      },
    });
    const reservation = Object.freeze({
      intentId,
      unsigned,
      unsignedDigest,
      canonical,
      identity,
      journal: reserved.intent,
    });
    this.marker("reserved");
    return reservation;
  }

  async saveSigned({ reservation, operation }) {
    if (!reservation?.intentId || !reservation.unsigned) fail("reservation required");
    const canonical = this.#validate(operation, true);
    const identity = this.#identity(operation);
    if (JSON.stringify(identity) !== JSON.stringify(reservation.identity))
      fail("signed operation identity differs from reservation");
    const signed = fixedRecord(canonical);
    if (!unsignedEqual(signed, reservation.unsigned))
      fail("signed operation differs from reserved unsigned operation");
    if (signed.signature === "0x") fail("nonempty signature required");
    const raw = encodedRecord(signed);
    const saved = await this.journal.saveSigned(
      reservation.intentId,
      raw,
      reservation.identity.userOperationHash,
    );
    this.marker("signed-persisted");
    return Object.freeze({ ...reservation, signed, raw, saved });
  }

  async route({ reservation, wire, entryPoint, send }) {
    if (!reservation?.signed || typeof send !== "function")
      fail("persisted signed reservation required");
    if (this.routed.has(reservation.intentId)) fail("duplicate route attempt");
    if (expectedAddress(entryPoint, "route entry point") !== this.expected.entryPoint)
      fail("wrong route entry point");
    const canonical = this.#validate(wire, true);
    const received = fixedRecord(canonical);
    if (JSON.stringify(received) !== JSON.stringify(reservation.signed))
      fail("route payload differs from persisted signed operation");
    this.routed.add(reservation.intentId);
    return this.journal.attemptWithPermit(reservation.intentId, async () => {
      this.marker("actual-send");
      return send();
    });
  }

  async reconcile(intentId, { lookup } = {}) {
    if (typeof lookup !== "function") fail("canonical receipt lookup required");
    const intent = this.journal.intent(intentId);
    if (!intent?.signed || intent.kind !== "user-operation" || !intent.userOperation)
      fail("unknown signed UserOperation intent");
    const metadata = intent.userOperation;
    if (
      intent.signed.hash !== metadata.userOperationHash ||
      !metadata.wireDigest ||
      `0x${createHash("sha256").update(intent.signed.raw).digest("hex")}` !== metadata.wireDigest
    )
      fail("persisted UserOperation wire mismatch");
    const signed = decodedRecord(intent.signed.raw);
    if (signed.sender !== metadata.sender || signed.nonce !== metadata.nonce)
      fail("persisted UserOperation payload mismatch");
    const evidence = await lookup({
      chainId: metadata.chainId,
      entryPoint: metadata.entryPoint,
      sender: metadata.sender,
      userOperationHash: metadata.userOperationHash,
    });
    if (!evidence || evidence.state === "pending") return { state: "unresolved" };
    if (
      evidence.operation?.chainId !== metadata.chainId ||
      evidence.operation.entryPoint !== metadata.entryPoint ||
      evidence.operation.sender !== metadata.sender ||
      evidence.operation.userOperationHash !== metadata.userOperationHash ||
      typeof evidence.nonce !== "bigint" ||
      evidence.nonce.toString() !== metadata.nonce ||
      typeof evidence.actualGasCost !== "bigint" ||
      evidence.actualGasCost < 0n
    )
      fail("canonical UserOperation evidence mismatch");
    const receipt = {
      kind: "user-operation",
      status: evidence.state === "confirmed" ? "success" : "reverted",
      feeWei: evidence.actualGasCost,
      operation: {
        chainId: metadata.chainId,
        entryPoint: metadata.entryPoint,
        sender: metadata.sender,
        userOperationHash: metadata.userOperationHash,
        nonce: metadata.nonce,
      },
      outer: {
        transactionHash: evidence.transactionHash,
        blockNumber: evidence.blockNumber.toString(),
        blockHash: evidence.blockHash,
      },
    };
    await this.journal.recordTerminal(intentId, receipt);
    return { state: receipt.status };
  }

  #validate(operation, signed) {
    const canonical = canonicalizeUserOperation(operation);
    if (canonical.sender !== this.expected.safe) fail("wrong Safe sender");
    this.callPolicy.assert(canonical);
    if (signed ? canonical.signature === "0x" : canonical.signature !== "0x")
      fail("unexpected signature state");
    this.#identity(operation);
    return canonical;
  }

  #identity(operation) {
    const operationIdentity = this.identity(operation);
    if (
      !operationIdentity ||
      operationIdentity.chainId !== this.expected.chainId ||
      expectedAddress(operationIdentity.entryPoint, "identity entry point") !==
        this.expected.entryPoint ||
      expectedAddress(operationIdentity.sender, "identity sender") !== this.expected.safe ||
      typeof operationIdentity.userOperationHash !== "string" ||
      !HASH.test(operationIdentity.userOperationHash)
    )
      fail("invalid UserOperation identity");
    return Object.freeze({
      chainId: operationIdentity.chainId,
      entryPoint: expectedAddress(operationIdentity.entryPoint, "identity entry point"),
      sender: expectedAddress(operationIdentity.sender, "identity sender"),
      userOperationHash: operationIdentity.userOperationHash,
    });
  }
}
