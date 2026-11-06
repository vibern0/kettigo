import assert from "node:assert/strict";
import test from "node:test";

import { encodeCandidateEoaAction } from "./workload-calldata.mjs";
import { FIXED_ENTRY_POINT_07 } from "./workload-data.ts";
import { compileCandidateWorkload } from "./eoa-workload-definition.mjs";
import {
  workloadDefinitionFixture,
  workloadManifestFixture,
} from "./eoa-workload-test-fixture.mjs";
import { handle, principalFixture } from "./workload-principal-test-fixture.mjs";
import { resolveCandidateAction } from "./workload-resolver.ts";

const compiledFinal = () =>
  compileCandidateWorkload(workloadDefinitionFixture(), workloadManifestFixture());

function addConditionalSkip(compiled, fixture) {
  const index = fixture.action.dependencies.findIndex((id) => id.startsWith("claim-stage8-eoa-"));
  const actionId = fixture.action.dependencies[index];
  const claim = compiled.actions.find((entry) => entry.id === actionId);
  const dependency = (id) => ({
    kind: id.startsWith("safe-") ? "safe" : "eoa",
    actionId: id,
    blockNumber: "90",
    blockHash: handle("99"),
    ...(id.startsWith("safe-")
      ? {
          userOperationHash: handle("01"),
          entryPoint: FIXED_ENTRY_POINT_07,
          sender: compiled.actions.find((entry) => entry.id === id).actor,
          outerTransactionHash: handle("02"),
        }
      : { transactionHash: handle("03") }),
  });
  fixture.input.dependencyCompletions[index] = {
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
      dependencies: claim.dependencies.map(dependency),
      handle: handle("00"),
      clearCredit: "0",
      resolution: "uninitialized-zero-handle",
    },
  };
  fixture.input.authority.blockAt = async (number) => ({
    number: number.toString(),
    hash: number === 95n ? handle("95") : handle("aa"),
  });
}

test("resolver feeds the encoder a fresh pinned current-principal input and proof", async () => {
  const compiled = compiledFinal();
  const fixture = principalFixture(compiled);
  addConditionalSkip(compiled, fixture);
  const encryptions = [];
  const originalEncrypt = fixture.input.authority.encryptEuint64;
  fixture.input.authority.encryptEuint64 = async (pool, account, amount) => {
    encryptions.push({ pool, account, amount });
    return originalEncrypt(pool, account, amount);
  };
  const references = await resolveCandidateAction({
    compiled,
    actionId: "final-request-eoa-00",
    sdk: { encrypt: async () => assert.fail("resolver SDK must not replace pinned authority") },
    pinnedCurrentPrincipal: {
      pinnedRead: fixture.input.pinnedRead,
      dependencyCompletions: fixture.input.dependencyCompletions,
      authority: fixture.input.authority,
    },
  });
  assert.deepEqual(encryptions, [
    { pool: fixture.action.target, account: fixture.action.actor, amount: 7n },
  ]);
  assert.equal(references[0].value, handle("22"));
  assert.equal(references[1].value, "0x1234");
  const encoded = encodeCandidateEoaAction({
    compiled,
    actionId: "final-request-eoa-00",
    resolved: {
      actionId: "final-request-eoa-00",
      workloadFingerprint: compiled.fingerprint,
      references,
    },
  });
  assert.ok(encoded.data.includes(handle("22").slice(2)));
  assert.ok(encoded.data.includes("1234"));
  assert.ok(!encoded.data.includes(handle("11").slice(2)));
});

test("resolver rejects a saved dependency mismatch before fresh principal encryption", async () => {
  const compiled = compiledFinal();
  const fixture = principalFixture(compiled);
  const saved = principalFixture(compiled).input.dependencyCompletions;
  fixture.input.dependencyCompletions[0].evidence.transactionHash = handle("44");
  fixture.input.authority.completionFor = async (actionId) =>
    saved.find((entry) => entry.actionId === actionId);
  let encryptions = 0;
  fixture.input.authority.encryptEuint64 = async () => ((encryptions += 1), assert.fail());
  await assert.rejects(
    () =>
      resolveCandidateAction({
        compiled,
        actionId: "final-request-eoa-00",
        sdk: { encrypt: async () => assert.fail("resolver SDK must not run") },
        pinnedCurrentPrincipal: {
          pinnedRead: fixture.input.pinnedRead,
          dependencyCompletions: fixture.input.dependencyCompletions,
          authority: fixture.input.authority,
        },
      }),
    /untrusted dependency completion/,
  );
  assert.equal(encryptions, 0);
});
