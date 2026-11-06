import assert from "node:assert/strict";
import test from "node:test";

import {
  decryptPublic,
  decryptPublicMarker,
  FIXED_ENTRY_POINT_07,
  resolvePinnedCurrentPrincipal,
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

function principalFixture(compiled, actionId = "final-request-eoa-00") {
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

test("pinned current principal creates fresh SDK records for the exact final EOA action", async () => {
  const compiled = compileCandidateWorkload(workloadDefinitionFixture(), workloadManifestFixture());
  const { input, action } = principalFixture(compiled);
  const records = await resolvePinnedCurrentPrincipal(input);
  assert.equal(records.length, 2);
  assert.deepEqual(records[0].reference, action.operation.args[0]);
  assert.equal(records[0].scope.reference, records[0].reference);
  assert.equal(records[0].value, handle("22"));
  assert.deepEqual(records[1].reference, action.operation.args[1]);
  assert.equal(records[1].value, "0x1234");
});

test("pinned principal denies nonfinal descriptors and incomplete dependency certificates before SDK work", async () => {
  const compiled = compileCandidateWorkload(workloadDefinitionFixture(), workloadManifestFixture());
  for (const change of [
    (fixture) => (fixture.input.actionId = "safe-withdrawal-request"),
    (fixture) => fixture.input.dependencyCompletions.pop(),
    (fixture) => fixture.input.dependencyCompletions.reverse(), // ordered dependency arrays are not canonicalized
    (fixture) => (fixture.input.dependencyCompletions[0].evidence.outerTransactionHash = "0x01"),
    (fixture) => (fixture.input.pinnedRead.hash = "0x01"),
  ]) {
    const fixture = principalFixture(compiled);
    let decrypts = 0;
    fixture.input.authority.decryptOwnedUint64 = async () => ((decrypts += 1), 7n);
    change(fixture);
    await assert.rejects(() => resolvePinnedCurrentPrincipal(fixture.input));
    assert.equal(decrypts, 0);
  }
});

test("pinned principal rejects source reuse and same-block reorg after SDK work", async () => {
  const compiled = compileCandidateWorkload(workloadDefinitionFixture(), workloadManifestFixture());
  for (const mode of ["reuse", "reorg"]) {
    const fixture = principalFixture(compiled);
    let headers = 0;
    fixture.input.authority.blockAt = async () => {
      headers += 1;
      return {
        number: "100",
        hash: mode === "reorg" && headers === 2 ? handle("cc") : handle("aa"),
      };
    };
    if (mode === "reuse")
      fixture.input.authority.encryptEuint64 = async () => ({
        encryptedValues: [handle("11")],
        inputProof: "0x01",
      });
    await assert.rejects(() => resolvePinnedCurrentPrincipal(fixture.input));
  }
});

test("pinned principal compares every completion to the saved canonical source", async () => {
  const compiled = compileCandidateWorkload(workloadDefinitionFixture(), workloadManifestFixture());
  const fixture = principalFixture(compiled);
  fixture.input.dependencyCompletions[0].evidence.transactionHash = handle("44");
  const trusted = principalFixture(compiled).input.dependencyCompletions;
  fixture.input.authority.completionFor = async (id) =>
    trusted.find((entry) => entry.actionId === id);
  await assert.rejects(
    () => resolvePinnedCurrentPrincipal(fixture.input),
    /untrusted dependency completion/,
  );
});

test("pinned principal accepts an earlier zero-handle conditional skip and rechecks its own block", async () => {
  const compiled = compileCandidateWorkload(workloadDefinitionFixture(), workloadManifestFixture());
  const fixture = principalFixture(compiled);
  const index = fixture.action.dependencies.findIndex((id) => id.startsWith("claim-stage8-eoa-"));
  assert.notEqual(index, -1);
  const actionId = fixture.action.dependencies[index];
  const claim = compiled.actions.find((entry) => entry.id === actionId);
  const child = (id) => ({
    kind: id.startsWith("safe-") ? "safe" : "eoa",
    actionId: id,
    blockNumber: "90",
    blockHash: handle("99"),
    ...(id.startsWith("safe-")
      ? {
          userOperationHash: handle("11"),
          entryPoint: FIXED_ENTRY_POINT_07,
          sender: compiled.actions.find((entry) => entry.id === id).actor,
          outerTransactionHash: handle("12"),
        }
      : { transactionHash: handle("13") }),
  });
  const skipped = {
    kind: "conditional-SKIPPED",
    actionId,
    evidence: {
      actionId,
      workloadFingerprint: compiled.fingerprint,
      condition: "positive-credit-or-SKIPPED",
      pool: fixture.action.target,
      account: claim.actor,
      getter: "encryptedWinningsOf(address)",
      readBlock: { number: "95", hash: handle("95"), recheckedHash: handle("95") },
      dependencies: claim.dependencies.map(child),
      handle: handle("00"),
      clearCredit: "0",
      resolution: "uninitialized-zero-handle",
    },
  };
  fixture.input.dependencyCompletions[index] = skipped;
  fixture.input.authority.blockAt = async (number) => ({
    number: number.toString(),
    hash: number === 95n ? handle("95") : handle("aa"),
  });
  assert.equal((await resolvePinnedCurrentPrincipal(fixture.input))[0].value, handle("22"));
  skipped.evidence.resolution = "user-decrypt";
  await assert.rejects(
    () => resolvePinnedCurrentPrincipal(fixture.input),
    /conditional handle resolution/,
  );
});

test("pinned principal rejects an unknown conditional resolution before authority work", async () => {
  const compiled = compileCandidateWorkload(workloadDefinitionFixture(), workloadManifestFixture());
  const fixture = principalFixture(compiled);
  const index = fixture.action.dependencies.findIndex((id) => id.startsWith("claim-stage8-eoa-"));
  const actionId = fixture.action.dependencies[index];
  const claim = compiled.actions.find((entry) => entry.id === actionId);
  const skipped = {
    kind: "conditional-SKIPPED",
    actionId,
    evidence: {
      actionId,
      workloadFingerprint: compiled.fingerprint,
      condition: "positive-credit-or-SKIPPED",
      pool: fixture.action.target,
      account: claim.actor,
      getter: "encryptedWinningsOf(address)",
      readBlock: { number: "95", hash: handle("95"), recheckedHash: handle("95") },
      dependencies: [],
      handle: handle("00"),
      clearCredit: "0",
      resolution: "unknown",
    },
  };
  fixture.input.dependencyCompletions[index] = skipped;
  fixture.input.authority.completionFor = async (id) =>
    fixture.input.dependencyCompletions.find((entry) => entry.actionId === id);
  let decrypts = 0;
  fixture.input.authority.decryptOwnedUint64 = async () => ((decrypts += 1), 7n);
  await assert.rejects(() => resolvePinnedCurrentPrincipal(fixture.input), /unresolved/);
  assert.equal(decrypts, 0);
});

test("pinned principal canonicalizes equivalent completion object keys", async () => {
  const compiled = compileCandidateWorkload(workloadDefinitionFixture(), workloadManifestFixture());
  const fixture = principalFixture(compiled);
  const saved = structuredClone(fixture.input.dependencyCompletions[0]);
  const reverseKeys = (value) =>
    Array.isArray(value)
      ? value.map(reverseKeys)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverseKeys(entry)]))
        : value;
  fixture.input.dependencyCompletions[0] = reverseKeys(saved);
  fixture.input.authority.completionFor = async (id) =>
    id === saved.actionId ? saved : fixture.input.dependencyCompletions.find((entry) => entry.actionId === id);
  assert.equal((await resolvePinnedCurrentPrincipal(fixture.input))[0].value, handle("22"));
});

