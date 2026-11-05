export function validPersistedIntentFields(
  intent,
  { validAddress, validHash, isNatural, validTarget, validIntentBudget, uint },
) {
  const shared =
    Boolean(intent) &&
    [
      typeof intent.intentId === "string" &&
        Boolean(intent.intentId) &&
        intent.intentId.length <= 256,
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
  const metadata = intent.userOperation;
  return (
    intent.kind === "user-operation" &&
    Boolean(metadata) &&
    Object.keys(metadata).length === 6 &&
    ["chainId", "entryPoint", "sender", "userOperationHash", "nonce", "wireDigest"].every((key) =>
      Object.hasOwn(metadata, key),
    ) &&
    metadata.chainId === 11155111 &&
    validAddress(metadata.entryPoint) &&
    metadata.sender === intent.sender &&
    validHash(metadata.userOperationHash) &&
    uint.test(metadata.nonce) &&
    BigInt(metadata.nonce) === BigInt(intent.nonce) &&
    (metadata.wireDigest === null || validHash(metadata.wireDigest))
  );
}

export function validRequest(request, { validAddress, validHash, isNatural, validTarget, uint }) {
  const shared =
    Boolean(request) &&
    typeof request.intentId === "string" &&
    Boolean(request.intentId) &&
    validAddress(request.sender) &&
    isNatural(request.nonce) &&
    validHash(request.unsignedDigest) &&
    validTarget(request.to, request.input) &&
    isNatural(request.offeredAt) &&
    typeof request.maxGasPriceWei === "bigint";
  if (!shared) return false;
  if (request.kind === undefined) return true;
  const meta = request.userOperation;
  return (
    request.kind === "user-operation" &&
    Boolean(meta) &&
    Object.keys(meta).length === 5 &&
    ["chainId", "entryPoint", "sender", "userOperationHash", "nonce"].every((key) =>
      Object.hasOwn(meta, key),
    ) &&
    meta.chainId === 11155111 &&
    validAddress(meta.entryPoint) &&
    meta.sender === request.sender &&
    validHash(meta.userOperationHash) &&
    uint.test(meta.nonce) &&
    BigInt(meta.nonce) === BigInt(request.nonce)
  );
}
