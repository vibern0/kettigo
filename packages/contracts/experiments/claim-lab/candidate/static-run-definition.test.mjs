import assert from "node:assert/strict";
import { chmod, mkdtemp, open, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { envelopeIdentity } from "./journal-values.mjs";
import { ORIGINAL_ENVELOPE } from "./journal.mjs";
import {
  candidateActorRole,
  loadStaticRunDefinition,
  validateStaticRunDefinition,
} from "./static-run-definition.mjs";

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
    creationInputDigests: [digest(1), digest(2), digest(3)],
    deploymentCreationHashes: [digest(4), digest(5), digest(6)],
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
test("accepts only the closed StaticA schema and exact creation hash cardinality", () => {
  const loaded = validateStaticRunDefinition(definition());
  assert.deepEqual(Object.keys(loaded), [
    "chainId",
    "envelopeIdentity",
    "policy",
    "actors",
    "contracts",
    "allowedEoaTargets",
    "creationInputDigests",
    "deploymentCreationHashes",
    "workloadIds",
    "initialFundingWorkloadIds",
  ]);
  for (const mutate of [
    (value) => (value.extra = true),
    (value) => delete value.chainId,
    (value) => (value.chainId = 1),
    (value) => (value.actors.unexpected = hex(99)),
    (value) => (value.contracts.unexpected = hex(99)),
    (value) => (value.initialFundingWorkloadIds = ["bootstrap-eth", "missing"]),
    (value) => (value.initialFundingWorkloadIds = ["bootstrap-eth", "bootstrap-eth"]),
    (value) => (value.creationInputDigests = [digest(1), digest(2)]),
    (value) => (value.deploymentCreationHashes = [digest(1), digest(2), digest(3), digest(4)]),
    (value) => (value.creationInputDigests = ["not-a-hash", digest(2), digest(3)]),
  ]) {
    const value = definition();
    mutate(value);
    assert.throws(() => validateStaticRunDefinition(value));
  }
});
test("redacts private definition permission and parser failures", async () => {
  const path = await file(definition(), 0o644);
  await assert.rejects(
    loadStaticRunDefinition(path),
    /definition unavailable or permissions invalid/,
  );
});

test("reads a complete checked descriptor across forced short reads", async () => {
  const path = await file(definition());
  const probe = await open(path, "r");
  const prototype = Object.getPrototypeOf(probe);
  const original = prototype.read;
  await probe.close();
  prototype.read = function (buffer, offset, length, position) {
    return original.call(this, buffer, offset, Math.min(length, 97), position);
  };
  try {
    assert.equal((await loadStaticRunDefinition(path)).actors.eoaParticipants.length, 32);
  } finally {
    prototype.read = original;
  }
});

test("parses the checked descriptor after its path is replaced", async () => {
  const path = await file(definition());
  const replacement = await file({});
  const probe = await open(path, "r");
  const prototype = Object.getPrototypeOf(probe);
  const original = prototype.stat;
  await probe.close();
  let replaced = false;
  prototype.stat = async function (...args) {
    const result = await original.apply(this, args);
    if (!replaced) {
      replaced = true;
      await rename(replacement, path);
    }
    return result;
  };
  try {
    assert.equal((await loadStaticRunDefinition(path)).chainId, 11155111);
  } finally {
    prototype.stat = original;
  }
});

test("rejects growth after descriptor metadata is checked", async () => {
  const value = definition();
  const path = await file(value);
  const probe = await open(path, "r");
  const prototype = Object.getPrototypeOf(probe);
  const original = prototype.stat;
  await probe.close();
  let grown = false;
  prototype.stat = async function (...args) {
    const result = await original.apply(this, args);
    if (!grown) {
      grown = true;
      await writeFile(path, `${JSON.stringify(value)}${" ".repeat(65_537)}`);
    }
    return result;
  };
  try {
    await assert.rejects(loadStaticRunDefinition(path), /definition unavailable/);
  } finally {
    prototype.stat = original;
  }
});
