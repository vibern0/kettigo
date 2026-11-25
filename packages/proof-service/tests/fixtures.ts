import { branchHash, leafHash, type ArchiveLog, type Namespace } from "../src/domain.ts";
import type { BlockHeader } from "../src/archive.ts";
import { getAddress } from "viem";

export const zero = `0x${"00".repeat(32)}`;
export const account = "0x1111111111111111111111111111111111111111";
export const otherAccount = "0x2222222222222222222222222222222222222222";

export function header(number = 1, hash = `0x${"11".repeat(32)}`): BlockHeader {
  return { number, hash, parentHash: zero };
}

function emptyHashes(depth: number): string[] {
  const empty = [leafHash("0x0000000000000000000000000000000000000000", "0", zero)];
  for (let level = 0; level < depth; level += 1) {
    const child = empty.at(level)!;
    empty.push(branchHash({ hash: child, sum: zero }, { hash: child, sum: zero }));
  }
  return empty;
}

function nodeUpdated(level: number, hash: string, blockHash: string): ArchiveLog {
  return {
    blockNumber: 1,
    blockHash,
    logIndex: level + 1,
    name: "NodeUpdated",
    args: { level: String(level), index: "0", hash, sum: zero },
  };
}

/** A real, single-slot depth-32 tree; the root is independently derived from every node update. */
export function depth32Fixture() {
  const poolSuffix = `${crypto.randomUUID().replaceAll("-", "")}00000000`.slice(0, 40);
  const empty = emptyHashes(32);
  const namespace: Namespace = {
    chainId: "11155111",
    pool: getAddress(`0x${poolSuffix}`),
    depth: 32,
    zero,
    emptyHashes: empty,
    deploymentBlock: 1,
  };
  const h = header();
  const logs: ArchiveLog[] = [
    {
      blockNumber: 1,
      blockHash: h.hash,
      logIndex: 0,
      name: "SlotAssigned",
      args: { account, index: "0", generation: "1" },
    },
  ];
  let node = { hash: leafHash(account, "1", zero), sum: zero };
  logs.push(nodeUpdated(0, node.hash, h.hash));
  for (let level = 0; level < 32; level += 1) {
    node = { hash: branchHash(node, { hash: empty.at(level)!, sum: zero }), sum: zero };
    logs.push(nodeUpdated(level + 1, node.hash, h.hash));
  }
  logs.push({
    blockNumber: 1,
    blockHash: h.hash,
    logIndex: 34,
    name: "DrawSnapshotClosed",
    args: {
      drawId: "1",
      rootHash: node.hash,
      rootSum: zero,
      ticket: zero,
      upperBound: "1",
      closeBlockNumber: "1",
    },
  });
  return { namespace, logs, root: node.hash, block: h };
}
