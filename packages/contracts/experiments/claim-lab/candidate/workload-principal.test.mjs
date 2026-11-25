import assert from "node:assert/strict";
import test from "node:test";

import {
  FIXED_ENTRY_POINT_07,
  resolvePinnedCurrentPrincipal,
  resolveSdkReferences,
} from "./workload-data.ts";
import { handle, principalFixture } from "./workload-principal-test-fixture.mjs";
import { compileCandidateWorkload } from "./eoa-workload-definition.mjs";
import {
  workloadDefinitionFixture,
  workloadManifestFixture,
} from "./eoa-workload-test-fixture.mjs";

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
  const saved = globalThis.structuredClone(fixture.input.dependencyCompletions[0]);
  const reverseKeys = (value) =>
    Array.isArray(value)
      ? value.map(reverseKeys)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .reverse()
              .map(([key, entry]) => [key, reverseKeys(entry)]),
          )
        : value;
  fixture.input.dependencyCompletions[0] = reverseKeys(saved);
  fixture.input.authority.completionFor = async (id) =>
    id === saved.actionId
      ? saved
      : fixture.input.dependencyCompletions.find((entry) => entry.actionId === id);
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
