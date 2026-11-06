import { encodeAbiParameters, keccak256, type Hex } from "viem";

import {
  createPrizeProofClient,
  type PrizeChainReader,
  type PrizeProof,
} from "../../../../web/src/lib/prize-proof-client.ts";
import { addr, decimal, h32 } from "./workload-values.ts";

type ClosedDraw = Readonly<{
  drawId: string;
  transactionHash: Hex;
  blockNumber: string;
  blockHash: Hex;
}>;
type SnapshotClosed = ClosedDraw & Readonly<{ logIndex: number }>;

export type HistoricPrizeProofInput = Readonly<{
  pool: string;
  account: string;
  drawId: string;
  closedDraw: ClosedDraw;
  snapshotClosed: SnapshotClosed;
  baseUrl: string;
  fetch: typeof fetch;
  readSnapshot: PrizeChainReader["readDraw"];
  readBlockHash: PrizeChainReader["getBlockHash"];
}>;

export type HistoricPrizeProofBundle = Readonly<{
  drawId: string;
  index: string;
  generation: string;
  balanceHandle: Hex;
  siblingHashes: readonly Hex[];
  siblingSums: readonly Hex[];
  parentSums: readonly Hex[];
  bundleId: Hex;
}>;

const UINT32_MAX = (1n << 32n) - 1n;
function fail(reason: string): never {
  throw new Error(`historic proof: ${reason}`);
}
const exact = (left: string, right: string, label: string) => {
  if (left.toLowerCase() !== right.toLowerCase()) fail(`canonical ${label} mismatch`);
};
const canonicalUint = (value: unknown, label: string, maximum?: bigint) =>
  decimal(value, label, maximum);

function canonicalClose(input: HistoricPrizeProofInput) {
  const drawId = canonicalUint(input.drawId, "draw ID");
  const closed = input.closedDraw;
  const snapshot = input.snapshotClosed;
  if (!Number.isSafeInteger(snapshot.logIndex) || snapshot.logIndex < 0)
    fail("invalid canonical close log index");
  for (const event of [closed, snapshot]) {
    if (canonicalUint(event.drawId, "canonical draw ID") !== drawId)
      fail("canonical draw ID mismatch");
    if (canonicalUint(event.blockNumber, "canonical close block") === "0")
      fail("invalid canonical close block");
    h32(event.transactionHash, "canonical close transaction");
    h32(event.blockHash, "canonical close block hash");
  }
  exact(closed.transactionHash, snapshot.transactionHash, "close receipt transaction");
  if (closed.blockNumber !== snapshot.blockNumber)
    fail("canonical close receipt block number mismatch");
  exact(closed.blockHash, snapshot.blockHash, "close receipt block hash");
  return Object.freeze({
    drawId,
    blockNumber: closed.blockNumber,
    blockHash: h32(closed.blockHash, "canonical close block hash"),
    logIndex: snapshot.logIndex,
  });
}

function injectedReaders(input: HistoricPrizeProofInput): PrizeChainReader {
  if (
    typeof input.fetch !== "function" ||
    typeof input.readSnapshot !== "function" ||
    typeof input.readBlockHash !== "function"
  )
    fail("injected proof readers are required");
  return {
    readDraw: input.readSnapshot,
    getBlockHash: input.readBlockHash,
  };
}

function bundleId(input: {
  drawId: string;
  account: Hex;
  index: string;
  generation: string;
  balanceHandle: Hex;
  siblingHashes: readonly Hex[];
  siblingSums: readonly Hex[];
  parentSums: readonly Hex[];
  closeBlock: string;
  closeHash: Hex;
  closeLogIndex: number;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint64" },
        { type: "bytes32" },
        { type: "bytes32[]" },
        { type: "bytes32[]" },
        { type: "bytes32[]" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "uint256" },
      ],
      [
        BigInt(input.drawId),
        input.account,
        BigInt(input.index),
        BigInt(input.generation),
        input.balanceHandle,
        input.siblingHashes,
        input.siblingSums,
        input.parentSums,
        BigInt(input.closeBlock),
        input.closeHash,
        BigInt(input.closeLogIndex),
      ],
    ),
  );
}

function verifiedBundle(proof: PrizeProof, close: ReturnType<typeof canonicalClose>, account: Hex) {
  if (proof.closeLogIndex !== close.logIndex) fail("canonical close log index mismatch");
  if (proof.closeBlockNumber.toString() !== close.blockNumber)
    fail("canonical close block mismatch");
  exact(proof.blockHash, close.blockHash, "close block hash");
  const index = proof.index.toString();
  if (BigInt(index) > UINT32_MAX) fail("invalid proof index");
  const generation = proof.generation.toString();
  const balanceHandle = h32(proof.balance, "balance handle");
  const siblingHashes = Object.freeze(
    proof.siblingHashes.map((value) => h32(value, "sibling hash")),
  );
  const siblingSums = Object.freeze(proof.siblingSums.map((value) => h32(value, "sibling sum")));
  const parentSums = Object.freeze(proof.parentSums.map((value) => h32(value, "parent sum")));
  return Object.freeze({
    drawId: close.drawId,
    index,
    generation,
    balanceHandle,
    siblingHashes,
    siblingSums,
    parentSums,
    bundleId: bundleId({
      drawId: close.drawId,
      account,
      index,
      generation,
      balanceHandle,
      siblingHashes,
      siblingSums,
      parentSums,
      closeBlock: close.blockNumber,
      closeHash: close.blockHash,
      closeLogIndex: close.logIndex,
    }),
  });
}

/**
 * Binds one archive proof to independently resolved close-event identity.
 * The shared web client remains the only Merkle-path and archive validator.
 */
export async function resolveHistoricPrizeProof(
  input: HistoricPrizeProofInput,
): Promise<HistoricPrizeProofBundle> {
  try {
    const chainReader = injectedReaders(input);
    const close = canonicalClose(input);
    const pool = addr(input.pool, "pool");
    const account = addr(input.account, "beneficiary");
    const client = createPrizeProofClient({
      chainId: 11155111,
      pool,
      account,
      baseUrl: input.baseUrl,
      fetch: input.fetch,
      chainReader,
    });
    const result = await client.getProof(BigInt(close.drawId));
    if (result.kind !== "proof") fail("archive did not return a proof");
    return verifiedBundle(result.proof, close, account);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("historic proof:")) throw error;
    fail(error instanceof Error ? error.message : "invalid evidence");
  }
}
