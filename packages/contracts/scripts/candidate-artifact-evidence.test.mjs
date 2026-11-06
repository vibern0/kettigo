import assert from "node:assert/strict";
import test from "node:test";

import { candidateArtifactEvidence } from "./candidate-artifact-evidence.mjs";

const artifact = (overrides = {}) => ({
  contractName: "ConfidentialPrizePool",
  sourceName: "contracts/ConfidentialPrizePool.sol",
  bytecode: "0x60016000",
  deployedBytecode: "0x60026000",
  metadata: JSON.stringify({
    compiler: { version: "0.8.28+commit.7893614a" },
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "cancun" },
  }),
  ...overrides,
});

test("records reproducible source, creation, runtime, and compiler evidence", () => {
  const evidence = candidateArtifactEvidence(artifact());
  assert.equal(evidence.contractName, "ConfidentialPrizePool");
  assert.equal(evidence.sourceName, "contracts/ConfidentialPrizePool.sol");
  assert.match(evidence.creationBytecodeHash, /^0x[0-9a-f]{64}$/);
  assert.match(evidence.runtimeBytecodeHash, /^0x[0-9a-f]{64}$/);
  assert.equal(evidence.compiler.version, "0.8.28+commit.7893614a");
  assert.deepEqual(evidence.compiler.settings, {
    optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "cancun",
  });
});

test("rejects artifacts without deployable runtime bytecode or pinned compiler settings", () => {
  assert.throws(() => candidateArtifactEvidence(artifact({ deployedBytecode: "0x" })), /runtime/);
  assert.throws(() => candidateArtifactEvidence(artifact({ metadata: "{}" })), /compiler/);
});
