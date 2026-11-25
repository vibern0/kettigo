import { encodeAbiParameters, keccak256 } from "viem";

export const h32 = (byte) => {
  const pair = byte.length === 1 ? byte.repeat(2) : byte.padStart(2, "0");
  return `0x${pair.repeat(32)}`;
};

const leaf = (beneficiary, generation, balance) =>
  keccak256(
    encodeAbiParameters(
      [{ type: "uint8" }, { type: "address" }, { type: "uint64" }, { type: "bytes32" }],
      [0, beneficiary, generation, balance],
    ),
  );
const branch = (leftHash, leftSum, rightHash, rightSum) =>
  keccak256(
    encodeAbiParameters(
      [
        { type: "uint8" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [1, leftHash, leftSum, rightHash, rightSum],
    ),
  );

export function proofFixture({ pool, account, ...overrides }) {
  const siblings = Array.from({ length: 32 }, (_, index) => ({
    hash: h32((index + 1).toString(16)),
    sum: h32((index + 33).toString(16)),
  }));
  const siblingHashes = siblings.map(({ hash }) => hash);
  const siblingSums = siblings.map(({ sum }) => sum);
  const balance = h32("a");
  let hash = leaf(account, 7n, balance);
  let sum = balance;
  const parentSums = [];
  for (const sibling of siblings) {
    hash = branch(hash, sum, sibling.hash, sibling.sum);
    sum = h32((parentSums.length + 65).toString(16));
    parentSums.push(sum);
  }
  return {
    drawId: "19",
    rootHash: hash,
    rootSum: sum,
    ticket: h32("b"),
    upperBound: "8",
    closeBlockNumber: 1234,
    closeLogIndex: 17,
    chainId: "11155111",
    pool,
    blockHash: h32("c"),
    account,
    index: "0",
    generation: "7",
    balance,
    siblingHashes,
    siblingSums,
    parentSums,
    ...overrides,
  };
}