test("pinned resolver fixes its action scope and preserves authority method receivers", async () => {
  const compiled = compileCandidateWorkload(workloadDefinitionFixture(), workloadManifestFixture());
  const fixture = principalFixture(compiled);
  const original = fixture.input.authority;
  class Authority {
    calls = 0;
    readEncryptedPrincipalAt = original.readEncryptedPrincipalAt;
    decryptOwnedUint64 = original.decryptOwnedUint64;
    encryptEuint64 = original.encryptEuint64;
    async blockAt(number) {
      this.calls += 1;
      return original.blockAt(number);
    }
    async completionFor(actionId) {
      this.calls += 1;
      return original.completionFor(actionId);
    }
  }
  const authority = new Authority();
  const records = await resolveSdkReferences({
    compiled,
    actionId: "final-request-eoa-00",
    sdk: { encrypt: async () => assert.fail("wrapper SDK encryption must not run") },
    pinnedCurrentPrincipal: {
      pinnedRead: fixture.input.pinnedRead,
      dependencyCompletions: fixture.input.dependencyCompletions,
      authority,
      compiled: { actions: [] },
      actionId: "foreign-action",
    },
  });
  assert.equal(records[0].scope.actionId, "final-request-eoa-00");
  assert.ok(authority.calls > 0);
});

test("SDK resolver admits a current principal only through pinned authority", async () => {
  const compiled = compileCandidateWorkload(workloadDefinitionFixture(), workloadManifestFixture());
  const fixture = principalFixture(compiled);
  const records = await resolveSdkReferences({
    compiled,
    actionId: "final-request-eoa-00",
    sdk: { encrypt: async () => assert.fail("wrapper SDK encryption must not run") },
    pinnedCurrentPrincipal: {
      pinnedRead: fixture.input.pinnedRead,
      dependencyCompletions: fixture.input.dependencyCompletions,
      authority: fixture.input.authority,
    },
  });
  assert.equal(records[0].value, handle("22"));
});

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
