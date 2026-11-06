import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { D1Archive } from "../src/archive.ts";
import { branchHash, leafHash, type ArchiveLog } from "../src/domain.ts";
import { account, depth32Fixture, otherAccount, zero } from "../tests/fixtures.ts";
import { SqliteD1 } from "./replay-retained.mts";

const migrations = new URL("../migrations/", import.meta.url);
const hex = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

function rejoinLogs(fixture: ReturnType<typeof depth32Fixture>): ArchiveLog[] {
  const second = { number: 2, hash: hex(2), parentHash: fixture.block.hash };
  const logs: ArchiveLog[] = [
    {
      blockNumber: 2,
      blockHash: second.hash,
      logIndex: 0,
      name: "SlotReleased",
      args: { account, index: "0", generation: "1" },
    },
    {
      blockNumber: 2,
      blockHash: second.hash,
      logIndex: 1,
      name: "SlotAssigned",
      args: { account: otherAccount, index: "0", generation: "2" },
    },
    {
      blockNumber: 2,
      blockHash: second.hash,
      logIndex: 2,
      name: "SlotAssigned",
      args: { account, index: "1", generation: "1" },
    },
  ];
  appendRejoinedNodes(logs, fixture, second.hash);
  return logs;
}

function appendRejoinedNodes(
  logs: ArchiveLog[],
  fixture: ReturnType<typeof depth32Fixture>,
  blockHash: string,
) {
  let left = { hash: leafHash(otherAccount, "2", zero), sum: zero };
  let right = { hash: leafHash(account, "1", zero), sum: zero };
  logs.push(nodeUpdate(3, 0, 0, left.hash, blockHash), nodeUpdate(4, 0, 1, right.hash, blockHash));
  let parent = { hash: branchHash(left, right), sum: zero };
  logs.push(nodeUpdate(5, 1, 0, parent.hash, blockHash));
  for (let level = 1; level < 32; level += 1) {
    parent = {
      hash: branchHash(parent, { hash: fixture.namespace.emptyHashes[level], sum: zero }),
      sum: zero,
    };
    logs.push(nodeUpdate(level + 5, level + 1, 0, parent.hash, blockHash));
  }
  logs.push({
    blockNumber: 2,
    blockHash,
    logIndex: 37,
    name: "DrawSnapshotClosed",
    args: {
      drawId: "2",
      rootHash: parent.hash,
      rootSum: zero,
      ticket: zero,
      upperBound: "2",
      closeBlockNumber: "2",
    },
  });
}

function nodeUpdate(
  logIndex: number,
  level: number,
  index: number,
  hash: string,
  blockHash: string,
): ArchiveLog {
  return {
    blockNumber: 2,
    blockHash,
    logIndex,
    name: "NodeUpdated",
    args: { level: String(level), index: String(index), hash, sum: zero },
  };
}

export async function sourceArchive(path: string) {
  const fixture = depth32Fixture();
  const db = new DatabaseSync(path);
  for (const name of ["0001_proof_archive.sql", "0002_checkpoint_state.sql"])
    db.exec(readFileSync(new URL(name, migrations), "utf8"));
  const archive = new D1Archive(new SqliteD1(db));
  await archive.initialize(fixture.namespace, zero);
  await archive.ingest(fixture.namespace, await archive.status(fixture.namespace), fixture.logs, [
    fixture.block,
  ]);
  const second = { number: 2, hash: hex(2), parentHash: fixture.block.hash };
  await archive.ingest(
    fixture.namespace,
    await archive.status(fixture.namespace),
    rejoinLogs(fixture),
    [second],
  );
  return { db, archive, fixture };
}

export const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
