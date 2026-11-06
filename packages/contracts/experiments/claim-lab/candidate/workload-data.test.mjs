import assert from "node:assert/strict";
import test from "node:test";

import {
  decryptPublic,
  decryptPublicMarker,
  resolveSdkInput,
  resolveSdkReferences,
} from "./workload-data.ts";
import { compileCandidateWorkload } from "./eoa-workload-definition.mjs";
import { encodeCandidateEoaAction } from "./workload-calldata.mjs";
import {
  workloadDefinitionFixture,
  workloadManifestFixture,
} from "./eoa-workload-test-fixture.mjs";

const pool = "0x1111111111111111111111111111111111111111";
const actor = "0x2222222222222222222222222222222222222222";
const checksumPool = "0x52908400098527886E0F7030069857D2E4169EE7";
const checksumActor = "0x8617E340B3D01FA5F11F306F4090FD50E238070D";
const handle = (byte) => `0x${byte.repeat(32)}`;
const uint64 = (value) => `0x${"00".repeat(31)}${value.toString(16).padStart(2, "0")}`;

test("SDK input normalizes its checksum pair and binds one encrypted value to its proof", async () => {
  const calls = [];
  const result = await resolveSdkInput({
    sdk: {
      encrypt: async (input) => {
        calls.push(input);
        return { encryptedValues: ["0x" + "ab".repeat(32)], inputProof: "0x1234" };
      },
    },
    contract: checksumPool.toLowerCase(),
    actor: checksumActor.toLowerCase(),
    amount: "7",
  });
  assert.deepEqual(calls, [
    {
      values: [{ type: "euint64", value: 7n }],
      contractAddress: checksumPool,
      userAddress: checksumActor,
    },
  ]);
  assert.equal(result.handle, "0x" + "ab".repeat(32));
  assert.equal(result.proof, "0x1234");
});

