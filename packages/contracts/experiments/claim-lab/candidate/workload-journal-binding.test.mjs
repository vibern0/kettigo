import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CandidateRunJournal, ORIGINAL_ENVELOPE } from "./journal.mjs";

const binding = (fingerprint = "0x" + "1".repeat(64)) => ({
  fingerprint,
  version: 1,
  phaseIds: ["bootstrap"],
});

test("binds an immutable workload before first financial reservation without starting the clock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kettigo-workload-bind-"));
  const journal = await CandidateRunJournal.open({
    directory,
    envelope: ORIGINAL_ENVELOPE,
    now: () => 1000,
  });
  await journal.bindWorkloadDefinition(binding());
  assert.equal(journal.snapshot().startedAt, null);
  assert.deepEqual(journal.workloadDefinition(), binding());
  await assert.rejects(
    journal.bindWorkloadDefinition(binding("0x" + "2".repeat(64))),
    /replacement/,
  );
  await journal.close();
  const restarted = await CandidateRunJournal.open({
    directory,
    envelope: ORIGINAL_ENVELOPE,
    now: () => 1000,
  });
  assert.deepEqual(restarted.workloadDefinition(), binding());
  await restarted.close();
});

test("refuses retroactive workload binding after a financial reservation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kettigo-workload-bind-"));
  const journal = await CandidateRunJournal.open({
    directory,
    envelope: ORIGINAL_ENVELOPE,
    now: () => 1000,
  });
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
  await assert.rejects(journal.bindWorkloadDefinition(binding()), /financial reservation/);
  await journal.close();
});
