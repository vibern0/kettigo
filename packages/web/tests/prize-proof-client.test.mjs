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

function proof(index = 0n, upperBound = 1n) {
  let root = leaf();
  let sum = handle;
  for (let level = 0; level < 32; level++) {
    const left = ((index >> BigInt(level)) & 1n) === 0n;
    root = left ? branch(root, sum, sibling, sibling) : branch(sibling, sibling, root, sum);
    sum = parent;
  }
  return {
    drawId: "1",
    rootHash: root,
    rootSum: parent,
    ticket: handle,
    upperBound: upperBound.toString(),
    closeBlockNumber: 7,
    closeLogIndex: 0,
    chainId: "11155111",
    pool,
    blockHash: `0x${"44".repeat(32)}`,
    account,
    index: index.toString(),
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
  // This is intentionally a fixed vector, independently anchored to Solidity's
  // abi.encode(uint8,address,uint64,bytes32) / abi.encode(uint8,bytes32x4).
  assert.equal(
    proof().rootHash,
    "0xc951696283a98a6630145167a76119aeebf65e9427a90a3eaf8b1b8042649273",
  );
  const result = await client().getProof(1n);
  assert.equal(result.kind, "proof");
  if (result.kind === "proof") assert.equal(result.proof.rootHash, proof().rootHash);
});

