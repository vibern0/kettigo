import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { envelopeIdentity } from "./journal-values.mjs";
import { ORIGINAL_ENVELOPE } from "./journal.mjs";
import { candidateActorRole, loadStaticRunDefinition } from "./static-run-definition.mjs";

const hex = (value) => `0x${value.toString(16).padStart(40, "0")}`;
const digest = (value) => `0x${value.toString(16).padStart(64, "0")}`;
function definition() {
  const eoaParticipants = Array.from({ length: 32 }, (_, index) => hex(index + 1));
  return {
    version: 1,
    chainId: 11155111,
    envelopeIdentity: envelopeIdentity(ORIGINAL_ENVELOPE),
    actors: {
      eoaParticipants,
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
    allowedEoaTargets: [hex(50), hex(53)],
    creationInputDigests: [digest(1)],
    deploymentCreationHashes: [digest(2)],
    workloadIds: ["bootstrap-eth", "bootstrap-usdc", "deploy"],
    initialFundingWorkloadIds: ["bootstrap-eth", "bootstrap-usdc"],
  };
}
async function file(value, mode = 0o600) {
  const directory = await mkdtemp(join(tmpdir(), "kettigo-definition-"));
  const path = join(directory, "definition.json");
  await writeFile(path, JSON.stringify(value), { mode });
  await chmod(path, mode);
  return path;
}

test("loads the fixed participant registry and keeps bootstrap separate", async () => {
  const loaded = await loadStaticRunDefinition(await file(definition()));
  assert.equal(loaded.actors.eoaParticipants.length, 32);
  assert.equal(candidateActorRole(loaded, loaded.actors.safeParticipant), "safeParticipant");
  assert.equal(candidateActorRole(loaded, loaded.actors.bootstrapOperator), "bootstrapOperator");
  assert.throws(() => candidateActorRole(loaded, hex(99)), /unknown actor/);
});
test("rejects malformed policy identity, actor conflicts, and forbidden targets", async () => {
  for (const mutate of [
    (value) => (value.envelopeIdentity = digest(99)),
    (value) => (value.actors.sponsor = value.actors.eoaParticipants[0]),
    (value) => (value.allowedEoaTargets = ["0xAdB8F835E565aC7e71d2DF6cFBd0FC003fa22C27"]),
  ]) {
    const value = definition();
    mutate(value);
    await assert.rejects(loadStaticRunDefinition(await file(value)));
  }
});
test("rejects actor reuse as a contract identity", async () => {
  const value = definition();
  value.contracts.adapter = value.actors.sponsor;
  await assert.rejects(loadStaticRunDefinition(await file(value)), /cross-role/);
});
test("redacts private definition permission and parser failures", async () => {
  const path = await file(definition(), 0o644);
  await assert.rejects(
    loadStaticRunDefinition(path),
    /definition unavailable or permissions invalid/,
  );
});
