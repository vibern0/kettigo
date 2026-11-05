import assert from "node:assert/strict";
import test from "node:test";

import { encodeAbiParameters, getAddress, keccak256, zeroAddress } from "viem";
import { createPrizeProofClient } from "../src/lib/prize-proof-client.ts";

const pool = getAddress("0x1000000000000000000000000000000000000001");
const account = getAddress("0x2000000000000000000000000000000000000002");
const handle = `0x${"11".repeat(32)}`;
const sibling = `0x${"22".repeat(32)}`;
const parent = `0x${"33".repeat(32)}`;
const hash = (types, values) => keccak256(encodeAbiParameters(types, values));
const leaf = () =>
  hash(
    [{ type: "uint8" }, { type: "address" }, { type: "uint64" }, { type: "bytes32" }],
    [0, account, 1n, handle],
  );
const branch = (leftHash, leftSum, rightHash, rightSum) =>
  hash(
    [
      { type: "uint8" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
    ],
    [1, leftHash, leftSum, rightHash, rightSum],
  );

function proof() {
  let root = leaf();
  for (let level = 0; level < 32; level++)
    root = branch(root, level === 0 ? handle : parent, sibling, sibling);
  return {
    drawId: "1",
    rootHash: root,
    rootSum: parent,
    ticket: handle,
    upperBound: "1",
    closeBlockNumber: 7,
    closeLogIndex: 0,
    chainId: "11155111",
    pool,
    blockHash: `0x${"44".repeat(32)}`,
    account,
    index: "0",
    generation: "1",
    balance: handle,
    siblingHashes: Array(32).fill(sibling),
    siblingSums: Array(32).fill(sibling),
    parentSums: Array(32).fill(parent),
  };
}

function client(response = { proof: proof() }) {
  return createPrizeProofClient({
    chainId: 11155111,
    pool,
    account,
    baseUrl: "https://proof.example",
    fetch: async () => new Response(JSON.stringify(response)),
    chainReader: {
      readDraw: async () => ({
        rootHash: proof().rootHash,
        rootSum: parent,
        ticket: handle,
        upperBound: 1n,
        closeBlockNumber: 7n,
      }),
      getBlockHash: async () => proof().blockHash,
    },
  });
}

test("authenticates an independently constructed full-depth proof against the immutable chain snapshot", async () => {
  const result = await client().getProof(1n);
  assert.equal(result.kind, "proof");
  if (result.kind === "proof") assert.equal(result.proof.rootHash, proof().rootHash);
});

test("rejects a proof whose authenticated path is tampered", async () => {
  const p = proof();
  p.siblingHashes[4] = `0x${"55".repeat(32)}`;
  const result = await client({ proof: p }).getProof(1n);
  assert.equal(result.kind, "unavailable");
});

test("preserves NOT_ELIGIBLE as an archive outcome instead of an on-chain loss", async () => {
  const result = await createPrizeProofClient({
    chainId: 11155111,
    pool,
    account,
    baseUrl: "https://proof.example",
    fetch: async () => new Response(JSON.stringify({ outcome: "NOT_ELIGIBLE" }), { status: 404 }),
    chainReader: {
      readDraw: async () => {
        throw new Error("not reached");
      },
      getBlockHash: async () => handle,
    },
  }).getProof(1n);
  assert.deepEqual(result, { kind: "not-eligible" });
});

test("preserves 409 archive availability outcomes", async () => {
  const result = await createPrizeProofClient({
    chainId: 11155111,
    pool,
    account,
    baseUrl: "https://proof.example",
    fetch: async () => new Response(JSON.stringify({ outcome: "INDEXING" }), { status: 409 }),
    chainReader: {
      readDraw: async () => {
        throw new Error("not reached");
      },
      getBlockHash: async () => handle,
    },
  }).getProof(1n);
  assert.deepEqual(result, { kind: "indexing" });
});

test("rejects a valid proof returned for a different requested draw", async () => {
  const result = await client().getProof(2n);
  assert.equal(result.kind, "unavailable");
});

test("never accepts a raw kind-shaped response as a trusted result", async () => {
  let reads = 0;
  const unsafe = createPrizeProofClient({
    chainId: 11155111,
    pool,
    account,
    baseUrl: "https://proof.example",
    fetch: async () => new Response(JSON.stringify({ kind: "proof", proof: proof() })),
    chainReader: {
      readDraw: async () => {
        reads++;
        throw new Error("must not read");
      },
      getBlockHash: async () => handle,
    },
  });
  const result = await unsafe.getProof(1n);
  assert.equal(result.kind, "unavailable");
  assert.equal(reads, 0);
});

test("bounds a non-cooperative chain reader with the operation deadline", async () => {
  const timed = createPrizeProofClient({
    chainId: 11155111,
    pool,
    account,
    baseUrl: "https://proof.example",
    timeoutMs: 5,
    fetch: async () => new Response(JSON.stringify({ proof: proof() })),
    chainReader: { readDraw: async () => new Promise(() => {}), getBlockHash: async () => handle },
  });
  const result = await timed.getProof(1n);
  assert.equal(result.kind, "unavailable");
  if (result.kind === "unavailable") assert.equal(result.reason, "archive timeout");
});

test("bounds list pagination and rejects wrong scoped records", async () => {
  await assert.rejects(() => client().listDraws({ limit: 101 }));
  const wrong = { ...proof(), pool: zeroAddress };
  const result = await client({ draws: [wrong] }).listDraws();
  assert.equal(result.kind, "unavailable");
});

test("rejects a positive proof for a different chain without treating it as an outcome", async () => {
  const p = proof();
  p.chainId = "1";
  const result = await client({ proof: p }).getProof(1n);
  assert.equal(result.kind, "unavailable");
});

test("preserves caller cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const cancelled = createPrizeProofClient({
    chainId: 11155111,
    pool,
    account,
    baseUrl: "https://proof.example",
    fetch: async (_url, init) => {
      if (init?.signal?.aborted) throw new DOMException("cancelled", "AbortError");
      return new Response("{}");
    },
    chainReader: {
      readDraw: async () => {
        throw new Error("not reached");
      },
      getBlockHash: async () => handle,
    },
  });
  await assert.rejects(() => cancelled.getProof(1n, { signal: controller.signal }), {
    name: "AbortError",
  });
});
