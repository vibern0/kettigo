const CLIENT_DATA = /^\{"type":"webauthn\.get","challenge":"[A-Za-z0-9_-]{43}",(.*)\}$/;
const MAX_CLIENT_DATA_SUFFIX = 4096;
const MAX_DER_BYTES = 72;
const MAX_UINT256 = (1n << 256n) - 1n;
const SPONSOR_FIELDS = new Set([
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
  throw new Error(message);
}

function hexBytes(hex, label) {
  if (
    typeof hex !== "string" ||
    !hex.startsWith("0x") ||
    hex.length > 8194 ||
    hex.length % 2 !== 0
  ) {
    fail(`${label} must be even-length hex`);
  }
  return Uint8Array.from({ length: (hex.length - 2) / 2 }, (_, index) => {
    const byte = Number.parseInt(hex.slice(2 + index * 2, 4 + index * 2), 16);
    if (!Number.isInteger(byte)) fail(`${label} must be hex`);
    return byte;
  });
}

function hexFromBytes(bytes) {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function uint256(value, label) {
  if (typeof value !== "bigint" || value < 0n || value > MAX_UINT256) {
    fail(`${label} must be a uint256`);
  }
  return value.toString(16).padStart(64, "0");
}

function paddedBytes(hex, label) {
  const bytes = hexBytes(hex, label);
  const paddedLength = Math.ceil(bytes.length / 32) * 32;
  return `${uint256(BigInt(bytes.length), `${label} length`)}${hexFromBytes(bytes)
    .slice(2)
    .padEnd(paddedLength * 2, "0")}`;
}

function readDerInteger(view, byteLength, cursor) {
  if (view.getUint8(cursor) !== 2 || cursor + 2 > byteLength) fail("invalid DER integer");
  const length = view.getUint8(cursor + 1);
  const start = cursor + 2;
  const end = start + length;
  if (length === 0 || length > 33 || end > byteLength) fail("invalid DER integer");
  if (view.getUint8(start) === 0 && length > 1 && view.getUint8(start + 1) < 128)
    fail("invalid DER integer");
  let value = 0n;
  for (let index = start; index < end; index += 1)
    value = (value << 8n) | BigInt(view.getUint8(index));
  if (value > MAX_UINT256) fail("DER integer exceeds uint256");
  return { cursor: end, value };
}

export function parseClientDataFields(clientDataJSON) {
  if (typeof clientDataJSON !== "string" || clientDataJSON.length > MAX_CLIENT_DATA_SUFFIX + 100) {
    fail("invalid client data");
  }
  const match = CLIENT_DATA.exec(clientDataJSON);
  if (!match || match[1].length > MAX_CLIENT_DATA_SUFFIX) fail("invalid client data");
  return match[1];
}

export function parseDerSignature(signature) {
  const bytes = hexBytes(signature, "DER signature");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length < 8 ||
    bytes.length > MAX_DER_BYTES ||
    view.getUint8(0) !== 48 ||
    view.getUint8(1) !== bytes.length - 2
  ) {
    fail("invalid DER signature");
  }
  const r = readDerInteger(view, bytes.length, 2);
  const s = readDerInteger(view, bytes.length, r.cursor);
  if (s.cursor !== bytes.length) fail("invalid DER signature");
  return { r: r.value, s: s.value };
}

export function assertionAbi({ authenticatorData, clientDataFields, r, s, encodeUtf8 }) {
  if (!(authenticatorData instanceof Uint8Array)) fail("authenticatorData must be bytes");
  if (typeof clientDataFields !== "string" || typeof encodeUtf8 !== "function")
    fail("clientDataFields must be text");
  const authenticator = paddedBytes(hexFromBytes(authenticatorData), "authenticatorData");
  const client = paddedBytes(hexFromBytes(encodeUtf8(clientDataFields)), "clientDataFields");
  const headLength = 128;
  const authenticatorOffset = uint256(BigInt(headLength), "authenticator offset");
  const clientOffset = uint256(BigInt(headLength + authenticator.length / 2), "clientData offset");
  return `0x${authenticatorOffset}${clientOffset}${uint256(r, "r")}${uint256(s, "s")}${authenticator}${client}`;
}

export function mergePinnedSponsorEstimations(userOperation, estimations) {
  if (
    !userOperation ||
    typeof userOperation !== "object" ||
    !estimations ||
    typeof estimations !== "object"
  ) {
    fail("invalid sponsor estimations");
  }
  for (const key of Object.keys(estimations)) {
    if (!Object.hasOwn(estimations, key) || !SPONSOR_FIELDS.has(key)) fail("unknown sponsor field");
  }
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
