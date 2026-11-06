const CLIENT_DATA = /^\{"type":"webauthn\.get","challenge":"[A-Za-z0-9_-]{43}",(.*)\}$/;
const MAX_CLIENT_DATA_SUFFIX = 4096;
const MAX_DER_BYTES = 72;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT128 = (1n << 128n) - 1n;
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
    const pair = hex.slice(2 + index * 2, 4 + index * 2);
    const byte = Number.parseInt(pair, 16);
    if (!Number.isInteger(byte) || byte.toString(16).padStart(2, "0") !== pair.toLowerCase()) {
      fail(`${label} must be hex`);
    }
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

function boundedUint(value, maximum, label) {
  if (typeof value !== "bigint" || value < 0n || value > maximum) fail(`${label} is out of range`);
  return value;
}

function address(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value))
    fail(`${label} must be an address`);
  return value;
}

function hex(value, label) {
  hexBytes(value, label);
  return value;
}

function concatHex(...values) {
  return `0x${values.map((value) => value.slice(2)).join("")}`;
}

function uintHex(value, bytes, label) {
  boundedUint(value, (1n << BigInt(bytes * 8)) - 1n, label);
  return value.toString(16).padStart(bytes * 2, "0");
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

export const SAFE_OP_V07_TYPES = Object.freeze({
  SafeOp: [
    { type: "address", name: "safe" },
    { type: "uint256", name: "nonce" },
    { type: "bytes", name: "initCode" },
    { type: "bytes", name: "callData" },
    { type: "uint128", name: "verificationGasLimit" },
    { type: "uint128", name: "callGasLimit" },
    { type: "uint256", name: "preVerificationGas" },
    { type: "uint128", name: "maxPriorityFeePerGas" },
    { type: "uint128", name: "maxFeePerGas" },
    { type: "bytes", name: "paymasterAndData" },
    { type: "uint48", name: "validAfter" },
    { type: "uint48", name: "validUntil" },
    { type: "address", name: "entryPoint" },
  ],
});

export function buildSafeOpV07(userOperation, options) {
  if (!userOperation || !options || options.validAfter !== 0 || options.validUntil !== 0)
    fail("validity must be zero");
  if (
    options.chainId !== 11155111 ||
    options.entryPoint !== "0x0000000071727De22E5E9d8BAf0edAc6f37da032"
  ) {
    fail("unsupported SafeOp domain");
  }
  const factory = hex(userOperation.factory, "factory");
  const factoryData = hex(userOperation.factoryData, "factoryData");
  const paymaster = hex(userOperation.paymaster, "paymaster");
  const paymasterData = hex(userOperation.paymasterData, "paymasterData");
  const hasFactory = factory !== "0x";
  const hasPaymaster = paymaster !== "0x";
  if ((hasFactory && !/^0x[0-9a-fA-F]{40}$/.test(factory)) || (!hasFactory && factoryData !== "0x"))
    fail("invalid factory");
  if (
    (hasPaymaster && !/^0x[0-9a-fA-F]{40}$/.test(paymaster)) ||
    (!hasPaymaster &&
      (paymasterData !== "0x" ||
        userOperation.paymasterVerificationGasLimit !== 0n ||
        userOperation.paymasterPostOpGasLimit !== 0n))
  )
    fail("invalid paymaster");
  return {
    safe: address(userOperation.sender, "sender"),
    nonce: boundedUint(userOperation.nonce, MAX_UINT256, "nonce"),
    initCode: hasFactory ? concatHex(factory, factoryData) : "0x",
    callData: hex(userOperation.callData, "callData"),
    callGasLimit: boundedUint(userOperation.callGasLimit, MAX_UINT128, "callGasLimit"),
    verificationGasLimit: boundedUint(
      userOperation.verificationGasLimit,
      MAX_UINT128,
      "verificationGasLimit",
    ),
    preVerificationGas: boundedUint(
      userOperation.preVerificationGas,
      MAX_UINT256,
      "preVerificationGas",
    ),
    maxFeePerGas: boundedUint(userOperation.maxFeePerGas, MAX_UINT128, "maxFeePerGas"),
    maxPriorityFeePerGas: boundedUint(
      userOperation.maxPriorityFeePerGas,
      MAX_UINT128,
      "maxPriorityFeePerGas",
    ),
    paymasterAndData: hasPaymaster
      ? concatHex(
          paymaster,
          `0x${uintHex(userOperation.paymasterVerificationGasLimit, 16, "paymasterVerificationGasLimit")}`,
          `0x${uintHex(userOperation.paymasterPostOpGasLimit, 16, "paymasterPostOpGasLimit")}`,
          paymasterData,
        )
      : "0x",
    validAfter: 0,
    validUntil: 0,
    entryPoint: address(options.entryPoint, "entryPoint"),
  };
}

export function safeOpV07Digest({ userOperation, options, hashTypedData }) {
  if (typeof hashTypedData !== "function") fail("hashTypedData is required");
  const message = buildSafeOpV07(userOperation, options);
  return hashTypedData({
    domain: {
      chainId: options.chainId,
      verifyingContract: address(options.moduleAddress, "moduleAddress"),
    },
    types: SAFE_OP_V07_TYPES,
    primaryType: "SafeOp",
    message,
  });
}

export function sdkWireV07(userOperation) {
  const message = buildSafeOpV07(userOperation, {
    chainId: 11155111,
    entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
    validAfter: 0,
    validUntil: 0,
  });
  return {
    sender: message.safe,
    nonce: `0x${message.nonce.toString(16)}`,
    factory: userOperation.factory,
    factoryData: userOperation.factoryData,
    callData: message.callData,
    callGasLimit: `0x${message.callGasLimit.toString(16)}`,
    verificationGasLimit: `0x${message.verificationGasLimit.toString(16)}`,
    preVerificationGas: `0x${message.preVerificationGas.toString(16)}`,
    maxFeePerGas: `0x${message.maxFeePerGas.toString(16)}`,
    maxPriorityFeePerGas: `0x${message.maxPriorityFeePerGas.toString(16)}`,
    paymaster: userOperation.paymaster === "0x" ? null : userOperation.paymaster,
    paymasterData: userOperation.paymasterData === "0x" ? null : userOperation.paymasterData,
    paymasterVerificationGasLimit: userOperation.paymasterVerificationGasLimit
      ? `0x${userOperation.paymasterVerificationGasLimit.toString(16)}`
      : null,
    paymasterPostOpGasLimit: userOperation.paymasterPostOpGasLimit
      ? `0x${userOperation.paymasterPostOpGasLimit.toString(16)}`
      : null,
    signature: hex(userOperation.signature, "signature"),
  };
}

export function adjustFixedEthSignV(signature) {
  const bytes = hexBytes(signature, "signature");
  if (bytes.length <= 65) fail("signature must contain assertion data");
  const tail = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint8(
    bytes.length - 1,
  );
  if (![0, 1, 27, 28].includes(tail)) fail("Invalid signature");
  return `${signature.slice(0, -2)}${(tail === 0 || tail === 27 ? 31 : 32).toString(16)}`;
}

export function packFixedContractSignature({
  signer,
  signature,
  validAfter = 0n,
  validUntil = 0n,
}) {
  if (validAfter !== 0n || validUntil !== 0n) fail("validity must be zero");
  const data = hex(signature, "signature").slice(2);
  const staticPart = `${address(signer, "signer").slice(2).padStart(64, "0")}${uint256(65n, "offset")}00`;
  const dynamicPart = `${uint256(BigInt(data.length / 2), "signature length")}${data}`;
  return `0x${uintHex(validAfter, 6, "validAfter")}${uintHex(validUntil, 6, "validUntil")}${staticPart}${dynamicPart}`;
}
