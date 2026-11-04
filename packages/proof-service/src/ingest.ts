import { type ArchiveLog, type Namespace, hash32, type Node } from "./domain.ts";
import { D1Archive, type BlockHeader } from "./archive.ts";
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
  // Check stored history even when there is no new finalized work. Otherwise a
  // reorg that leaves nextBlock beyond head is never discovered.
  const newest = Math.min(state.lastFinalizedBlock, head.number);
  let ancestor = n.deploymentBlock - 1;
  let found = state.lastFinalizedBlock < n.deploymentBlock;
  const floor = Math.max(n.deploymentBlock, newest - 127);
  for (let b = newest; b >= floor; b -= 1) {
    const saved = await archive.canonicalBlock(n, b);
    if (!saved) {
      throwIfAborted(signal);
      return archive.disable(n, state, "canonical checkpoint unavailable");
    }
    const canonical = await rpcCall(signal, () => rpc.block(b, signal));
    if (canonical.number !== b) {
      throwIfAborted(signal);
      return archive.disable(n, state, "rpc block number mismatch");
    }
    if (hash32(saved.hash) === hash32(canonical.hash)) {
      ancestor = b;
      found = true;
      break;
    }
  }
  if (!found) {
    throwIfAborted(signal);
    return archive.disable(n, state, "deep or unknown canonical fork");
  }
  if (ancestor < state.lastFinalizedBlock) {
    throwIfAborted(signal);
    return archive.rollbackFrom(n, state, ancestor + 1);
  }
  if (state.nextBlock > head.number) return state;
  if (!Number.isSafeInteger(head.number) || head.number < 0)
    throw new Error("invalid finalized head");
  const to = Math.min(head.number, state.nextBlock + maxBlocks - 1);
  if (!Number.isSafeInteger(to)) throw new Error("invalid bounded range");
  const headers: BlockHeader[] = [];
  for (let block = state.nextBlock; block <= to; block += 1)
    headers.push(await rpcCall(signal, () => rpc.block(block, signal)));
  if (headers[0].parentHash !== state.lastFinalizedHash) {
    throwIfAborted(signal);
    return archive.disable(n, state, "canonical parent mismatch");
  }
  const logs = await rpcCall(signal, () => rpc.logs(state.nextBlock, to, signal));
  const unique = new Map<string, ArchiveLog>();
  for (const log of logs) {
    const key = `${log.blockNumber}:${log.logIndex}`;
    const prior = unique.get(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(log))
      throw new Error("conflicting RPC log payload");
    unique.set(key, log);
  }
  const ordered = [...unique.values()].sort(
    (a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex,
  );
  for (let b = state.nextBlock; b <= to; b++) {
    const a = ordered.filter((x) => x.blockNumber === b),
      receipt = await rpcCall(signal, () => rpc.receiptLogs(headers[b - state.nextBlock], signal));
    const receiptUnique = new Map<string, ArchiveLog>();
    for (const log of receipt) {
      const key = `${log.blockNumber}:${log.logIndex}`;
      const prior = receiptUnique.get(key);
      if (prior && JSON.stringify(prior) !== JSON.stringify(log))
        throw new Error("conflicting receipt log payload");
      receiptUnique.set(key, log);
    }
    const canonicalReceipt = [...receiptUnique.values()].sort((x, y) => x.logIndex - y.logIndex);
    if (JSON.stringify(a) !== JSON.stringify(canonicalReceipt))
      throw new Error("incomplete pool logs");
  }
  for (const log of ordered) {
    const header = headers[log.blockNumber - state.nextBlock];
    if (!header || hash32(log.blockHash) !== hash32(header.hash))
      throw new Error("log canonical hash mismatch");
  }
  for (const log of ordered) {
    if (log.name !== "DrawSnapshotClosed") continue;
    const snapshot = await rpcCall(signal, () =>
      rpc.drawSnapshot(log.args.drawId, headers[log.blockNumber - state.nextBlock], signal),
    );
    if (
      hash32(snapshot.rootHash) !== hash32(log.args.rootHash) ||
      hash32(snapshot.rootSum) !== hash32(log.args.rootSum) ||
      snapshot.closeBlock !== Number(log.args.closeBlockNumber)
    )
      throw new Error("onchain draw snapshot mismatch");
  }
  const priorRoot = await archive.membershipRoot(n, state.nextBlock - 1);
  let reconstructed: Node = priorRoot ?? { hash: n.emptyHashes[n.depth], sum: n.zero };
  for (const log of ordered)
    if (log.name === "NodeUpdated" && log.args.level === String(n.depth) && log.args.index === "0")
      reconstructed = { hash: hash32(log.args.hash), sum: hash32(log.args.sum) };
  const onchainRoot = await rpcCall(signal, () => rpc.membershipRoot(headers.at(-1)!, signal));
  if (reconstructed.hash !== onchainRoot.hash || reconstructed.sum !== onchainRoot.sum)
    throw new Error("onchain membership root mismatch");
  try {
    // D1 batches are atomic but cannot be cancelled; once this starts we await its settlement.
    throwIfAborted(signal);
    return await archive.ingest(n, state, ordered, headers);
  } catch (e) {
    if (e instanceof CheckpointConflict) return archive.status(n);
    throw e;
  }
}
