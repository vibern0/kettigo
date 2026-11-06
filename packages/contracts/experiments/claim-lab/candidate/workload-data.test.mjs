import assert from "node:assert/strict";
import test from "node:test";

import { resolveSdkInput } from "./workload-data.ts";

const pool = "0x1111111111111111111111111111111111111111";
const actor = "0x2222222222222222222222222222222222222222";

test("SDK input normalizes its checksum pair and binds one encrypted value to its proof", async () => {
  const calls = [];
  const result = await resolveSdkInput({
    sdk: {
      encrypt: async (input) => {
        calls.push(input);
        return { encryptedValues: ["0x" + "ab".repeat(32)], inputProof: "0x1234" };
      },
    },
    contract: pool.toLowerCase(),
    actor: actor.toLowerCase(),
    amount: "7",
  });
  assert.deepEqual(calls, [
    {
      values: [{ type: "euint64", value: 7n }],
      contractAddress: "0x1111111111111111111111111111111111111111",
      userAddress: "0x2222222222222222222222222222222222222222",
    },
  ]);
  assert.equal(result.handle, "0x" + "ab".repeat(32));
  assert.equal(result.proof, "0x1234");
});

test("SDK input rejects an output with more than one encrypted value", async () => {
  await assert.rejects(
    () =>
      resolveSdkInput({
        sdk: { encrypt: async () => ({ encryptedValues: ["0x01", "0x02"], inputProof: "0x" }) },
        contract: pool,
        actor,
        amount: "1",
      }),
    /one encrypted value/,
  );
});
