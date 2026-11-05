import assert from "node:assert/strict";
import test from "node:test";

import { compileCandidateWorkload, workloadFingerprint } from "./eoa-workload-definition.mjs";

const hex = (value) => `0x${value.toString(16).padStart(40, "0")}`;
const hash = (value) => `0x${value.toString(16).padStart(64, "0")}`;
function definition() {
  return {
    actors: {
      eoaParticipants: Array.from({ length: 32 }, (_, index) => hex(index + 1)),
      safeParticipant: hex(40),
      sponsor: hex(41),
      bootstrapOperator: hex(42),
    },
    contracts: {
      candidatePool: hex(50),
      wrapper: hex(51),
      adapter: hex(52),
      underlying: hex(53),
      safe4337Module: hex(54),
      entryPoint: hex(55),
      multiSend: hex(56),
      factory: hex(57),
      setup: hex(58),
    },
    allowedEoaTargets: [hex(50), hex(51), hex(52), hex(53)],
    creationInputDigests: [hash(1), hash(2), hash(3)],
    deploymentCreationHashes: [hash(4), hash(5), hash(6)],
    workloadIds: ["bootstrap", "deploy", "deposit", "draw", "exit", "final"],
    initialFundingWorkloadIds: ["bootstrap-eth", "bootstrap-usdc"],
  };
}
function manifest() {
  return {
    chainId: 11155111,
    creations: ["wrapper", "pool", "adapter"].map((role, index) => ({
      role,
      sourceId: `contracts/${role}.sol:${role}`,
      compilerBuildHash: hash(index + 10),
      creationBytecodeHash: hash(index + 20),
      inputDigest: hash(index + 1),
      constructor: { signature: `${role}(address)`, args: [hex(53)] },
    })),
  };
}

test("compiles the fixed 375-action graph without putting actions in StaticA phase IDs", () => {
  const workload = compileCandidateWorkload(definition(), manifest());
  assert.equal(workload.actions.length, 375);
  assert.equal(workload.counts.eoa, 362);
  assert.equal(workload.counts.safe, 13);
  assert.equal(workload.totals.usdcMicro, "78000000");
  assert.equal(workload.totals.grossFundingWei, "1640000000000000");
  assert.equal(workload.actions[0].id, "bootstrap-eth");
  assert.equal(workload.actions[1].id, "bootstrap-usdc");
  assert.equal(new Set(workload.actions.map((action) => action.id)).size, 375);
  assert.equal(workloadFingerprint(workload), workload.fingerprint);
});

test("keeps the Safe exit/reuse/rejoin ordering and rejects a changed static template", () => {
  const workload = compileCandidateWorkload(definition(), manifest());
  const index = (id) => workload.actions.findIndex((action) => action.id === id);
  assert.ok(index("safe-exit-membership") < index("eoa00-reuse-slot-0"));
  assert.ok(index("eoa00-reuse-slot-0") < index("safe-rejoin-slot-1"));
  assert.ok(index("safe-rejoin-slot-1") < index("admit-eoa06-stage-8"));
  assert.ok(index("safe-rejoin-slot-1") < index("safe-delayed-check-b"));
  assert.ok(index("morpho-initial-6") < index("safe-exit-membership"));
  const changed = definition();
  changed.creationInputDigests[0] = hash(99);
  const changedManifest = manifest();
  changedManifest.creations[0].inputDigest = hash(99);
  assert.notEqual(
    compileCandidateWorkload(changed, changedManifest).fingerprint,
    workload.fingerprint,
  );
});

test("rejects incomplete registry provenance rather than compiling a hash-only workload", () => {
  const incomplete = definition();
  incomplete.creationInputDigests = [];
  assert.throws(() => compileCandidateWorkload(incomplete, manifest()), /creation/i);
});

test("rejects missing or mismatched creation manifest records", () => {
  assert.throws(() => compileCandidateWorkload(definition()), /manifest/i);
  const wrong = manifest();
  wrong.creations[0].inputDigest = hash(99);
  assert.throws(() => compileCandidateWorkload(definition(), wrong), /manifest/i);
});
