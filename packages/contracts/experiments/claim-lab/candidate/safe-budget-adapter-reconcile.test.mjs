import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  POOL,
  adapter,
  createJournal,
  evidence,
  reopenJournal,
  signedAttempt,
} from "./safe-budget-adapter-test-fixture.mjs";

async function mutateSavedIntent(journal, mutate) {
  const directory = journal.directory;
  await journal.close();
  const path = join(directory, "journal.json");
  const state = JSON.parse(await readFile(path, "utf8"));
  mutate(state.intents[0]);
  await writeFile(path, JSON.stringify(state), { mode: 0o600 });
  return { directory, path, state };
}

test("revalidates reopened Safe metadata and unsigned digest before canonical lookup", async () => {
  for (const mutate of [
    (intent) => {
      intent.userOperation.entryPoint = POOL;
    },
    (intent) => {
      intent.unsignedDigest = `0x${"cd".repeat(32)}`;
    },
    (intent) => {
      intent.userOperation.userOperationHash = `0x${"cd".repeat(32)}`;
      intent.signed.hash = intent.userOperation.userOperationHash;
    },
  ]) {
    const journal = await createJournal();
    await signedAttempt(journal);
    const { directory } = await mutateSavedIntent(journal, mutate);
    const restarted = await reopenJournal(directory);
    let lookups = 0;
    await assert.rejects(
      adapter(restarted).reconcile("safe-reconcile", {
        lookup: async () => {
          lookups += 1;
          return { state: "pending" };
        },
      }),
    );
    assert.equal(lookups, 0);
    await restarted.close();
  }
});

test("accounts only the canonical inner failure cost once", async () => {
  const journal = await createJournal();
  const fence = await signedAttempt(journal);
  const lookup = async (identity) => evidence(identity, { state: "failed", actualGasCost: 7n });
  assert.deepEqual(await fence.reconcile("safe-reconcile", { lookup }), { state: "reverted" });
  assert.deepEqual(await fence.reconcile("safe-reconcile", { lookup }), { state: "reverted" });
  assert.equal(journal.intent("safe-reconcile").terminal.feeWei, "7");
  assert.equal(journal.snapshot().budget.feeActualWei, "7");
  await journal.close();
});

test("reconciles a restarted Safe journal without signing or sending again", async () => {
  const journal = await createJournal();
  await signedAttempt(journal, "safe-restart");
  const directory = journal.directory;
  await journal.close();
  const restarted = await reopenJournal(directory);
  let lookups = 0;
  const result = await adapter(restarted).reconcile("safe-restart", {
    lookup: async (identity) => {
      lookups += 1;
      return evidence(identity, { actualGasCost: 8n });
    },
  });
  assert.deepEqual(result, { state: "success" });
  assert.equal(lookups, 1);
  assert.equal(restarted.actualSendCount("safe-restart"), 1);
  assert.equal(restarted.snapshot().budget.feeActualWei, "8");
  await restarted.close();
});

test("leaves pending canonical evidence unresolved", async () => {
  const journal = await createJournal();
  const fence = await signedAttempt(journal, "safe-pending");
  assert.deepEqual(
    await fence.reconcile("safe-pending", { lookup: async () => ({ state: "pending" }) }),
    { state: "unresolved" },
  );
  assert.equal(journal.intent("safe-pending").terminal, null);
  assert.equal(journal.snapshot().budget.feeActualWei, "0");
  await journal.close();
});

test("revalidates reopened signed wire against call policy before canonical lookup", async () => {
  const journal = await createJournal();
  await signedAttempt(journal);
  const { directory } = await mutateSavedIntent(journal, (intent) => {
    const record = JSON.parse(Buffer.from(intent.signed.raw.slice(2), "hex").toString("utf8"));
    record.callData = "0x5678";
    intent.signed.raw = `0x${Buffer.from(JSON.stringify(record), "utf8").toString("hex")}`;
    intent.userOperation.wireDigest = `0x${createHash("sha256").update(intent.signed.raw).digest("hex")}`;
    intent.unsignedDigest = `0x${createHash("sha256")
      .update(JSON.stringify({ ...record, signature: "0x" }))
      .digest("hex")}`;
  });
  const restarted = await reopenJournal(directory);
  let lookups = 0;
  await assert.rejects(
    adapter(restarted).reconcile("safe-reconcile", {
      lookup: async () => {
        lookups += 1;
        return { state: "pending" };
      },
    }),
  );
  assert.equal(lookups, 0);
  await restarted.close();
});

test("rejects a reopened signed wire with a changed full nonce before lookup", async () => {
  const journal = await createJournal();
  await signedAttempt(journal);
  const { directory, state } = await mutateSavedIntent(journal, (intent) => {
    const record = JSON.parse(Buffer.from(intent.signed.raw.slice(2), "hex").toString("utf8"));
    record.nonce = "1";
    intent.signed.raw = `0x${Buffer.from(JSON.stringify(record), "utf8").toString("hex")}`;
  });
  await assert.rejects(reopenJournal(directory), /invalid persisted UserOperation signature/);
  assert.equal(state.intents[0].attempts.length, 1);
});

