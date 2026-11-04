#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const [inputPath, outputPath, expectedChainId, expectedPool] = process.argv.slice(2);
if (!inputPath || !outputPath || !expectedChainId || !expectedPool)
  throw new Error("usage: retained-sqlite.mjs export.json restore.sqlite chainId pool");
const exported = JSON.parse(readFileSync(inputPath, "utf8"));
const { manifest, payload } = exported;
if (!manifest || !payload || manifest.version !== 1) throw new Error("invalid retained export");
const body = JSON.stringify(payload);
const digest = createHash("sha256").update(body).digest("hex");
if (manifest.sha256 !== digest) throw new Error("retained export digest mismatch");
if (
  payload.namespace?.chainId !== expectedChainId ||
  payload.namespace?.pool !== expectedPool ||
  manifest.namespace?.chainId !== expectedChainId ||
  manifest.namespace?.pool !== expectedPool
)
  throw new Error("retained export namespace mismatch");
if (!Array.isArray(payload.headers) || !Array.isArray(payload.logs))
  throw new Error("invalid retained export rows");
if (manifest.headers !== payload.headers.length || manifest.logs !== payload.logs.length)
  throw new Error("retained export row count mismatch");

const db = new DatabaseSync(outputPath);
db.exec(`
  PRAGMA foreign_keys=ON;
  CREATE TABLE namespace(chain_id TEXT NOT NULL, pool TEXT NOT NULL, depth INTEGER NOT NULL, zero_handle TEXT NOT NULL, empty_hashes_json TEXT NOT NULL, deployment_block INTEGER NOT NULL);
  CREATE TABLE canonical_blocks(block_number INTEGER PRIMARY KEY, block_hash TEXT NOT NULL, parent_hash TEXT NOT NULL);
  CREATE TABLE event_logs(block_number INTEGER NOT NULL, log_index INTEGER NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(block_number, log_index));
  CREATE TABLE node_versions(level INTEGER NOT NULL,node_index TEXT NOT NULL,block_number INTEGER NOT NULL,log_index INTEGER NOT NULL,hash TEXT NOT NULL,sum_handle TEXT NOT NULL,PRIMARY KEY(block_number,log_index));
  CREATE TABLE slot_versions(account TEXT NOT NULL,slot_index TEXT NOT NULL,generation TEXT NOT NULL,assigned INTEGER NOT NULL,block_number INTEGER NOT NULL,log_index INTEGER NOT NULL,PRIMARY KEY(block_number,log_index));
  CREATE TABLE draws(draw_id TEXT PRIMARY KEY,root_hash TEXT NOT NULL,root_sum TEXT NOT NULL,ticket_handle TEXT NOT NULL,upper_bound_handle TEXT NOT NULL,close_block_number INTEGER NOT NULL,close_log_index INTEGER NOT NULL);
`);
const n = payload.namespace;
db.prepare("INSERT INTO namespace VALUES(?,?,?,?,?,?)").run(
  n.chainId,
  n.pool,
  n.depth,
  n.zero,
  JSON.stringify(n.emptyHashes),
  n.deploymentBlock,
);
const block = db.prepare("INSERT INTO canonical_blocks VALUES(?,?,?)");
for (const header of payload.headers) block.run(header.number, header.hash, header.parentHash);
const logRow = db.prepare("INSERT INTO event_logs VALUES(?,?,?)");
const node = db.prepare("INSERT INTO node_versions VALUES(?,?,?,?,?,?)");
const slot = db.prepare("INSERT INTO slot_versions VALUES(?,?,?,?,?,?)");
const draw = db.prepare("INSERT INTO draws VALUES(?,?,?,?,?,?,?)");
for (const entry of [...payload.logs].sort(
  (a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex,
)) {
  if (
    !payload.headers.some(
      (header) => header.number === entry.blockNumber && header.hash === entry.blockHash,
    )
  )
    throw new Error("retained log canonical block mismatch");
  logRow.run(
    entry.blockNumber,
    entry.logIndex,
    JSON.stringify({ name: entry.name, args: entry.args }),
  );
  if (entry.name === "NodeUpdated")
    node.run(
      entry.args.level,
      entry.args.index,
      entry.blockNumber,
      entry.logIndex,
      entry.args.hash,
      entry.args.sum,
    );
  else if (entry.name === "SlotAssigned" || entry.name === "SlotReleased")
    slot.run(
      entry.args.account,
      entry.args.index,
      entry.args.generation,
      entry.name === "SlotAssigned" ? 1 : 0,
      entry.blockNumber,
      entry.logIndex,
    );
  else if (entry.name === "DrawSnapshotClosed")
    draw.run(
      entry.args.drawId,
      entry.args.rootHash,
      entry.args.rootSum,
      entry.args.ticket,
      entry.args.upperBound,
      entry.args.closeBlockNumber,
      entry.logIndex,
    );
}
const integrity = db.prepare("PRAGMA integrity_check").get();
if (!integrity || integrity.integrity_check !== "ok")
  throw new Error("SQLite integrity check failed");
db.close();
