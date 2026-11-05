/** Node-only canonical archive serialization. */
import { DatabaseSync } from "node:sqlite";
import { D1Archive, type BlockHeader } from "../src/archive.ts";
import { type ArchiveLog, validateNamespace, type Namespace } from "../src/domain.ts";
import {
  digest,
  json,
  namespaceFromRow,
  sameNamespace,
  SqliteD1,
  validateStoredCheckpoint,
  VERSION,
  type Retained,
} from "./retained-support.mts";

export function exportArchive(db: DatabaseSync, supplied: Namespace): Retained {
  const namespace = validateNamespace(supplied);
  db.exec("BEGIN");
  try {
    const storedNamespace = db
      .prepare("SELECT * FROM namespaces WHERE chain_id=? AND pool=?")
      .get(namespace.chainId, namespace.pool) as Record<string, unknown> | undefined;
    if (!storedNamespace || !sameNamespace(namespaceFromRow(storedNamespace), namespace))
      throw new Error("source namespace mismatch");
    const rows = db
      .prepare(
        "SELECT block_number,block_hash,parent_hash FROM canonical_blocks WHERE chain_id=? AND pool=? ORDER BY block_number",
      )
      .all(namespace.chainId, namespace.pool) as Record<string, unknown>[];
    if (rows.length < 2) throw new Error("incomplete archive");
    const checkpoint = validateStoredCheckpoint(db, namespace);
    const anchor = rows.find((row) => Number(row.block_number) === namespace.deploymentBlock - 1);
    const headers = rows
      .filter((row) => Number(row.block_number) >= namespace.deploymentBlock)
      .map((row) => ({
        number: Number(row.block_number),
        hash: String(row.block_hash),
        parentHash: String(row.parent_hash),
      })) as BlockHeader[];
    if (!anchor) throw new Error("missing deployment parent anchor");
    const headersByBlock = new Map(headers.map((header) => [header.number, header]));
    const logs = (
      db
        .prepare(
          "SELECT block_number,log_index,payload_json FROM event_logs WHERE chain_id=? AND pool=? ORDER BY block_number,log_index",
        )
        .all(namespace.chainId, namespace.pool) as Record<string, unknown>[]
    ).map((row) => {
      const header = headersByBlock.get(Number(row.block_number));
      if (!header) throw new Error("event without canonical header");
      const payload = JSON.parse(String(row.payload_json)) as Pick<ArchiveLog, "name" | "args">;
      return {
        blockNumber: Number(row.block_number),
        blockHash: header.hash,
        logIndex: Number(row.log_index),
        ...payload,
      };
    });
    const payload = {
      namespace,
      deploymentParentHash: String(anchor.block_hash),
      headers,
      logs,
      checkpoint,
    };
    const manifest = {
      version: VERSION,
      exportedAt: new Date().toISOString(),
      sha256: digest(json(payload)),
      namespace,
      headers: headers.length,
      logs: logs.length,
      firstBlock: headers[0].number,
      lastBlock: headers.at(-1)!.number,
      checkpoint,
    };
    db.exec("COMMIT");
    return { manifest, payload };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
