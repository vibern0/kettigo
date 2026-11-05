import { type ArchiveLog, type Namespace, hash32, type Node } from "./domain.ts";
import { D1Archive, type BlockHeader, type Checkpoint } from "./archive.ts";
import { CheckpointConflict } from "./domain.ts";
export interface RpcSource {
  chainId(signal?: AbortSignal): Promise<string>;
  finalizedHead(signal?: AbortSignal): Promise<{ number: number; hash: string }>;
  latestHead(signal?: AbortSignal): Promise<BlockHeader>;
  block(
    number: number,
    signal?: AbortSignal,
  ): Promise<{ number: number; hash: string; parentHash: string }>;
  logs(from: number, to: number, signal?: AbortSignal): Promise<ArchiveLog[]>;
  receiptLogs(block: BlockHeader, signal?: AbortSignal): Promise<ArchiveLog[]>;
  drawSnapshot(
    drawId: string,
    block: BlockHeader,
    signal?: AbortSignal,
  ): Promise<{
    rootHash: string;
    rootSum: string;
    ticket: string;
    upperBound: string;
    closeBlock: number;
  }>;
  membershipRoot(block: BlockHeader, signal?: AbortSignal): Promise<Node>;
}
export const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted)
    throw signal.reason instanceof Error ? signal.reason : new Error("operation aborted");
};
const rpcCall = async <T>(signal: AbortSignal | undefined, operation: () => Promise<T>) => {
  throwIfAborted(signal);
  const value = await operation();
  throwIfAborted(signal);
  return value;
};
const uniqueLogs = (logs: readonly ArchiveLog[], conflict: string) => {
  const unique = new Map<string, ArchiveLog>();
  for (const log of logs) {
    const key = `${log.blockNumber}:${log.logIndex}`;
    const prior = unique.get(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(log)) throw new Error(conflict);
    unique.set(key, log);
  }
  return [...unique.values()].sort(
    (a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex,
  );
};
type Recovery = { ancestor: number } | { reason: string };
async function commonAncestor(
  archive: D1Archive,
  n: Namespace,
  rpc: RpcSource,
  state: Checkpoint,
  head: { number: number },
  signal?: AbortSignal,
): Promise<Recovery> {
  const newest = Math.min(state.lastFinalizedBlock, head.number);
  const floor = Math.max(n.deploymentBlock, newest - 127);
  for (let block = newest; block >= floor; block -= 1) {
    const saved = await archive.canonicalBlock(n, block);
    if (!saved) return { reason: "canonical checkpoint unavailable" };
    const canonical = await rpcCall(signal, () => rpc.block(block, signal));
    if (canonical.number !== block) return { reason: "rpc block number mismatch" };
    if (hash32(saved.hash) === hash32(canonical.hash)) return { ancestor: block };
  }
  return state.lastFinalizedBlock < n.deploymentBlock
    ? { ancestor: n.deploymentBlock - 1 }
    : { reason: "deep or unknown canonical fork" };
}
async function headersForSlice(rpc: RpcSource, from: number, to: number, signal?: AbortSignal) {
  const headers: BlockHeader[] = [];
  for (let block = from; block <= to; block += 1)
    headers.push(await rpcCall(signal, () => rpc.block(block, signal)));
  return headers;
}
async function verifiedLogs(
  rpc: RpcSource,
  headers: readonly BlockHeader[],
  from: number,
  to: number,
  signal?: AbortSignal,
) {
  const ordered = uniqueLogs(
    await rpcCall(signal, () => rpc.logs(from, to, signal)),
    "conflicting RPC log payload",
  );
  for (let block = from; block <= to; block += 1) {
    const indexed = ordered.filter((log) => log.blockNumber === block);
    const receipt = uniqueLogs(
      await rpcCall(signal, () => rpc.receiptLogs(headers[block - from], signal)),
      "conflicting receipt log payload",
    ).sort((a, b) => a.logIndex - b.logIndex);
    if (JSON.stringify(indexed) !== JSON.stringify(receipt))
      throw new Error("incomplete pool logs");
  }
  for (const log of ordered) {
    const header = headers[log.blockNumber - from];
    if (!header || hash32(log.blockHash) !== hash32(header.hash))
      throw new Error("log canonical hash mismatch");
  }
  return ordered;
}
async function verifySnapshots(
  rpc: RpcSource,
  headers: readonly BlockHeader[],
  logs: readonly ArchiveLog[],
  from: number,
  signal?: AbortSignal,
) {
  for (const log of logs) {
    if (log.name !== "DrawSnapshotClosed") continue;
    const snapshot = await rpcCall(signal, () =>
      rpc.drawSnapshot(log.args.drawId, headers[log.blockNumber - from], signal),
    );
    if (
      hash32(snapshot.rootHash) !== hash32(log.args.rootHash) ||
      hash32(snapshot.rootSum) !== hash32(log.args.rootSum) ||
      snapshot.closeBlock !== Number(log.args.closeBlockNumber)
    )
      throw new Error("onchain draw snapshot mismatch");
  }
}
async function verifyMembershipRoot(
  archive: D1Archive,
  n: Namespace,
  rpc: RpcSource,
  headers: readonly BlockHeader[],
  logs: readonly ArchiveLog[],
  from: number,
  signal?: AbortSignal,
) {
  const priorRoot = await archive.membershipRoot(n, from - 1);
  let reconstructed: Node = priorRoot ?? { hash: n.emptyHashes[n.depth], sum: n.zero };
  for (const log of logs)
    if (log.name === "NodeUpdated" && log.args.level === String(n.depth) && log.args.index === "0")
      reconstructed = { hash: hash32(log.args.hash), sum: hash32(log.args.sum) };
  const onchainRoot = await rpcCall(signal, () => rpc.membershipRoot(headers.at(-1)!, signal));
  if (reconstructed.hash !== onchainRoot.hash || reconstructed.sum !== onchainRoot.sum)
    throw new Error("onchain membership root mismatch");
}
/** One bounded, finalized slice. Receipt comparison prevents an omitted ownership log from becoming a false negative. */
export async function ingestOneSlice(
  archive: D1Archive,
  n: Namespace,
  rpc: RpcSource,
  maxBlocks: number,
  signal?: AbortSignal,
) {
  if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > 2)
    throw new Error("invalid max blocks");
  const state = await archive.status(n);
  throwIfAborted(signal);
  if (state.disabledReason) return state;
  if ((await rpcCall(signal, () => rpc.chainId(signal))) !== n.chainId) {
    throwIfAborted(signal);
    return archive.disable(n, state, "rpc chain id mismatch");
  }
  const head = await rpcCall(signal, () => rpc.finalizedHead(signal));
  if (state.lastFinalizedBlock >= n.deploymentBlock && head.number < state.lastFinalizedBlock)
    throw new Error("finalized head behind retained checkpoint");
  // Check stored history even when there is no new finalized work. Otherwise a
  // reorg that leaves nextBlock beyond head is never discovered.
  const recovery = await commonAncestor(archive, n, rpc, state, head, signal);
  if ("reason" in recovery) {
    throwIfAborted(signal);
    return archive.disable(n, state, recovery.reason);
  }
  const { ancestor } = recovery;
  if (ancestor < state.lastFinalizedBlock) {
    throwIfAborted(signal);
    return archive.rollbackFrom(n, state, ancestor + 1);
  }
  if (state.nextBlock > head.number) return state;
  if (!Number.isSafeInteger(head.number) || head.number < 0)
    throw new Error("invalid finalized head");
  const to = Math.min(head.number, state.nextBlock + maxBlocks - 1);
  if (!Number.isSafeInteger(to)) throw new Error("invalid bounded range");
  const headers = await headersForSlice(rpc, state.nextBlock, to, signal);
  if (headers[0].parentHash !== state.lastFinalizedHash) {
    throwIfAborted(signal);
    return archive.disable(n, state, "canonical parent mismatch");
  }
  const ordered = await verifiedLogs(rpc, headers, state.nextBlock, to, signal);
  await verifySnapshots(rpc, headers, ordered, state.nextBlock, signal);
  await verifyMembershipRoot(archive, n, rpc, headers, ordered, state.nextBlock, signal);
  try {
    // D1 batches are atomic but cannot be cancelled; once this starts we await its settlement.
    throwIfAborted(signal);
    return await archive.ingest(n, state, ordered, headers);
  } catch (e) {
    if (e instanceof CheckpointConflict) return archive.status(n);
    throw e;
  }
}
