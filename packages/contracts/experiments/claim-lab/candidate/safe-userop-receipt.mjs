const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const fail = (message) => {
  throw new Error(`safe UserOperation receipt: ${message}`);
};
const own = (value, keys) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

export function validateSafeUserOperationReceipt(value, identity) {
  if (
    !value ||
    typeof value !== "object" ||
    !own(value, ["kind", "operation", "status", "feeWei", "outer"])
  )
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
  if (
    !operation ||
    typeof operation !== "object" ||
    !own(operation, ["chainId", "entryPoint", "sender", "userOperationHash", "nonce"]) ||
    operation.chainId !== 11155111 ||
    !ADDRESS.test(operation.entryPoint) ||
    !ADDRESS.test(operation.sender) ||
    !HASH.test(operation.userOperationHash) ||
    !UINT.test(operation.nonce)
  )
    fail("invalid operation evidence");
  if (
    !outer ||
    typeof outer !== "object" ||
    !own(outer, ["transactionHash", "blockNumber", "blockHash"]) ||
    !HASH.test(outer.transactionHash) ||
    !HASH.test(outer.blockHash) ||
    !UINT.test(outer.blockNumber)
  )
    fail("invalid outer evidence");
  if (!identity || Object.entries(operation).some(([key, field]) => identity[key] !== field))
    fail("receipt identity mismatch");
  return value;
}
