import { env as workerEnv } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionResult } from "viem";
import { confidentialPrizePoolAbi } from "@kettigo/protocol";
import { D1Archive } from "../src/archive.ts";
import { handle, type Env } from "../src/server.ts";
import { account, depth32Fixture, otherAccount, zero } from "./fixtures.ts";

const db = (workerEnv as unknown as { PROOF_DB: D1Database }).PROOF_DB;
const json = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));

async function seeded() {
  const fixture = depth32Fixture();
  const archive = new D1Archive(db);
  await archive.initialize(fixture.namespace);
  await archive.ingest(fixture.namespace, await archive.status(fixture.namespace), fixture.logs, [
    fixture.block,
  ]);
  const env = {
    PROOF_DB: db,
    CHAIN_ID: fixture.namespace.chainId,
    POOL_ADDRESS: fixture.namespace.pool,
    TREE_DEPTH: "32",
    ZERO_HANDLE: zero,
    EMPTY_HASHES_JSON: JSON.stringify(fixture.namespace.emptyHashes),
    DEPLOYMENT_BLOCK: "1",
    PRIMARY_RPC_URL: "https://primary.test",
    HISTORICAL_RPC_URL: "https://historical.test",
    CONFIRMATIONS: "0",
    ALLOWED_ORIGINS: "https://app.kettigo.test",
  } as Env;
  return { ...fixture, env };
}

function drawResult(rootHash: string, closeBlock: bigint) {
  return encodeFunctionResult({
    abi: confidentialPrizePoolAbi,
    functionName: "draws",
    result: [
      rootHash as `0x${string}`,
      zero as `0x${string}`,
      zero as `0x${string}`,
      zero as `0x${string}`,
      zero as `0x${string}`,
      1n,
      closeBlock,
    ],
  });
}

