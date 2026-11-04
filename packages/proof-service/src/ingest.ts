import { type ArchiveLog, type Namespace, hash32, type Node } from "./domain.ts";
import { D1Archive, type BlockHeader } from "./archive.ts";
import { CheckpointConflict } from "./domain.ts";
export interface RpcSource {
  chainId(): Promise<string>;
  finalizedHead(): Promise<{ number: number; hash: string }>;
  block(number: number): Promise<{ number: number; hash: string; parentHash: string }>;
  logs(from: number, to: number): Promise<ArchiveLog[]>;
  receiptLogs(block: BlockHeader): Promise<ArchiveLog[]>;
  drawSnapshot(
    drawId: string,
    block: BlockHeader,
  ): Promise<{ rootHash: string; rootSum: string; closeBlock: number }>;
  membershipRoot(block: BlockHeader): Promise<Node>;
}
/** One bounded, finalized slice. Receipt comparison prevents an omitted ownership log from becoming a false negative. */
export async function ingestOneSlice(
  archive: D1Archive,
  n: Namespace,
  rpc: RpcSource,
  maxBlocks: number,
) {
  if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > 2)
    throw new Error("invalid max blocks");
  const state = await archive.status(n);
  if (state.disabledReason) return state;
  if ((await rpc.chainId()) !== n.chainId)
    return archive.disable(n, state, "rpc chain id mismatch");
  const head = await rpc.finalizedHead();
  // Check stored history even when there is no new finalized work. Otherwise a
  // reorg that leaves nextBlock beyond head is never discovered.
  const newest = Math.min(state.lastFinalizedBlock, head.number);
  let ancestor = n.deploymentBlock - 1;
  let found = state.lastFinalizedBlock < n.deploymentBlock;
  const floor = Math.max(n.deploymentBlock, newest - 127);
  for (let b = newest; b >= floor; b -= 1) {
    const saved = await archive.canonicalBlock(n, b);
    if (!saved) return archive.disable(n, state, "canonical checkpoint unavailable");
    const canonical = await rpc.block(b);
    if (canonical.number !== b) return archive.disable(n, state, "rpc block number mismatch");
    if (hash32(saved.hash) === hash32(canonical.hash)) {
      ancestor = b;
      found = true;
      break;
    }
  }
  if (!found) return archive.disable(n, state, "deep or unknown canonical fork");
  if (ancestor < state.lastFinalizedBlock) return archive.rollbackFrom(n, state, ancestor + 1);
  if (state.nextBlock > head.number) return state;
  if (!Number.isSafeInteger(head.number) || head.number < 0) throw new Error("invalid finalized head");
  const to = Math.min(head.number, state.nextBlock + maxBlocks - 1);
  if (!Number.isSafeInteger(to)) throw new Error("invalid bounded range");
  const headers: BlockHeader[] = [];
  for (let block = state.nextBlock; block <= to; block += 1) headers.push(await rpc.block(block));
  if (headers[0].parentHash !== state.lastFinalizedHash)
    return archive.disable(n, state, "canonical parent mismatch");
  const logs = await rpc.logs(state.nextBlock, to);
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
      receipt = await rpc.receiptLogs(headers[b - state.nextBlock]);
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
    const snapshot = await rpc.drawSnapshot(log.args.drawId, headers[log.blockNumber - state.nextBlock]);
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
  const onchainRoot = await rpc.membershipRoot(headers.at(-1)!);
  if (reconstructed.hash !== onchainRoot.hash || reconstructed.sum !== onchainRoot.sum)
    throw new Error("onchain membership root mismatch");
  try {
    return await archive.ingest(n, state, ordered, headers);
  } catch (e) {
    if (e instanceof CheckpointConflict) return archive.status(n);
    throw e;
  }
}
