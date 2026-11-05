import assert from "node:assert/strict";
import test from "node:test";
import { validateSafeUserOperationReceipt } from "./safe-userop-receipt.mjs";

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
