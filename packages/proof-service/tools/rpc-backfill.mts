/** Node 24-only, bounded, independently pinned RPC archive rebuild. Never bundled into the Worker. */
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  linkSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { D1Archive, type Checkpoint } from "../src/archive.ts";
import { type RpcSource, ingestOneSlice } from "../src/ingest.ts";
import { createRpc } from "../src/rpc.ts";
import { hash32, validateNamespace, type Namespace } from "../src/domain.ts";
import { SqliteD1, migrate } from "./replay-retained.mts";
import {
  Deadline,
  DeadlineRpc,
  FixedTargetRpc,
  requireCanonicalTarget,
  validateBackfillOptions,
} from "./backfill-guard.mts";

export type BackfillTarget = { chainId: string; number: number; hash: string };
export type BackfillOptions = {
  namespace: Namespace;
  target: BackfillTarget;
  output: string;
  source: RpcSource;
  maxBlocksPerSlice: number;
  maxSlices: number;
  deadlineMs: number;
};
export type BackfillResult = {
  checkpoint: Checkpoint;
  canonicalBlocks: number;
  eventLogs: number;
  sha256: string;
};

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const tempPath = (output: string) => `${output}.backfill-${process.pid}-${crypto.randomUUID()}.tmp`;
const publishAbsent = (temporary: string, output: string) => {
  // link(2) gives an atomic no-replace publish when output is in the same filesystem.
  linkSync(temporary, output);
  unlinkSync(temporary);
};
const count = (db: DatabaseSync, table: string, n: Namespace) =>
  Number(
    (
      db
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE chain_id=? AND pool=?`)
        .get(n.chainId, n.pool) as {
        count: number;
      }
    ).count,
  );

/** Builds a complete local archive only after a confirmed target and its hash have been independently pinned. */
export async function runRpcBackfill(options: BackfillOptions): Promise<BackfillResult> {
  const n = validateBackfillOptions(options);
  const deadline = new Deadline(options.deadlineMs);
  const source = new DeadlineRpc(options.source, deadline);
  const temporary = tempPath(options.output);
  let db: DatabaseSync | undefined;
  try {
    const initialized = await initializeBackfill(source, deadline, temporary, n, options);
    db = initialized.db;
    const archive = initialized.archive;
    const state = await advanceBackfill(archive, source, deadline, n, options);
    const result = {
      checkpoint: state,
      canonicalBlocks: count(db, "canonical_blocks", n),
      eventLogs: count(db, "event_logs", n),
      sha256: "",
    };
    deadline.check();
    db.close();
    db = undefined;
    deadline.check();
    publishAbsent(temporary, options.output);
    result.sha256 = sha256(options.output);
    return result;
  } catch (error) {
    db?.close();
    rmSync(temporary, { force: true });
    throw error;
  } finally {
    deadline.close();
  }
}
async function initializeBackfill(
  source: DeadlineRpc,
  deadline: Deadline,
  temporary: string,
  namespace: Namespace,
  options: BackfillOptions,
) {
  deadline.check();
  if ((await source.chainId(deadline.controller.signal)) !== namespace.chainId)
    throw new Error("rpc chain id mismatch");
  await requireCanonicalTarget(source, options.target, deadline.controller.signal);
  const parent = await source.block(namespace.deploymentBlock - 1, deadline.controller.signal);
  if (parent.number !== namespace.deploymentBlock - 1)
    throw new Error("deployment parent block mismatch");
  closeSync(openSync(temporary, "wx", 0o600));
  const db = migrate(temporary);
  const archive = new D1Archive(new SqliteD1(db));
  await archive.initialize(namespace, parent.hash);
  return { archive, db };
}
async function advanceBackfill(
  archive: D1Archive,
  source: DeadlineRpc,
  deadline: Deadline,
  namespace: Namespace,
  options: BackfillOptions,
) {
  const fixed = new FixedTargetRpc(source, options.target, deadline);
  let state = await archive.status(namespace);
  for (let slice = 0; state.lastFinalizedBlock < options.target.number; slice += 1) {
    if (slice >= options.maxSlices) throw new Error("backfill work limit exceeded");
    deadline.check();
    const before = state.nextBlock;
    state = await ingestOneSlice(
      archive,
      namespace,
      fixed,
      options.maxBlocksPerSlice,
      deadline.controller.signal,
    );
    if (state.disabledReason) throw new Error(`backfill archive disabled: ${state.disabledReason}`);
    if (state.nextBlock <= before) throw new Error("backfill made no progress");
    if (state.lastFinalizedBlock > options.target.number)
      throw new Error("backfill exceeded fixed target");
  }
  await requireCanonicalTarget(source, options.target, deadline.controller.signal);
  if (
    state.lastFinalizedBlock !== options.target.number ||
    hash32(state.lastFinalizedHash) !== hash32(options.target.hash)
  )
    throw new Error("backfill checkpoint does not match fixed target");
  return state;
}

function positive(value: string | undefined, name: string) {
  if (!value || !/^\d+$/.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value)))
    throw new Error(`invalid ${name}`);
  return Number(value);
}

if (import.meta.main) {
  const [
    namespacePath,
    targetPath,
    output,
    confirmationsFlag,
    confirmationsValue,
    deadlineFlag,
    deadlineValue,
    slicesFlag,
    slicesValue,
  ] = process.argv.slice(2);
  if (
    !namespacePath ||
    !targetPath ||
    !output ||
    confirmationsFlag !== "--confirmations" ||
    deadlineFlag !== "--deadline-ms" ||
    slicesFlag !== "--max-slices"
  )
    throw new Error(
      "usage: rpc-backfill.mts namespace.json fixed-target.json new.sqlite --confirmations N --deadline-ms N --max-slices N",
    );
  if (existsSync(output)) throw new Error("backfill output already exists");
  const namespace = validateNamespace(JSON.parse(readFileSync(namespacePath, "utf8")));
  const target = JSON.parse(readFileSync(targetPath, "utf8")) as BackfillTarget;
  const confirmations = positive(confirmationsValue, "confirmations");
  const primary = process.env.PRIMARY_RPC_URL;
  const historical = process.env.HISTORICAL_RPC_URL;
  if (!primary || !historical)
    throw new Error("PRIMARY_RPC_URL and HISTORICAL_RPC_URL are required");
  const rpc = createRpc(primary, historical, namespace, confirmations);
  const result = await rpc.withSource((source) =>
    runRpcBackfill({
      namespace,
      target,
      output,
      source,
      maxBlocksPerSlice: 2,
      deadlineMs: positive(deadlineValue, "deadline"),
      maxSlices: positive(slicesValue, "max slices"),
    }),
  );
  console.log(
    JSON.stringify({
      namespace: {
        chainId: namespace.chainId,
        pool: namespace.pool,
        deploymentBlock: namespace.deploymentBlock,
      },
      target,
      checkpoint: result.checkpoint,
      canonicalBlocks: result.canonicalBlocks,
      eventLogs: result.eventLogs,
      sha256: result.sha256,
    }),
  );
}
