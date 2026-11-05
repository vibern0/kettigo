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
import { type RpcSource, ingestOneSlice, throwIfAborted } from "../src/ingest.ts";
import { createRpc } from "../src/rpc.ts";
import { hash32, validateNamespace, type Namespace } from "../src/domain.ts";
import { SqliteD1, migrate } from "./replay-retained.mts";

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
class Deadline {
  readonly controller = new AbortController();
  readonly expiresAt: number;
  readonly timer: ReturnType<typeof setTimeout>;
  constructor(deadlineMs: number) {
    this.expiresAt = Date.now() + deadlineMs;
    this.timer = setTimeout(
      () => this.controller.abort(new Error("backfill deadline exceeded")),
      deadlineMs,
    );
  }
  check() {
    if (Date.now() >= this.expiresAt && !this.controller.signal.aborted)
      this.controller.abort(new Error("backfill deadline exceeded"));
    throwIfAborted(this.controller.signal);
  }
  async wait<T>(operation: () => Promise<T>) {
    this.check();
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(this.controller.signal.reason);
      this.controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const value = await Promise.race([Promise.resolve().then(operation), aborted]);
      this.check();
      return value;
    } finally {
      if (onAbort) this.controller.signal.removeEventListener("abort", onAbort);
    }
  }
  close() {
    clearTimeout(this.timer);
  }
}
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

class DeadlineRpc implements RpcSource {
  constructor(
    readonly source: RpcSource,
    readonly deadline: Deadline,
  ) {}
  chainId(signal?: AbortSignal) {
    return this.deadline.wait(() => this.source.chainId(signal));
  }
  finalizedHead(signal?: AbortSignal) {
    return this.deadline.wait(() => this.source.finalizedHead(signal));
  }
  latestHead(signal?: AbortSignal) {
    return this.deadline.wait(() => this.source.latestHead(signal));
  }
  block(number: number, signal?: AbortSignal) {
    return this.deadline.wait(() => this.source.block(number, signal));
  }
  logs(from: number, to: number, signal?: AbortSignal) {
    return this.deadline.wait(() => this.source.logs(from, to, signal));
  }
  receiptLogs(block: Parameters<RpcSource["receiptLogs"]>[0], signal?: AbortSignal) {
    return this.deadline.wait(() => this.source.receiptLogs(block, signal));
  }
  drawSnapshot(...args: Parameters<RpcSource["drawSnapshot"]>) {
    return this.deadline.wait(() => this.source.drawSnapshot(...args));
  }
  membershipRoot(...args: Parameters<RpcSource["membershipRoot"]>) {
    return this.deadline.wait(() => this.source.membershipRoot(...args));
  }
}
class FixedTargetRpc extends DeadlineRpc {
  constructor(
    source: RpcSource,
    readonly target: BackfillTarget,
    deadline: Deadline,
  ) {
    super(source, deadline);
  }
  finalizedHead(_signal?: AbortSignal) {
    this.deadline.check();
    return Promise.resolve({ number: this.target.number, hash: this.target.hash });
  }
}

function validate(options: BackfillOptions) {
  const n = validateNamespace(options.namespace);
  if (n.deploymentBlock === 0) throw new Error("deployment block zero is unsupported");
  if (n.chainId !== "11155111" || options.target.chainId !== n.chainId)
    throw new Error("backfill requires Ethereum Sepolia namespace and target");
  if (!Number.isSafeInteger(options.target.number) || options.target.number < n.deploymentBlock)
    throw new Error("invalid fixed target block");
  hash32(options.target.hash, "fixed target hash");
  if (
    !Number.isSafeInteger(options.maxBlocksPerSlice) ||
    options.maxBlocksPerSlice < 1 ||
    options.maxBlocksPerSlice > 2
  )
    throw new Error("invalid max blocks per slice");
  if (!Number.isSafeInteger(options.maxSlices) || options.maxSlices < 1)
    throw new Error("invalid max slices");
  if (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs < 1)
    throw new Error("invalid deadline");
  if (existsSync(options.output)) throw new Error("backfill output already exists");
  return n;
}

async function requireCanonicalTarget(
  source: RpcSource,
  target: BackfillTarget,
  signal: AbortSignal,
) {
  const head = await source.finalizedHead(signal);
  if (head.number < target.number) throw new Error("fixed target is not confirmed by source");
  const actual = await source.block(target.number, signal);
  if (actual.number !== target.number || hash32(actual.hash) !== hash32(target.hash))
    throw new Error("fixed target canonicality changed");
}

/** Builds a complete local archive only after a confirmed target and its hash have been independently pinned. */
export async function runRpcBackfill(options: BackfillOptions): Promise<BackfillResult> {
  const n = validate(options);
  const deadline = new Deadline(options.deadlineMs);
  const source = new DeadlineRpc(options.source, deadline);
  const temporary = tempPath(options.output);
  let db: DatabaseSync | undefined;
  try {
    deadline.check();
    if ((await source.chainId(deadline.controller.signal)) !== n.chainId)
      throw new Error("rpc chain id mismatch");
    await requireCanonicalTarget(source, options.target, deadline.controller.signal);
    const parent = await source.block(n.deploymentBlock - 1, deadline.controller.signal);
    if (parent.number !== n.deploymentBlock - 1)
      throw new Error("deployment parent block mismatch");
    closeSync(openSync(temporary, "wx", 0o600));
    db = migrate(temporary);
    const archive = new D1Archive(new SqliteD1(db));
    await archive.initialize(n, parent.hash);
    const fixed = new FixedTargetRpc(source, options.target, deadline);
    let state = await archive.status(n);
    for (let slice = 0; state.lastFinalizedBlock < options.target.number; slice += 1) {
      if (slice >= options.maxSlices) throw new Error("backfill work limit exceeded");
      deadline.check();
      const before = state.nextBlock;
      state = await ingestOneSlice(
        archive,
        n,
        fixed,
        options.maxBlocksPerSlice,
        deadline.controller.signal,
      );
      if (state.disabledReason)
        throw new Error(`backfill archive disabled: ${state.disabledReason}`);
      if (state.nextBlock <= before) throw new Error("backfill made no progress");
      if (state.lastFinalizedBlock > options.target.number)
        throw new Error("backfill exceeded fixed target");
    }
    // Query the pinned source again before examining/publishing the locally built checkpoint.
    await requireCanonicalTarget(source, options.target, deadline.controller.signal);
    if (
      state.lastFinalizedBlock !== options.target.number ||
      hash32(state.lastFinalizedHash) !== hash32(options.target.hash)
    )
      throw new Error("backfill checkpoint does not match fixed target");
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
