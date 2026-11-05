/** Deadline-bound RPC access and fixed-target admission for Node backfills. */
import { existsSync } from "node:fs";
import { hash32, validateNamespace, type Namespace } from "../src/domain.ts";
import { type RpcSource, throwIfAborted } from "../src/ingest.ts";
import type { BackfillOptions, BackfillTarget } from "./rpc-backfill.mts";

export class Deadline {
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
export class DeadlineRpc implements RpcSource {
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
export class FixedTargetRpc extends DeadlineRpc {
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
export function validateBackfillOptions(options: BackfillOptions): Namespace {
  const namespace = validateNamespace(options.namespace);
  if (namespace.deploymentBlock === 0) throw new Error("deployment block zero is unsupported");
  validateTarget(options, namespace);
  validateLimits(options);
  if (existsSync(options.output)) throw new Error("backfill output already exists");
  return namespace;
}
function validateTarget(options: BackfillOptions, namespace: Namespace) {
  if (namespace.chainId !== "11155111" || options.target.chainId !== namespace.chainId)
    throw new Error("backfill requires Ethereum Sepolia namespace and target");
  if (
    !Number.isSafeInteger(options.target.number) ||
    options.target.number < namespace.deploymentBlock
  )
    throw new Error("invalid fixed target block");
  hash32(options.target.hash, "fixed target hash");
}
function validateLimits(options: BackfillOptions) {
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
}
export async function requireCanonicalTarget(
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