test("rejects a reopened signed wire with only its signature changed before lookup", async () => {
  const journal = await createJournal();
  await signedAttempt(journal);
  const { directory, state } = await mutateSavedIntent(journal, (intent) => {
    const record = JSON.parse(Buffer.from(intent.signed.raw.slice(2), "hex").toString("utf8"));
    record.signature = "0x5678";
    intent.signed.raw = `0x${Buffer.from(JSON.stringify(record), "utf8").toString("hex")}`;
  });
  await assert.rejects(reopenJournal(directory), /invalid persisted UserOperation signature/);
  assert.equal(state.intents[0].attempts.length, 1);
});

test("rejects reopened Safe terminals with missing or unknown canonical fields", async () => {
  for (const mutate of [
    (terminal) => {
      delete terminal.status;
    },
    (terminal) => {
      terminal.unexpected = true;
    },
    (terminal) => {
      delete terminal.outer.blockHash;
    },
    (terminal) => {
      terminal.outer.unexpected = true;
    },
  ]) {
    const journal = await createJournal();
    const fence = await signedAttempt(journal);
    await fence.reconcile("safe-reconcile", { lookup: async (identity) => evidence(identity) });
    const { directory, state } = await mutateSavedIntent(journal, (intent) =>
      mutate(intent.terminal),
    );
    await assert.rejects(reopenJournal(directory), /invalid persisted receipt/);
    assert.equal(state.intents[0].attempts.length, 1);
  }
});

test("retains the first canonical integrity error without charging a fee", async () => {
  const journal = await createJournal();
  const fence = await signedAttempt(journal);
  await assert.rejects(
    fence.reconcile("safe-reconcile", {
      lookup: async (identity) => evidence(identity, { nonce: 1n }),
    }),
    /evidence mismatch/,
  );
  await assert.rejects(
    fence.reconcile("safe-reconcile", {
      lookup: async (identity) => evidence({ ...identity, entryPoint: POOL }),
    }),
    /evidence mismatch/,
  );
  assert.match(journal.intent("safe-reconcile").firstError, /evidence mismatch/);
  assert.equal(journal.intent("safe-reconcile").terminal, null);
  assert.equal(journal.snapshot().budget.feeActualWei, "0");
  await journal.close();
});

test("retains a wrong canonical operation hash as the first failure without a fee", async () => {
  const journal = await createJournal();
  const fence = await signedAttempt(journal);
  await assert.rejects(
    fence.reconcile("safe-reconcile", {
      lookup: async (identity) =>
        evidence({ ...identity, userOperationHash: `0x${"cd".repeat(32)}` }),
    }),
    /evidence mismatch/,
  );
  await assert.rejects(
    fence.reconcile("safe-reconcile", {
      lookup: async (identity) => evidence(identity, { nonce: 1n }),
    }),
    /evidence mismatch/,
  );
  const intent = journal.intent("safe-reconcile");
  assert.match(intent.firstError, /evidence mismatch/);
  assert.equal(intent.terminal, null);
  assert.equal(journal.actualSendCount("safe-reconcile"), 1);
  assert.equal(journal.snapshot().budget.feeActualWei, "0");
  await journal.close();
});

test("requires canonical reconciliation for a formatted tampered stored outer link", async () => {
  const journal = await createJournal();
  const fence = await signedAttempt(journal);
  await fence.reconcile("safe-reconcile", { lookup: async (identity) => evidence(identity) });
  const { directory } = await mutateSavedIntent(journal, (intent) => {
    intent.terminal.outer.blockHash = `0x${"44".repeat(32)}`;
  });
  const restarted = await reopenJournal(directory);
  await assert.rejects(
    adapter(restarted).reconcile("safe-reconcile", {
      lookup: async (identity) => evidence(identity),
    }),
    /terminal receipt replacement refused/,
  );
  await restarted.close();
});

test("preserves changed canonical outer evidence and distinguishes malformed from unavailable evidence", async () => {
  const journal = await createJournal();
  const fence = await signedAttempt(journal);
  await fence.reconcile("safe-reconcile", { lookup: async (identity) => evidence(identity) });
  await assert.rejects(
    fence.reconcile("safe-reconcile", {
      lookup: async (identity) => evidence(identity, { blockHash: `0x${"44".repeat(32)}` }),
    }),
    /terminal receipt replacement refused/,
  );
  const intent = journal.intent("safe-reconcile");
  assert.match(intent.firstError, /terminal receipt replacement refused/);
  assert.equal(intent.terminal.outer.blockHash, `0x${"33".repeat(32)}`);
  assert.equal(journal.actualSendCount("safe-reconcile"), 1);
  assert.equal(journal.snapshot().budget.feeActualWei, "7");
  await journal.close();

  const malformedJournal = await createJournal();
  const malformedFence = await signedAttempt(malformedJournal);
  await assert.rejects(
    malformedFence.reconcile("safe-reconcile", {
      lookup: async (identity) => evidence(identity, { blockHash: "not-a-hash" }),
    }),
    /invalid outer evidence/,
  );
  assert.deepEqual(
    await malformedFence.reconcile("safe-reconcile", {
      lookup: async () => ({ state: "pending" }),
    }),
    { state: "unresolved" },
  );
  assert.equal(malformedJournal.intent("safe-reconcile").terminal, null);
  assert.equal(malformedJournal.actualSendCount("safe-reconcile"), 1);
  assert.equal(malformedJournal.snapshot().budget.feeActualWei, "0");
  await malformedJournal.close();
});
