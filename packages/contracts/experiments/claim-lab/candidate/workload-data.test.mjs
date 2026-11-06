import assert from "node:assert/strict";
import test from "node:test";

import {
  decryptPublic,
  decryptPublicMarker,
  resolveSdkInput,
  resolveSdkReferences,
} from "./workload-data.ts";
import { compileCandidateWorkload } from "./eoa-workload-definition.mjs";
import {
  workloadDefinitionFixture,
  workloadManifestFixture,
} from "./eoa-workload-test-fixture.mjs";

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

test("resolver validates the full graph before it invokes the SDK", async () => {
  const compiled = compileCandidateWorkload(workloadDefinitionFixture(), workloadManifestFixture());
  const changed = globalThis.structuredClone(compiled);
  changed.actions.find((entry) => entry.id === "eoa-00-deposit").operation.args[0][0].args[1] = "8";
  let calls = 0;
  await assert.rejects(
    () =>
      resolveSdkReferences({
        compiled: changed,
        actionId: "eoa-00-deposit",
        sdk: {
          encrypt: async () => (
            (calls += 1),
            { encryptedValues: ["0x" + "01".repeat(32)], inputProof: "0x01" }
          ),
        },
      }),
    /differs|invalid/,
  );
  assert.equal(calls, 0);
});

test("admission marker uses a single boolean SDK public-decrypt result", async () => {
  const handle = "0x" + "01".repeat(32);
  const sdk = {
    decryption: {
      decryptPublicValues: async (handles) => {
        assert.deepEqual(handles, [handle]);
        return {
          clearValues: { [handle]: true },
          abiEncodedClearValues: "0x" + "00".repeat(31) + "01",
          decryptionProof: "0xab",
        };
      },
    },
  };
  assert.deepEqual(await decryptPublicMarker({ sdk, handle }), { value: true, proof: "0xab" });
  await assert.rejects(
    () =>
      decryptPublicMarker({
        sdk: {
          decryption: {
            decryptPublicValues: async () => ({
              clearValues: { [handle]: 1n },
              abiEncodedClearValues: "0x",
              decryptionProof: "0x01",
            }),
          },
        },
        handle,
      }),
    /marker/,
  );
});

test("public uint64 decryption binds two ordered handles to one ABI payload and proof", async () => {
  const handles = ["0x" + "01".repeat(32), "0x" + "02".repeat(32)];
  const encoded = `0x${"00".repeat(31)}03${"00".repeat(31)}04`;
  const result = await decryptPublic({
    sdk: {
      decryption: {
        decryptPublicValues: async (got) => ({
          clearValues: { [handles[0]]: 3n, [handles[1]]: 4n },
          abiEncodedClearValues: (assert.deepEqual(got, handles), encoded),
          decryptionProof: "0xaa",
        }),
      },
    },
    handles,
  });
  assert.deepEqual(result, { values: ["3", "4"], proof: "0xaa" });
  await assert.rejects(
    () =>
      decryptPublic({
        sdk: {
          decryption: {
            decryptPublicValues: async () => ({
              clearValues: { [handles[0]]: 3n },
              abiEncodedClearValues: encoded,
              decryptionProof: "0xaa",
            }),
          },
        },
        handles,
      }),
    /missing/,
  );
});

test("unverified current-principal callback cannot reach SDK encryption", async () => {
  const compiled = compileCandidateWorkload(workloadDefinitionFixture(), workloadManifestFixture());
  let calls = 0;
  await assert.rejects(
    () =>
      resolveSdkReferences({
        compiled,
        actionId: "final-request-eoa-00",
        sdk: {
          encrypt: async () => (
            (calls += 1),
            { encryptedValues: ["0x" + "01".repeat(32)], inputProof: "0x01" }
          ),
        },
      }),
    /pinned evidence/,
  );
  assert.equal(calls, 0);
});