function rpc(
  fixture: Awaited<ReturnType<typeof seeded>>,
  options: {
    hash?: string;
    root?: string;
    close?: bigint;
    chain?: string;
    fail?: boolean;
    hold?: Promise<void>;
  } = {},
) {
  const canonicalHash = options.hash ?? fixture.block.hash;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      if (options.hold) await options.hold;
      if (options.fail) throw new Error("outage");
      const { method } = JSON.parse(String(init.body)) as { method: string };
      if (method === "eth_chainId")
        return json(`0x${BigInt(options.chain ?? fixture.namespace.chainId).toString(16)}`);
      if (method === "eth_blockNumber") return json("0x1");
      if (method === "eth_getBlockByNumber")
        return json({ number: "0x1", hash: canonicalHash, parentHash: zero });
      if (method === "eth_call")
        return json(drawResult(options.root ?? fixture.root, options.close ?? 1n));
      throw new Error(`unexpected ${method}`);
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("native D1 HTTP proof matrix", () => {
  it("returns an independently-authenticated depth-32 proof with identity, owner, and generation", async () => {
    const fixture = await seeded();
    rpc(fixture);
    const response = await handle(
      new Request(
        `https://proof.test/v1/${fixture.namespace.chainId}/${fixture.namespace.pool}/draws/1/proof/${account}`,
        { headers: { origin: "https://app.kettigo.test" } },
      ),
      fixture.env,
    );
    const body = (await response.json()) as { proof: Record<string, unknown> };
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.kettigo.test");
    expect(body.proof.rootHash).toBe(fixture.root);
    expect(body.proof.chainId).toBe(fixture.namespace.chainId);
    expect(body.proof.pool).toBe(fixture.namespace.pool);
    expect(body.proof.account).toBe(account);
    expect(body.proof.generation).toBe("1");
    expect(body.proof.siblingHashes).toHaveLength(32);
  });

  it("returns CORS-readable eligibility and indexing outcomes", async () => {
    const fixture = await seeded();
    rpc(fixture, { close: 3n });
    const indexing = await handle(
      new Request(
        `https://proof.test/v1/${fixture.namespace.chainId}/${fixture.namespace.pool}/draws/2/proof/${account}`,
        { headers: { origin: "https://app.kettigo.test" } },
      ),
      fixture.env,
    );
    expect(await indexing.json()).toEqual({ outcome: "INDEXING" });
    expect(indexing.headers.get("access-control-allow-origin")).toBe("https://app.kettigo.test");
    rpc(fixture, { close: 0n });
    const unknown = await handle(
      new Request(
        `https://proof.test/v1/${fixture.namespace.chainId}/${fixture.namespace.pool}/draws/2/proof/${account}`,
        { headers: { origin: "https://app.kettigo.test" } },
      ),
      fixture.env,
    );
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("access-control-allow-origin")).toBe("https://app.kettigo.test");
    rpc(fixture);
    const ineligible = await handle(
      new Request(
        `https://proof.test/v1/${fixture.namespace.chainId}/${fixture.namespace.pool}/draws/1/proof/${otherAccount}`,
        { headers: { origin: "https://app.kettigo.test" } },
      ),
      fixture.env,
    );
    expect(await ineligible.json()).toEqual({ outcome: "NOT_ELIGIBLE" });
    expect(ineligible.headers.get("access-control-allow-origin")).toBe("https://app.kettigo.test");
    rpc(fixture, { close: 1n });
    const missing = await handle(
      new Request(
        `https://proof.test/v1/${fixture.namespace.chainId}/${fixture.namespace.pool}/draws/2/proof/${account}`,
        { headers: { origin: "https://app.kettigo.test" } },
      ),
      fixture.env,
    );
    expect(await missing.json()).toEqual({ outcome: "HISTORY_UNAVAILABLE" });
    expect(missing.headers.get("access-control-allow-origin")).toBe("https://app.kettigo.test");
  });

  it("fails closed with CORS for canonical close/checkpoint mismatch, wrong chain, and provider outage", async () => {
    const fixture = await seeded();
    for (const options of [
      { hash: `0x${"44".repeat(32)}` },
      { root: `0x${"66".repeat(32)}` },
      { chain: "1" },
      { fail: true },
    ]) {
      rpc(fixture, options);
      const response = await handle(
        new Request(
          `https://proof.test/v1/${fixture.namespace.chainId}/${fixture.namespace.pool}/draws/1/proof/${account}`,
          { headers: { origin: "https://app.kettigo.test" } },
        ),
        fixture.env,
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ outcome: "HISTORY_UNAVAILABLE" });
      expect(response.headers.get("access-control-allow-origin")).toBe("https://app.kettigo.test");
    }
  });

  it("refuses lists whose stored canonical checkpoint is orphaned", async () => {
    const fixture = await seeded();
    rpc(fixture, { hash: `0x${"55".repeat(32)}` });
    const response = await handle(
      new Request(
        `https://proof.test/v1/${fixture.namespace.chainId}/${fixture.namespace.pool}/draws`,
        { headers: { origin: "https://app.kettigo.test" } },
      ),
      fixture.env,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ outcome: "HISTORY_UNAVAILABLE" });
  });

  it("rejects malformed and over-uint256 ids and preserves CORS", async () => {
    const fixture = await seeded();
    rpc(fixture);
    for (const id of [
      "01",
      "x",
      "115792089237316195423570985008687907853269984665640564039457584007913129639936",
    ]) {
      const response = await handle(
        new Request(
          `https://proof.test/v1/${fixture.namespace.chainId}/${fixture.namespace.pool}/draws/${id}/proof/${account}`,
          { headers: { origin: "https://app.kettigo.test" } },
        ),
        fixture.env,
      );
      expect(response.status).not.toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("https://app.kettigo.test");
    }
  });

  it("refuses an immutable namespace change after genuine data has been stored", async () => {
    const fixture = await seeded();
    const response = await handle(
      new Request(
        `https://proof.test/v1/${fixture.namespace.chainId}/${fixture.namespace.pool}/draws`,
        { headers: { origin: "https://app.kettigo.test" } },
      ),
      { ...fixture.env, DEPLOYMENT_BLOCK: "2" },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ outcome: "HISTORY_UNAVAILABLE" });
  });

  it("enforces the documented 60-request window and isolate-wide concurrency of eight", async () => {
    const fixture = await seeded();
    rpc(fixture);
    const url = `https://proof.test/v1/${fixture.namespace.chainId}/${fixture.namespace.pool}/draws`;
    for (let index = 0; index < 60; index += 1)
      expect(
        (
          await handle(
            new Request(url, { headers: { "cf-connecting-ip": "rate-client" } }),
            fixture.env,
          )
        ).status,
      ).toBe(200);
    const rateLimited = await handle(
      new Request(url, { headers: { "cf-connecting-ip": "rate-client" } }),
      fixture.env,
    );
    expect(rateLimited.status).toBe(429);

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    rpc(fixture, { hold: held });
    const requests = Array.from({ length: 8 }, (_, index) =>
      handle(
        new Request(url, { headers: { "cf-connecting-ip": `concurrent-${index}` } }),
        fixture.env,
      ),
    );
    await vi.waitFor(() =>
      expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(8),
    );
    const crowded = await handle(
      new Request(url, {
        headers: { "cf-connecting-ip": "concurrent-9", origin: "https://app.kettigo.test" },
      }),
      fixture.env,
    );
    expect(crowded.status).toBe(429);
    expect(crowded.headers.get("access-control-allow-origin")).toBe("https://app.kettigo.test");
    release();
    await Promise.all(requests);
  });
});
