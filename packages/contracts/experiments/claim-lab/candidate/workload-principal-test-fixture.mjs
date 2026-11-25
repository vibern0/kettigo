import assert from "node:assert/strict";

import { FIXED_ENTRY_POINT_07 } from "./workload-data.ts";

export const handle = (byte) => `0x${byte.repeat(32)}`;

export function principalFixture(compiled, actionId = "final-request-eoa-00") {
  const action = compiled.actions.find((entry) => entry.id === actionId);
  const block = { number: "100", hash: handle("aa") };
  const completion = (dependency) => ({
    kind: "canonical-success",
    actionId: dependency,
    evidence: {
      kind: dependency.startsWith("safe-") ? "safe" : "eoa",
      actionId: dependency,
      ...(dependency.startsWith("safe-")
        ? {
            userOperationHash: handle("01"),
            entryPoint: FIXED_ENTRY_POINT_07,
            sender: compiled.actions.find((entry) => entry.id === dependency).actor,
            outerTransactionHash: handle("02"),
          }
        : { transactionHash: handle("03") }),
      blockNumber: "99",
      blockHash: handle("bb"),
    },
  });
  const completions = action.dependencies.map(completion);
  return {
    action,
    input: {
      compiled,
      actionId,
      pinnedRead: block,
      dependencyCompletions: completions,
      authority: {
        readEncryptedPrincipalAt: async (gotPool, gotActor, gotBlock) => {
          assert.equal(gotPool, action.target);
          assert.equal(gotActor, action.actor);
          assert.equal(gotBlock, 100n);
          return handle("11");
        },
        decryptOwnedUint64: async (gotPool, gotActor, gotHandle) => {
          assert.equal(gotPool, action.target);
          assert.equal(gotActor, action.actor);
          assert.equal(gotHandle, handle("11"));
          return 7n;
        },
        encryptEuint64: async (gotPool, gotActor, value) => {
          assert.equal(gotPool, action.target);
          assert.equal(gotActor, action.actor);
          assert.equal(value, 7n);
          return { encryptedValues: [handle("22")], inputProof: "0x1234" };
        },
        blockAt: async (number) => (assert.equal(number, 100n), block),
        completionFor: async (id) => completions.find((entry) => entry.actionId === id),
      },
    },
  };
}
