import assert from "node:assert/strict";
import test from "node:test";

import {
  actionForPendingOperation,
  patchForPendingRecovery,
  patchForRunnerError,
} from "../src/lib/action-center-pending.ts";

const operation = {
  chainId: 11155111,
  entryPoint: "0x0000000071727De22E5E9d8bAF0edAc6f37da032",
  sender: "0x1234567890123456789012345678901234567890",
  userOperationHash: `0x${"ab".repeat(32)}`,
  createdAt: 1_000,
  phase: "attempted",
};

test("keeps an attempted operation in a controlled still-processing state", () => {
  const action = actionForPendingOperation(operation, 2_000);
  const patch = patchForRunnerError({ ...action, status: "submitted" }, operation);

  assert.equal(action.status, "confirming");
  assert.equal(action.txHash, undefined);
  assert.equal(patch.status, "confirming");
  assert.equal(patch.error, "Still processing. Check status to see the latest update.");
});

test("uses a canonical outer receipt only after terminal recovery", () => {
  const patch = patchForPendingRecovery({
    state: "confirmed",
    operation,
    transactionHash: `0x${"cd".repeat(32)}`,
    blockHash: `0x${"ef".repeat(32)}`,
    blockNumber: 4n,
  });

  assert.deepEqual(patch, {
    status: "completed",
    txHash: `0x${"cd".repeat(32)}`,
    error: undefined,
  });
});

test("keeps pending recovery non-final and distinguishes unsent recovery", () => {
  assert.equal(patchForPendingRecovery({ state: "pending", operation }).status, "confirming");
  assert.equal(
    patchForPendingRecovery({ state: "not-submitted", operation }).status,
    "not-submitted",
  );
});

test("keeps a known declined approval separate from an uncertain action", () => {
  const action = actionForPendingOperation({ ...operation, phase: "prepared" }, 2_000);
  const patch = patchForRunnerError(action, null, { code: 4001 });

  assert.deepEqual(patch, { status: "rejected", error: "Approval was not completed." });
});
