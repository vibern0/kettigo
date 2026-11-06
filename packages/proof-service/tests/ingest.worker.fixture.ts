import { type BlockHeader, type Checkpoint, D1Archive } from "../src/archive.ts";
import type { RpcSource } from "../src/ingest.ts";
import { branchHash, leafHash, type ArchiveLog, type Namespace } from "../src/domain.ts";

export const zero = `0x${"00".repeat(32)}`;
let serial = 100;

export function namespace(): Namespace {
  serial += 1;
  const leaf = leafHash("0x0000000000000000000000000000000000000000", "0", zero);
  return {
    chainId: "11155111",
    pool: `0x${serial.toString().padStart(40, "3")}`,
    depth: 1,
    zero,
    emptyHashes: [leaf, branchHash({ hash: leaf, sum: zero }, { hash: leaf, sum: zero })],
    deploymentBlock: 1,
  };
}

export function header(number: number, nibble: string, parentHash = zero): BlockHeader {
  return { number, hash: `0x${nibble.repeat(64)}`, parentHash };
}

export function retainedHeaders(last = 130) {
  return Array.from({ length: last }, (_, offset) => {
    const number = offset + 1;
    return header(
      number,
      (number % 16).toString(16),
      offset ? `0x${(offset % 16).toString(16).repeat(64)}` : zero,
    );
  });
}

export class FixtureRpc implements RpcSource {
  constructor(
    readonly blocks: BlockHeader[],
    readonly allLogs: ArchiveLog[] = [],
    readonly n?: Namespace,
    readonly root?: { hash: string; sum: string },
    readonly receipts?: ArchiveLog[],
  ) {}

  async chainId() {
    return "11155111";
  }

  async finalizedHead() {
    const x = this.blocks.at(-1)!;
    return { number: x.number, hash: x.hash };
  }

  async latestHead() {
    return this.blocks.at(-1)!;
  }

  async block(number: number) {
    const x = this.blocks.find((b) => b.number === number);
    if (!x) throw new Error("missing block");
    return x;
  }

  async logs(from: number, to: number) {
    return this.allLogs.filter((x) => x.blockNumber >= from && x.blockNumber <= to);
  }

  async receiptLogs(block: BlockHeader) {
    return (this.receipts ?? this.allLogs).filter((x) => x.blockNumber === block.number);
  }

  async drawSnapshot(): ReturnType<RpcSource["drawSnapshot"]> {
    throw new Error("unused");
  }

  async membershipRoot() {
    if (this.root) return this.root;
    const root = [...this.allLogs]
      .reverse()
      .find((log) => log.name === "NodeUpdated" && log.args.level === String(this.n?.depth));
    return root
      ? { hash: root.args.hash, sum: root.args.sum }
      : { hash: this.n?.emptyHashes[this.n.depth] ?? zero, sum: zero };
  }
}

export function abortAfterFirstIngest(archive: D1Archive) {
  const controller = new AbortController();
  const abortingArchive = archive as unknown as {
    ingest(
      namespace: Namespace,
      expected: Checkpoint,
      logs: readonly ArchiveLog[],
      headers: readonly BlockHeader[],
    ): Promise<Checkpoint>;
  };
  const ingest = abortingArchive.ingest.bind(archive);
  abortingArchive.ingest = async (namespace, expected, logs, headers) => {
    const state = await ingest(namespace, expected, logs, headers);
    controller.abort(new Error("tick deadline exceeded"));
    return state;
  };
  return controller;
}

export async function seedRetainedProof(archive: D1Archive, n: Namespace) {
  const headers = retainedHeaders();
  const account = "0x00000000000000000000000000000000000000a1";
  const h2 = headers[1];
  const leaf = leafHash(account, "1", zero);
  const root = branchHash({ hash: leaf, sum: zero }, { hash: n.emptyHashes[0], sum: zero });
  const logs: ArchiveLog[] = [
    {
      blockNumber: 2,
      blockHash: h2.hash,
      logIndex: 0,
      name: "SlotAssigned",
      args: { account, index: "0", generation: "1" },
    },
    {
      blockNumber: 2,
      blockHash: h2.hash,
      logIndex: 1,
      name: "NodeUpdated",
      args: { level: "0", index: "0", hash: leaf, sum: zero },
    },
    {
      blockNumber: 2,
      blockHash: h2.hash,
      logIndex: 2,
      name: "NodeUpdated",
      args: { level: "1", index: "0", hash: root, sum: zero },
    },
    {
      blockNumber: 2,
      blockHash: h2.hash,
      logIndex: 3,
      name: "DrawSnapshotClosed",
      args: {
        drawId: "1",
        rootHash: root,
        rootSum: zero,
        ticket: zero,
        upperBound: "1",
        closeBlockNumber: "2",
      },
    },
  ];
  await archive.initialize(n);
  await archive.ingest(n, await archive.status(n), logs, headers);
  return { account, h2, headers, logs };
}