test("SDK input fails closed for malformed values, handles, proofs, and amounts", async () => {
  const invalidOutputs = [
    {},
    { encryptedValues: [], inputProof: "0x01" },
    { encryptedValues: [handle("01"), handle("02")], inputProof: "0x01" },
    { encryptedValues: ["0x01"], inputProof: "0x01" },
    { encryptedValues: [handle("01")], inputProof: undefined },
    { encryptedValues: [handle("01")], inputProof: "0x" },
    { encryptedValues: [handle("01")], inputProof: "0x0" },
  ];
  for (const output of invalidOutputs) {
    let calls = 0;
    await assert.rejects(() =>
      resolveSdkInput({
        sdk: { encrypt: async () => ((calls += 1), output) },
        contract: pool,
        actor,
        amount: "1",
      }),
    );
    assert.equal(calls, 1);
  }
  for (const amount of ["01", "+1", "1.0", " 1", "18446744073709551616"]) {
    let calls = 0;
    await assert.rejects(() =>
      resolveSdkInput({
        sdk: {
          encrypt: async () => (
            (calls += 1),
            { encryptedValues: [handle("01")], inputProof: "0x01" }
          ),
        },
        contract: pool,
        actor,
        amount,
      }),
    );
    assert.equal(calls, 0);
  }
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

test("admission marker binds native false to its bool ABI value and nonempty proof", async () => {
  const marker = handle("01");
  const sdk = {
    decryption: {
      decryptPublicValues: async (handles) => {
        assert.deepEqual(handles, [marker]);
        return {
          clearValues: { [marker]: false },
          abiEncodedClearValues: uint64(0),
          decryptionProof: "0xab",
        };
      },
    },
  };
  assert.deepEqual(await decryptPublicMarker({ sdk, handle: marker }), {
    value: false,
    proof: "0xab",
  });
  for (const result of [
    {
      clearValues: { [marker]: "false" },
      abiEncodedClearValues: uint64(0),
      decryptionProof: "0x01",
    },
    { clearValues: { [marker]: 0 }, abiEncodedClearValues: uint64(0), decryptionProof: "0x01" },
    { clearValues: { [marker]: 0n }, abiEncodedClearValues: uint64(0), decryptionProof: "0x01" },
    { clearValues: {}, abiEncodedClearValues: uint64(0), decryptionProof: "0x01" },
    { clearValues: { [marker]: false }, abiEncodedClearValues: "0x", decryptionProof: "0x01" },
    { clearValues: { [marker]: false }, abiEncodedClearValues: uint64(0), decryptionProof: "0x" },
  ])
    await assert.rejects(() =>
      decryptPublicMarker({
        sdk: { decryption: { decryptPublicValues: async () => result } },
        handle: marker,
      }),
    );
});

test("public uint64 decryption binds one or two own handles to ordered ABI values", async () => {
  const handles = [handle("01"), handle("02")];
  const encoded = `${uint64(3)}${uint64(4).slice(2)}`;
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
  assert.deepEqual(
    await decryptPublic({
      sdk: {
        decryption: {
          decryptPublicValues: async () => ({
            clearValues: { [handles[0]]: 3n },
            abiEncodedClearValues: uint64(3),
            decryptionProof: "0xaa",
          }),
        },
      },
      handles: [handles[0]],
    }),
    { values: ["3"], proof: "0xaa" },
  );
  const prototypeOnly = Object.create({ [handles[0]]: 3n });
  for (const result of [
    {
      clearValues: { [handles[0]]: -1n, [handles[1]]: 4n },
      abiEncodedClearValues: encoded,
      decryptionProof: "0xaa",
    },
    {
      clearValues: { [handles[0]]: 1n << 64n, [handles[1]]: 4n },
      abiEncodedClearValues: encoded,
      decryptionProof: "0xaa",
    },
    {
      clearValues: { [handles[0]]: "3", [handles[1]]: 4n },
      abiEncodedClearValues: encoded,
      decryptionProof: "0xaa",
    },
    { clearValues: { [handles[0]]: 3n }, abiEncodedClearValues: encoded, decryptionProof: "0xaa" },
    { clearValues: prototypeOnly, abiEncodedClearValues: encoded, decryptionProof: "0xaa" },
    {
      clearValues: { [handles[0]]: 3n, [handles[1]]: 4n },
      abiEncodedClearValues: "0x",
      decryptionProof: "0xaa",
    },
    {
      clearValues: { [handles[0]]: 3n, [handles[1]]: 4n },
      abiEncodedClearValues: `${uint64(4)}${uint64(3).slice(2)}`,
      decryptionProof: "0xaa",
    },
  ])
    await assert.rejects(() =>
      decryptPublic({ sdk: { decryption: { decryptPublicValues: async () => result } }, handles }),
    );
  await assert.rejects(() =>
    decryptPublic({
      sdk: { decryption: { decryptPublicValues: async () => ({}) } },
      handles: [handles[0], handles[0]],
    }),
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

test("SDK deposit records feed the approved encoder in nested wrapper order", async () => {
  const compiled = compileCandidateWorkload(workloadDefinitionFixture(), workloadManifestFixture());
  const actionId = "eoa-00-deposit",
    action = compiled.actions.find((entry) => entry.id === actionId);
  const records = [
    ...(await resolveSdkReferences({
      compiled,
      actionId,
      sdk: {
        encrypt: async () => ({ encryptedValues: ["0x" + "ab".repeat(32)], inputProof: "0x1234" }),
      },
    })),
  ];
  const delegate = action.operation.args[0][1].args[3];
  records.push({
    reference: delegate,
    value: "0x",
    scope: {
      actionId,
      workloadFingerprint: compiled.fingerprint,
      reference: delegate,
      contract: null,
    },
  });
  const encoded = encodeCandidateEoaAction({
    compiled,
    actionId,
    resolved: { actionId, workloadFingerprint: compiled.fingerprint, references: records },
  });
  assert.match(encoded.data, /^0x/);
  assert.equal(records[0].value, "0x" + "ab".repeat(32));
  assert.equal(records[1].value, "0x1234");
});
