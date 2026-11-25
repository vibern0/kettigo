function plain(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function validIntentIdentity(
  intent,
  { validAddress, validHash, isNatural, validTarget, maxIntentId },
) {
  return (
    plain(intent) &&
    typeof intent.intentId === "string" &&
    intent.intentId.length > 0 &&
    intent.intentId.length <= maxIntentId &&
    validAddress(intent.sender) &&
    isNatural(intent.nonce) &&
    validHash(intent.unsignedDigest) &&
    isNatural(intent.offeredAt) &&
    validTarget(intent.to, intent.input)
  );
}

function validPersistedState(intent, validIntentBudget) {
  return (
    validIntentBudget(intent) &&
    Array.isArray(intent.attempts) &&
    (intent.observations === undefined || Array.isArray(intent.observations))
  );
}

function validRequestBudget(request) {
  return typeof request.maxGasPriceWei === "bigint";
}

function hasExactKeys(value, keys) {
  return (
    plain(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function validUserOperationIdentity(metadata, intent, { validAddress, validHash, uint }, keys) {
  return (
    hasExactKeys(metadata, keys) &&
    metadata.chainId === 11155111 &&
    validAddress(metadata.entryPoint) &&
    metadata.sender === intent.sender &&
    validHash(metadata.userOperationHash) &&
    uint.test(metadata.nonce) &&
    BigInt(metadata.nonce) === BigInt(intent.nonce)
  );
}

function validPersistedUserOperation(intent, capabilities) {
  const metadata = intent.userOperation;
  return (
    intent.kind === "user-operation" &&
    validUserOperationIdentity(metadata, intent, capabilities, [
      "chainId",
      "entryPoint",
      "sender",
      "userOperationHash",
      "nonce",
      "wireDigest",
    ]) &&
    (metadata.wireDigest === null || capabilities.validHash(metadata.wireDigest))
  );
}

function validRequestedUserOperation(request, capabilities) {
  return (
    request.kind === "user-operation" &&
    validUserOperationIdentity(request.userOperation, request, capabilities, [
      "chainId",
      "entryPoint",
      "sender",
      "userOperationHash",
      "nonce",
    ])
  );
}

export function validPersistedIntentFields(intent, capabilities) {
  if (
    !validIntentIdentity(intent, capabilities) ||
    !validPersistedState(intent, capabilities.validIntentBudget)
  )
    return false;
  return intent.kind === undefined || validPersistedUserOperation(intent, capabilities);
}

export function validRequest(request, capabilities) {
  if (!validIntentIdentity(request, capabilities) || !validRequestBudget(request)) return false;
  return request.kind === undefined || validRequestedUserOperation(request, capabilities);
}
