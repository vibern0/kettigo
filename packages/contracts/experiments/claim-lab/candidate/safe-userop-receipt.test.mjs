import assert from "node:assert/strict";
import test from "node:test";
import {
  serializeSafeUserOperationReceipt,
  validateSafeUserOperationReceipt,
  validateStoredSafeUserOperationReceipt,
} from "./safe-userop-receipt.mjs";

const hash = (digit) => `0x${digit.repeat(64)}`;
const identity = {
  chainId: 11155111,
  entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  sender: "0x1111111111111111111111111111111111111111",
  userOperationHash: hash("a"),
  nonce: "7",
};
const receipt = () => ({
  kind: "user-operation",
  operation: identity,
  status: "reverted",
  feeWei: 23n,
  outer: { transactionHash: hash("b"), blockNumber: "9", blockHash: hash("c") },
});

test("strict UserOperation receipt binds own operation and separately retains outer metadata", () => {
  assert.equal(validateSafeUserOperationReceipt(receipt(), identity).feeWei, 23n);
  assert.throws(
    () => validateSafeUserOperationReceipt({ ...receipt(), unknown: true }, identity),
    /shape/,
  );
  assert.throws(
    () =>
      validateSafeUserOperationReceipt(
        { ...receipt(), operation: { ...identity, nonce: "8" } },
        identity,
      ),
    /identity/,
  );
  assert.throws(
    () =>
      validateSafeUserOperationReceipt(
        { ...receipt(), outer: { ...receipt().outer, blockHash: hash("z") } },
        identity,
      ),
    /outer/,
  );
});

test("rejects missing, unknown, malformed, and noncanonical Safe terminal evidence", () => {
  const cases = [
    { ...receipt(), feeWei: -1n },
    { ...receipt(), operation: [] },
    { ...receipt(), outer: { ...receipt().outer, blockNumber: "09" } },
    { ...receipt(), operation: { ...identity, nonce: "01" } },
    { ...receipt(), status: "pending" },
    { ...receipt(), operation: { ...identity, extra: true } },
    { ...receipt(), outer: { transactionHash: hash("b"), blockHash: hash("c") } },
  ];
  for (const value of cases) assert.throws(() => validateSafeUserOperationReceipt(value, identity));
  const stored = serializeSafeUserOperationReceipt(receipt());
  assert.doesNotThrow(() => validateStoredSafeUserOperationReceipt(stored, identity));
  assert.throws(() =>
    validateStoredSafeUserOperationReceipt({ ...stored, feeWei: "01" }, identity),
  );
});
