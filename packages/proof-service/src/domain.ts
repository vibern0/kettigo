import { encodeAbiParameters, getAddress, keccak256, zeroAddress } from "viem";

export type Address = `0x${string}`;
export type Node = { hash: string; sum: string };
export type Namespace = {
  chainId: string;
  pool: Address;
  depth: number;
  zero: string;
  emptyHashes: string[];
  deploymentBlock: number;
};
export type ArchiveLog = {
  blockNumber: number;
  blockHash: string;
  logIndex: number;
  name: "NodeUpdated" | "SlotAssigned" | "SlotReleased" | "DrawSnapshotClosed";
  args: Record<string, string>;
};
export class CheckpointConflict extends Error {
  constructor() {
    super("checkpoint conflict");
  }
}
export const decimal = (v: unknown, label = "integer") => {
  const s = String(v);
  if (!/^(0|[1-9][0-9]*)$/.test(s)) throw new Error(`invalid ${label}`);
  return s;
};
export const uint = (v: unknown, bits: number, label = "integer") => {
  const value = decimal(v, label);
  if (BigInt(value) >= 1n << BigInt(bits)) throw new Error(`invalid ${label}`);
  return value;
};
export const hash32 = (v: unknown, label = "hash") => {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`invalid ${label}`);
  return v.toLowerCase();
};
export const checksum = (v: unknown): Address => getAddress(v as Address);
export function validateNamespace(n: Namespace): Namespace {
  if (
    !Number.isSafeInteger(n.depth) ||
    n.depth < 1 ||
    n.depth > 32 ||
    !Number.isSafeInteger(n.deploymentBlock) ||
    n.deploymentBlock < 0
  )
    throw new Error("invalid namespace");
  const zero = hash32(n.zero, "zero");
  const hashes = n.emptyHashes.map((x) => hash32(x, "empty hash"));
  if (hashes.length !== n.depth + 1) throw new Error("invalid empty hash count");
  let current = leafHash(zeroAddress, "0", zero);
  for (let i = 0; i <= n.depth; i++) {
    if (hashes[i] !== current) throw new Error("empty hash mismatch");
    current = branchHash({ hash: current, sum: zero }, { hash: current, sum: zero });
  }
  return {
    ...n,
    chainId: decimal(n.chainId, "chain id"),
    pool: checksum(n.pool),
    zero,
    emptyHashes: hashes,
  };
}
export const leafHash = (account: Address, generation: string, balance: string) =>
  keccak256(
    encodeAbiParameters(
      [{ type: "uint8" }, { type: "address" }, { type: "uint64" }, { type: "bytes32" }],
      [
        0,
        checksum(account),
        BigInt(uint(generation, 64, "generation")),
        hash32(balance) as `0x${string}`,
      ],
    ),
  );
export const branchHash = (left: Node, right: Node) =>
  keccak256(
    encodeAbiParameters(
      [
        { type: "uint8" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        1,
        hash32(left.hash) as `0x${string}`,
        hash32(left.sum) as `0x${string}`,
        hash32(right.hash) as `0x${string}`,
        hash32(right.sum) as `0x${string}`,
      ],
    ),
  );
