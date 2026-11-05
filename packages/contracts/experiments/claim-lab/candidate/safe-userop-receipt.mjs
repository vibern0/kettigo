const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const fail = (message) => {
  throw new Error(`safe UserOperation receipt: ${message}`);
};
const plain = (value) =>
  Boolean(value) &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const own = (value, keys) =>
  plain(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const decimal = (value) => typeof value === "string" && UINT.test(value);
const operationShape = (value) =>
  own(value, ["chainId", "entryPoint", "sender", "userOperationHash", "nonce"]) &&
  value.chainId === 11155111 &&
  ADDRESS.test(value.entryPoint) &&
  ADDRESS.test(value.sender) &&
  HASH.test(value.userOperationHash) &&
  decimal(value.nonce);
const outerShape = (value) =>
  own(value, ["transactionHash", "blockNumber", "blockHash"]) &&
  HASH.test(value.transactionHash) &&
  HASH.test(value.blockHash) &&
  decimal(value.blockNumber);

export function validateSafeUserOperationReceipt(value, identity) {
  if (!own(value, ["kind", "operation", "status", "feeWei", "outer"]))
    fail("invalid receipt shape");
  if (
    value.kind !== "user-operation" ||
    !["success", "reverted"].includes(value.status) ||
    typeof value.feeWei !== "bigint" ||
    value.feeWei < 0n
  )
    fail("invalid receipt fields");
  const operation = value.operation;
  const outer = value.outer;
  if (!operationShape(operation)) fail("invalid operation evidence");
  if (!outerShape(outer)) fail("invalid outer evidence");
  if (!plain(identity) || Object.entries(operation).some(([key, field]) => identity[key] !== field))
    fail("receipt identity mismatch");
  return value;
}

export function serializeSafeUserOperationReceipt(receipt) {
  return { ...receipt, feeWei: receipt.feeWei.toString() };
}

export function validateStoredSafeUserOperationReceipt(value, identity) {
  if (
    !own(value, ["kind", "operation", "status", "feeWei", "outer"]) ||
    value.kind !== "user-operation" ||
    !["success", "reverted"].includes(value.status) ||
    !decimal(value.feeWei) ||
    !operationShape(value.operation) ||
    !outerShape(value.outer) ||
    !plain(identity) ||
    Object.entries(value.operation).some(([key, field]) => identity[key] !== field)
  )
    fail("invalid persisted receipt");
}
