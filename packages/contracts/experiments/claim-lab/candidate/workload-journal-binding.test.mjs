import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compileCandidateWorkload, workloadFingerprint } from "./eoa-workload-definition.mjs";
import {
  workloadDefinitionFixture,
  workloadManifestFixture,
} from "./eoa-workload-test-fixture.mjs";
import { CandidateRunJournal, ORIGINAL_ENVELOPE } from "./journal.mjs";

const directory = () => mkdtemp(join(tmpdir(), "kettigo-workload-bind-"));
const workload = () =>
  compileCandidateWorkload(workloadDefinitionFixture(), workloadManifestFixture());
const copy = (value) => JSON.parse(JSON.stringify(value));
const open = (directoryPath) =>
  CandidateRunJournal.open({
    directory: directoryPath,
    envelope: ORIGINAL_ENVELOPE,
    now: () => 1000,
  });
const persisted = async (directoryPath) =>
  JSON.parse(await readFile(join(directoryPath, "journal.json"), "utf8"));
async function replacePersistedWorkload(directoryPath, workloadDefinition) {
  const state = await persisted(directoryPath);
  state.workloadDefinition = workloadDefinition;
  await writeFile(join(directoryPath, "journal.json"), JSON.stringify(state));
}

test("binds the full canonical workload before finance, returns clones, and survives restart", async () => {
  const directoryPath = await directory();
  const journal = await open(directoryPath);
  const compiled = workload();
  const bound = await journal.bindWorkloadDefinition(compiled);
  assert.deepEqual(bound, compiled);
  assert.equal(bound.actions.length, 375);
  assert.ok(Buffer.byteLength(JSON.stringify(bound)) < 2_000_000);
  assert.equal(journal.snapshot().startedAt, null);
  assert.equal(journal.snapshot().deadlineAt, null);
  bound.actions[0].id = "changed-copy";
  assert.equal(journal.workloadDefinition().actions[0].id, "bootstrap-eth");
  await journal.bindWorkloadDefinition(workload());
  await journal.close();
  const restarted = await open(directoryPath);
  assert.deepEqual(restarted.workloadDefinition(), compiled);
  await restarted.close();
});

test("rejects changed canonical content at bind even when a caller recomputes its hash", async () => {
  const mutations = {
    actor: (value) => {
      value.actions[0].actorRole = "sponsor";
    },
    target: (value) => {
      value.actions[0].target = value.definition.actors.safeParticipant;
    },
    allocation: (value) => {
      value.actions[0].allocation.valueWei = "1";
    },
    constructor: (value) => {
      value.definition.manifest.creations[0].constructor.args[0] =
        value.definition.contracts.adapter;
    },
    reference: (value) => {
      value.actions[0].refs.tampered = {
        kind: "result",
        producer: "bootstrap-eth",
        field: "hash",
        abiType: "bytes32",
      };
    },
    edge: (value) => {
      value.actions[1].dependencies.push("bootstrap-eth");
    },
  };
  for (const [label, mutate] of Object.entries(mutations)) {
    for (const recompute of [false, true]) {
      const directoryPath = await directory();
      const journal = await open(directoryPath);
      const changed = copy(workload());
      mutate(changed);
      if (recompute) changed.fingerprint = workloadFingerprint(changed);
      await assert.rejects(
        journal.bindWorkloadDefinition(changed),
        /compiled workload|differs|invalid|wrong/i,
        `${label}:${recompute}`,
      );
      await journal.close();
    }
  }
});

test("rejects tampered persisted canonical content on open with stale or recomputed fingerprints", async () => {
  const mutations = {
    actor: (value) => {
      value.actions[0].actorIndex = 1;
    },
    target: (value) => {
      value.actions[0].targetRole = "safeParticipant";
    },
    allocation: (value) => {
      value.actions[0].allocation.usdcMicro = "1";
    },
    constructor: (value) => {
      value.definition.manifest.creations[0].sourceId = "contracts/Other.sol:Other";
    },
    reference: (value) => {
      value.actions[0].refs.tampered = {
        kind: "result",
        producer: "bootstrap-eth",
        field: "hash",
        abiType: "bytes32",
      };
    },
    edge: (value) => {
      value.actions[1].dependencies.push("bootstrap-eth");
    },
  };
  for (const [label, mutate] of Object.entries(mutations)) {
    const directoryPath = await directory();
    const journal = await open(directoryPath);
    await journal.bindWorkloadDefinition(workload());
    await journal.close();
    const changed = (await persisted(directoryPath)).workloadDefinition;
    mutate(changed);
    if (label !== "actor") changed.fingerprint = workloadFingerprint(changed);
    await replacePersistedWorkload(directoryPath, changed);
    await assert.rejects(open(directoryPath), /compiled workload|differs|invalid/i, label);
  }
});

test("keeps unbound legacy journals readable but rejects the old weak binding", async () => {
  for (const binding of [null, undefined]) {
    const directoryPath = await directory();
    const journal = await open(directoryPath);
    await journal.close();
    const state = await persisted(directoryPath);
    if (binding === undefined) delete state.workloadDefinition;
    else state.workloadDefinition = binding;
    await writeFile(join(directoryPath, "journal.json"), JSON.stringify(state));
    const restarted = await open(directoryPath);
    assert.equal(restarted.workloadDefinition(), null);
    await restarted.close();
  }
  const directoryPath = await directory();
  const journal = await open(directoryPath);
  await journal.close();
  await replacePersistedWorkload(directoryPath, {
    version: 1,
    fingerprint: `0x${"1".repeat(64)}`,
    phaseIds: ["setup"],
  });
  await assert.rejects(open(directoryPath), /invalid/i);
});

test("refuses retroactive workload binding after a financial reservation", async () => {
  const directoryPath = await directory();
  const journal = await open(directoryPath);
  await journal.reserve({
    intentId: "existing",
    sender: "0x1111111111111111111111111111111111111111",
    nonce: 0,
    unsignedDigest: "0x" + "1".repeat(64),
    to: "0x2222222222222222222222222222222222222222",
    input: "0x12",
    offeredAt: 1000,
    maxFeeWei: 1n,
    maxGasPriceWei: 1n,
    fundingWei: 0n,
    usdcCommitment: "0",
  });
  await assert.rejects(journal.bindWorkloadDefinition(workload()), /financial reservation/);
  await journal.close();
});
