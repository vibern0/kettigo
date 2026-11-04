import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const chainId = "11155111";
const pool = "0x00000000000000000000000000000000000000a1";
const zero = `0x${"00".repeat(32)}`;
const root = `0x${"11".repeat(32)}`;
const block = `0x${"22".repeat(32)}`;
function payload() {
  return {
    namespace: { chainId, pool, depth: 1, zero, emptyHashes: [zero, root], deploymentBlock: 1 },
    headers: [{ number: 1, hash: block, parentHash: zero }],
    logs: [
      {
        blockNumber: 1,
        blockHash: block,
        logIndex: 0,
        name: "SlotAssigned",
        args: { account: pool, index: "0", generation: "1" },
      },
      {
        blockNumber: 1,
        blockHash: block,
        logIndex: 1,
        name: "NodeUpdated",
        args: { level: "1", index: "0", hash: root, sum: zero },
      },
      {
        blockNumber: 1,
        blockHash: block,
        logIndex: 2,
        name: "DrawSnapshotClosed",
        args: {
          drawId: "1",
          rootHash: root,
          rootSum: zero,
          ticket: zero,
          upperBound: "1",
          closeBlockNumber: "1",
        },
      },
    ],
  };
}
function run(dir, input = payload()) {
  const raw = join(dir, "payload.json"),
    exported = join(dir, "export.json"),
    restored = join(dir, "restore.sqlite");
  writeFileSync(raw, JSON.stringify(input));
  execFileSync(process.execPath, ["tools/retained-export.mjs", raw, exported], {
    cwd: process.cwd(),
  });
  execFileSync(process.execPath, ["tools/retained-sqlite.mjs", exported, restored, chainId, pool], {
    cwd: process.cwd(),
  });
  return { exported, restored };
}
test("Node 24 adapter restores retained canonical logs by replaying them", () => {
  const files = run(mkdtempSync(join(tmpdir(), "kettigo-proof-")));
  const db = new DatabaseSync(files.restored);
  assert.equal(db.prepare("SELECT count(*) AS n FROM event_logs").get().n, 3);
  assert.equal(db.prepare("SELECT count(*) AS n FROM draws").get().n, 1);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  db.close();
});
test("Node 24 adapter rejects tampered export and a foreign namespace", () => {
  const dir = mkdtempSync(join(tmpdir(), "kettigo-proof-"));
  const files = run(dir);
  const tampered = JSON.parse(readFileSync(files.exported, "utf8"));
  tampered.payload.logs[0].args.generation = "2";
  writeFileSync(files.exported, JSON.stringify(tampered));
  assert.throws(() =>
    execFileSync(
      process.execPath,
      ["tools/retained-sqlite.mjs", files.exported, join(dir, "bad.sqlite"), chainId, pool],
      { cwd: process.cwd(), stdio: "pipe" },
    ),
  );
});
