import assert from "node:assert/strict";
import test from "node:test";

import { compileCandidateWorkload, workloadFingerprint } from "./eoa-workload-definition.mjs";
import { envelopeIdentity } from "./journal-values.mjs";
import { ORIGINAL_ENVELOPE } from "./journal.mjs";

const hex = (value) => `0x${value.toString(16).padStart(40, "0")}`;
const hash = (value) => `0x${value.toString(16).padStart(64, "0")}`;
function definition() {
  return {
    version: 1,
    chainId: 11155111,
    envelopeIdentity: envelopeIdentity(ORIGINAL_ENVELOPE),
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
    workloadIds: ["bootstrap-eth", "bootstrap-usdc", "deploy"],
    initialFundingWorkloadIds: ["bootstrap-eth", "bootstrap-usdc"],
  };
}
function manifest() {
  return {
    chainId: 11155111,
    compiler: { version: "0.8.28", optimizerRuns: 200, viaIR: true, evmVersion: "cancun" },
    creations: ["wrapper", "pool", "adapter"].map((role, index) => ({
      role,
      sourceId: [
        "contracts/ConfidentialUSDC.sol:ConfidentialUSDC",
        "contracts/ConfidentialPrizePool.sol:ConfidentialPrizePool",
        "contracts/MorphoYieldAdapter.sol:MorphoYieldAdapter",
      ][index],
      artifactProvenance: {
        sourceId: [
          "contracts/ConfidentialUSDC.sol:ConfidentialUSDC",
          "contracts/ConfidentialPrizePool.sol:ConfidentialPrizePool",
          "contracts/MorphoYieldAdapter.sol:MorphoYieldAdapter",
        ][index],
        contractName: ["ConfidentialUSDC", "ConfidentialPrizePool", "MorphoYieldAdapter"][index],
      },
      compilerBuildHash: hash(index + 10),
      creationBytecodeHash: hash(index + 4),
      inputDigest: hash(index + 1),
      constructor: {
        signature: [
          "wrapper(address)",
          "pool(address,uint256,uint256)",
          "adapter(address,address,address,address,(address,address,address,address,uint256))",
        ][index],
        args:
          index === 0
            ? [hex(53)]
            : index === 1
              ? [hex(51), "1", "2"]
              : [
                  hex(53),
                  hex(51),
                  hex(50),
                  hex(60),
                  {
                    loanToken: hex(53),
                    collateralToken: hex(61),
                    oracle: hex(62),
                    irm: hex(63),
                    lltv: "860000000000000000",
                  },
                ],
      },
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
  const phase = (name) =>
    workload.actions.filter((action) => action.kind === "eoa" && action.phase === name).length;
  assert.equal(phase("setup"), 71);
  assert.equal(phase("deposit"), 96);
  assert.equal(phase("draw"), 88);
  assert.equal(phase("queue"), 7);
  assert.equal(phase("final"), 100);
  assert.equal(workload.actions.filter((action) => action.kind === "externalSafe").length, 13);
  assert.equal(workload.actions.filter((action) => action.actorRole === "participant").length, 206);
});

test("encodes Safe exit/reuse/rejoin as dependency edges and rejects a changed static template", () => {
  const workload = compileCandidateWorkload(definition(), manifest());
  const action = (id) => workload.actions.find((entry) => entry.id === id);
  assert.ok(action("eoa-00-approve").dependencies.includes("safe-exit-membership"));
  assert.ok(action("safe-rejoin-deposit").dependencies.includes("eoa-00-admit"));
  assert.ok(action("eoa-01-approve").dependencies.includes("safe-rejoin-admission"));
  assert.ok(action("safe-delayed-check-b").dependencies.includes("safe-rejoin-admission"));
  assert.equal(action("safe-conditional-wallet-claim").status, "PENDING");
  assert.equal(action("check-stage8-eoa-00").operation.args.length, 8);
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

test("rejects unknown manifest fields, provenance mismatches, and malformed typed constructors", () => {
  const cases = [
    (value) => (value.extra = true),
    (value) => (value.compiler.viaIR = false),
    (value) => (value.creations[0].unknown = true),
    (value) => (value.creations[1].role = "wrapper"),
    (value) => (value.creations[2].sourceId = "contracts/pool.sol:pool"),
    (value) => (value.creations[0].artifactProvenance.contractName = "pool"),
    (value) => (value.creations[0].constructor.signature = "anything(address)"),
    (value) => value.creations[0].constructor.args.push(hex(99)),
    (value) => (value.creations[0].constructor.args[0] = hex(99)),
    (value) => (value.creations[1].constructor.args[1] = "-1"),
    (value) => (value.creations[2].constructor.args[2] = hex(99)),
    (value) => (value.creations[2].constructor.args[4].loanToken = hex(99)),
    (value) => (value.creations[2].constructor.args[4].extra = true),
  ];
  for (const mutate of cases) {
    const value = manifest();
    mutate(value);
    assert.throws(
      () => compileCandidateWorkload(definition(), value),
      /manifest|constructor|wrong|invalid/i,
    );
  }
});

test("canonicalizes complete creation input without retaining mutable aliases", () => {
  const input = manifest();
  const workload = compileCandidateWorkload(definition(), input);
  input.creations[2].constructor.args[4].lltv = "1";
  assert.equal(
    workload.definition.manifest.creations[2].constructor.args[4].lltv,
    "860000000000000000",
  );
  assert.ok(Object.isFrozen(workload.definition.manifest.creations[2].constructor.args[4]));
  assert.equal(workloadFingerprint(workload), workload.fingerprint);
});
