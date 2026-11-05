const HASH = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const fail = (message) => {
  throw new Error(`candidate journal: ${message}`);
};
const validHash = (value) => typeof value === "string" && HASH.test(value);
export function findIntent(state, intentId) {
  const intent = state.intents.find((entry) => entry.intentId === intentId);
  if (!intent) fail("unknown intent");
  return intent;
}
export function validateReceipt(receipt, intent) {
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
export const serializeReceipt = (receipt) => ({ ...receipt, feeWei: receipt.feeWei.toString() });
export const occupiedFee = (state) =>
  state.intents.reduce(
    (total, intent) => total + BigInt(intent.terminal ? intent.terminal.feeWei : intent.maxFeeWei),
    0n,
  );
export function validateStoredReceipt(receipt, intent) {
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
    !UINT.test(receipt.feeWei ?? "") ||
    BigInt(receipt.feeWei) > BigInt(intent.maxFeeWei)
  )
    fail("invalid persisted receipt");
}