test("authenticates a fixed mixed-bit path through both branch directions", async () => {
  const p = proof(0xa5a5a5a5n, 1n << 32n);
  assert.equal(p.rootHash, "0xe9e91223b76e0cb1a6edbac727291abb0a67c9b42d7d3eaa0ab6910c47ef2eee");
  const result = await createPrizeProofClient({
    chainId: 11155111,
    pool,
    account,
    baseUrl: "https://proof.example",
    fetch: async () => new Response(JSON.stringify({ proof: p })),
    chainReader: {
      readDraw: async () => ({
        rootHash: p.rootHash,
        rootSum: p.rootSum,
        ticket: p.ticket,
        upperBound: 1n << 32n,
        closeBlockNumber: 7n,
      }),
      getBlockHash: async () => p.blockHash,
    },
  }).getProof(1n);
  assert.equal(result.kind, "proof");
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

test("preserves HISTORY_UNAVAILABLE for both documented archive statuses", async () => {
  for (const status of [404, 409]) {
    const result = await createPrizeProofClient({
      chainId: 11155111,
      pool,
      account,
      baseUrl: "https://proof.example",
      fetch: async () =>
        new Response(JSON.stringify({ outcome: "HISTORY_UNAVAILABLE" }), { status }),
      chainReader: {
        readDraw: async () => {
          throw new Error("not reached");
        },
        getBlockHash: async () => handle,
      },
    }).getProof(1n);
    assert.deepEqual(result, { kind: "history-unavailable" });
  }
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

test("never accepts a raw kind-shaped draw list", async () => {
  const result = await client({ kind: "draws", draws: [proof()] }).listDraws();
  assert.equal(result.kind, "unavailable");
});

test("rejects malformed archive JSON and fetch failure as unavailable", async () => {
  for (const fetch of [
    async () => new Response("{not json"),
    async () => {
      throw new Error("archive offline");
    },
  ]) {
    const result = await createPrizeProofClient({
      chainId: 11155111,
      pool,
      account,
      baseUrl: "https://proof.example",
      fetch,
      chainReader: {
        readDraw: async () => {
          throw new Error("not reached");
        },
        getBlockHash: async () => handle,
      },
    }).getProof(1n);
    assert.equal(result.kind, "unavailable");
  }
});

test("rejects identity, bounds, handle, root, and proof-array mutations before chain reads", async () => {
  const mutations = [
    ["account", zeroAddress],
    ["pool", zeroAddress],
    ["chainId", "1"],
    ["drawId", "2"],
    ["generation", "0"],
    ["generation", (1n << 64n).toString()],
    ["index", "1"],
    ["index", (1n << 32n).toString()],
    ["upperBound", "0"],
    ["upperBound", ((1n << 32n) | 1n).toString()],
    ["balance", "0x12"],
    ["rootHash", `0x${"aa".repeat(32)}`],
    ["closeBlockNumber", 0],
    ["closeLogIndex", -1],
  ];
  for (const [key, value] of mutations) {
    const p = proof();
    p[key] = value;
    let reads = 0;
    const result = await createPrizeProofClient({
      chainId: 11155111,
      pool,
      account,
      baseUrl: "https://proof.example",
      fetch: async () => new Response(JSON.stringify({ proof: p })),
      chainReader: {
        readDraw: async () => {
          reads++;
          throw new Error("not reached");
        },
        getBlockHash: async () => {
          reads++;
          return handle;
        },
      },
    }).getProof(1n);
    assert.equal(result.kind, "unavailable", key);
    assert.equal(reads, 0, key);
  }
});

test("rejects sibling and parent value mutations before chain reads", async () => {
  for (const key of ["siblingHashes", "siblingSums", "parentSums"]) {
    const p = proof();
    p[key][7] = `0x${"aa".repeat(32)}`;
    let reads = 0;
    const result = await createPrizeProofClient({
      chainId: 11155111,
      pool,
      account,
      baseUrl: "https://proof.example",
      fetch: async () => new Response(JSON.stringify({ proof: p })),
      chainReader: {
        readDraw: async () => {
          reads++;
          throw new Error("not reached");
        },
        getBlockHash: async () => {
          reads++;
          return handle;
        },
      },
    }).getProof(1n);
    assert.equal(result.kind, "unavailable", key);
    assert.equal(reads, 0, key);
  }
});

test("rejects each proof sibling and parent length mutation before chain reads", async () => {
  for (const key of ["siblingHashes", "siblingSums", "parentSums"]) {
    const p = proof();
    p[key] = p[key].slice(1);
    let reads = 0;
    const result = await createPrizeProofClient({
      chainId: 11155111,
      pool,
      account,
      baseUrl: "https://proof.example",
      fetch: async () => new Response(JSON.stringify({ proof: p })),
      chainReader: {
        readDraw: async () => {
          reads++;
          throw new Error("not reached");
        },
        getBlockHash: async () => {
          reads++;
          return handle;
        },
      },
    }).getProof(1n);
    assert.equal(result.kind, "unavailable", key);
    assert.equal(reads, 0, key);
  }
});

test("rejects chain snapshot and close-block mismatches", async () => {
  for (const reader of [
    {
      readDraw: async () => ({
        rootHash: handle,
        rootSum: parent,
        ticket: handle,
        upperBound: 1n,
        closeBlockNumber: 7n,
      }),
      getBlockHash: async () => proof().blockHash,
    },
    {
      readDraw: async () => ({
        rootHash: proof().rootHash,
        rootSum: parent,
        ticket: `0x${"aa".repeat(32)}`,
        upperBound: 1n,
        closeBlockNumber: 7n,
      }),
      getBlockHash: async () => proof().blockHash,
    },
    {
      readDraw: async () => ({
        rootHash: proof().rootHash,
        rootSum: parent,
        ticket: handle,
        upperBound: 1n,
        closeBlockNumber: 7n,
      }),
      getBlockHash: async () => `0x${"55".repeat(32)}`,
    },
  ]) {
    const result = await createPrizeProofClient({
      chainId: 11155111,
      pool,
      account,
      baseUrl: "https://proof.example",
      fetch: async () => new Response(JSON.stringify({ proof: proof() })),
      chainReader: reader,
    }).getProof(1n);
    assert.equal(result.kind, "unavailable");
  }
});

test("rejects each independently authenticated immutable chain snapshot mismatch", async () => {
  for (const mismatch of [{ rootSum: handle }, { upperBound: 2n }, { closeBlockNumber: 8n }]) {
    const result = await createPrizeProofClient({
      chainId: 11155111,
      pool,
      account,
      baseUrl: "https://proof.example",
      fetch: async () => new Response(JSON.stringify({ proof: proof() })),
      chainReader: {
        readDraw: async () => ({
          rootHash: proof().rootHash,
          rootSum: parent,
          ticket: handle,
          upperBound: 1n,
          closeBlockNumber: 7n,
          ...mismatch,
        }),
        getBlockHash: async () => proof().blockHash,
      },
    }).getProof(1n);
    assert.equal(result.kind, "unavailable", Object.keys(mismatch)[0]);
  }
});

test("maps each rejecting chain reader to unavailable without continuing", async () => {
  for (const stage of ["readDraw", "getBlockHash"]) {
    let blockReads = 0;
    const result = await createPrizeProofClient({
      chainId: 11155111,
      pool,
      account,
      baseUrl: "https://proof.example",
      fetch: async () => new Response(JSON.stringify({ proof: proof() })),
      chainReader: {
        readDraw: async () => {
          if (stage === "readDraw") throw new Error("provider read failure");
          return {
            rootHash: proof().rootHash,
            rootSum: parent,
            ticket: handle,
            upperBound: 1n,
            closeBlockNumber: 7n,
          };
        },
        getBlockHash: async () => {
          blockReads++;
          if (stage === "getBlockHash") throw new Error("provider block failure");
          return proof().blockHash;
        },
      },
    }).getProof(1n);
    assert.equal(result.kind, "unavailable", stage);
    assert.equal(blockReads, stage === "readDraw" ? 0 : 1, stage);
  }
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
  await assert.rejects(() => client().getProof(1n << 256n));
  await assert.rejects(() => client().listDraws({ cursor: 1n << 256n }));
  const wrong = { ...proof(), pool: zeroAddress };
  const result = await client({ draws: [wrong] }).listDraws();
  assert.equal(result.kind, "unavailable");
});

test("accepts zero upper-bound list metadata but rejects malformed and cursor-violating lists", async () => {
  const empty = { ...proof(), upperBound: "0" };
  const listed = await client({ draws: [empty] }).listDraws();
  assert.equal(listed.kind, "draws");
  const malformed = await client({ draws: "not-an-array" }).listDraws();
  assert.equal(malformed.kind, "unavailable");
  const cursor = await client({ draws: [proof()] }).listDraws({ cursor: 1n });
  assert.equal(cursor.kind, "unavailable");
});

test("rejects invalid or oversized content lengths without chain reads", async () => {
  for (const contentLength of ["not-a-number", "128001"]) {
    let reads = 0;
    const result = await createPrizeProofClient({
      chainId: 11155111,
      pool,
      account,
      baseUrl: "https://proof.example",
      fetch: async () => new Response("{}", { headers: { "content-length": contentLength } }),
      chainReader: {
        readDraw: async () => {
          reads++;
          throw new Error("not reached");
        },
        getBlockHash: async () => handle,
      },
    }).getProof(1n);
    assert.equal(result.kind, "unavailable", contentLength);
    assert.equal(reads, 0, contentLength);
  }
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

test("caller abort during readDraw prevents a late block lookup or proof", async () => {
  const controller = new AbortController();
  let resolveRead;
  let startRead;
  let blockReads = 0;
  const started = new Promise((resolve) => {
    startRead = resolve;
  });
  const pending = createPrizeProofClient({
    chainId: 11155111,
    pool,
    account,
    baseUrl: "https://proof.example",
    fetch: async () => new Response(JSON.stringify({ proof: proof() })),
    chainReader: {
      readDraw: async () => {
        startRead();
        return new Promise((resolve) => {
          resolveRead = resolve;
        });
      },
      getBlockHash: async () => {
        blockReads++;
        return proof().blockHash;
      },
    },
  }).getProof(1n, { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(() => pending, { name: "AbortError" });
  resolveRead({
    rootHash: proof().rootHash,
    rootSum: parent,
    ticket: handle,
    upperBound: 1n,
    closeBlockNumber: 7n,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(blockReads, 0);
});

test("caller abort during getBlockHash prevents a late usable proof", async () => {
  const controller = new AbortController();
  let resolveBlock;
  let startBlock;
  const started = new Promise((resolve) => {
    startBlock = resolve;
  });
  const pending = createPrizeProofClient({
    chainId: 11155111,
    pool,
    account,
    baseUrl: "https://proof.example",
    fetch: async () => new Response(JSON.stringify({ proof: proof() })),
    chainReader: {
      readDraw: async () => ({
        rootHash: proof().rootHash,
        rootSum: parent,
        ticket: handle,
        upperBound: 1n,
        closeBlockNumber: 7n,
      }),
      getBlockHash: async () => {
        startBlock();
        return new Promise((resolve) => {
          resolveBlock = resolve;
        });
      },
    },
  }).getProof(1n, { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(() => pending, { name: "AbortError" });
  resolveBlock(proof().blockHash);
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("cancels a non-cooperative response reader when the deadline expires", async () => {
  let cancelled = 0;
  const stream = new ReadableStream({
    pull() {
      return new Promise(() => {});
    },
    cancel() {
      cancelled++;
    },
  });
  const timed = createPrizeProofClient({
    chainId: 11155111,
    pool,
    account,
    baseUrl: "https://proof.example",
    timeoutMs: 5,
    fetch: async () => new Response(stream),
    chainReader: {
      readDraw: async () => {
        throw new Error("not reached");
      },
      getBlockHash: async () => handle,
    },
  });
  const result = await timed.getProof(1n);
  assert.equal(result.kind, "unavailable");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cancelled, 1);
});

test("caps chunked UTF-8 body bytes and cancels before chain reads", async () => {
  let cancelled = 0,
    reads = 0;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("é".repeat(64_001)));
    },
    cancel() {
      cancelled++;
    },
  });
  const bounded = createPrizeProofClient({
    chainId: 11155111,
    pool,
    account,
    baseUrl: "https://proof.example",
    fetch: async () => new Response(stream),
    chainReader: {
      readDraw: async () => {
        reads++;
        throw new Error("not reached");
      },
      getBlockHash: async () => handle,
    },
  });
  const result = await bounded.getProof(1n);
  assert.equal(result.kind, "unavailable");
  assert.equal(cancelled, 1);
  assert.equal(reads, 0);
});
