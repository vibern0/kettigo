import { env as workerEnv } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { branchHash, leafHash } from "../src/domain.ts";
import { handle, type Env } from "../src/server.ts";
import { handleInternalTick, default as worker } from "../src/worker.ts";

const zero = `0x${"00".repeat(32)}`;
const pool = "0x00000000000000000000000000000000000000A1";
const leaf = leafHash("0x0000000000000000000000000000000000000000", "0", zero);
const config = {
  PROOF_DB: (workerEnv as unknown as { PROOF_DB: D1Database }).PROOF_DB,
  CHAIN_ID: "11155111",
  POOL_ADDRESS: pool,
  TREE_DEPTH: "1",
  ZERO_HANDLE: zero,
  EMPTY_HASHES_JSON: JSON.stringify([
    leaf,
    branchHash({ hash: leaf, sum: zero }, { hash: leaf, sum: zero }),
  ]),
  DEPLOYMENT_BLOCK: "1",
} as Env;

afterEach(() => vi.unstubAllGlobals());

function expectOperatorResponse(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
}

describe("proof HTTP boundary", () => {
  it(
    "returns an allowlisted CORS preflight and keeps disallowed origins opaque",
    { timeout: 5000 },
    async () => {
      expect.hasAssertions();
      const allowed = { ...config, ALLOWED_ORIGINS: "https://app.kettigo.test" };
      const response = await handle(
        new Request(`https://proof.test/v1/11155111/${pool}/draws`, {
          method: "OPTIONS",
          headers: { origin: "https://app.kettigo.test" },
        }),
        allowed,
      );
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("https://app.kettigo.test");
      expect(response.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
      const rejected = await handle(
        new Request(`https://proof.test/v1/11155111/${pool}/draws`, {
          method: "OPTIONS",
          headers: { origin: "https://other.test" },
        }),
        allowed,
      );
      expect(rejected.headers.get("access-control-allow-origin")).toBeNull();
    },
  );
  it("does not initialize an archive from a GET request", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const response = await handle(
      new Request(`https://proof.test/v1/11155111/${pool}/draws`, {
        headers: { origin: "https://app.kettigo.test" },
      }),
      { ...config, ALLOWED_ORIGINS: "https://app.kettigo.test" },
    );
    expect(response.status).toBe(409);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.kettigo.test");
    expect(await response.json()).toEqual({ outcome: "HISTORY_UNAVAILABLE" });
  });
  it("rejects malformed list queries before opening a D1 session", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const response = await handle(
      new Request(`https://proof.test/v1/11155111/${pool}/draws?limit=0`),
      { ...config, PROOF_DB: undefined as unknown as D1Database },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ outcome: "HISTORY_UNAVAILABLE" });
  });
  it("rejects non-canonical chain, draw, cursor and page values", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    for (const suffix of [
      `/v1/011155111/${pool}/draws`,
      `/v1/11155111/${pool}/draws/01/proof/${pool}`,
      `/v1/11155111/${pool}/draws/${"9".repeat(79)}/proof/${pool}`,
      `/v1/11155111/${pool}/draws?cursor=01`,
      `/v1/11155111/${pool}/draws?limit=101`,
    ]) {
      const response = await handle(new Request(`https://proof.test${suffix}`), config);
      expect([400, 404, 409]).toContain(response.status);
    }
  });
  it("only permits authenticated POST tick requests", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const ctx = { waitUntil: () => undefined } as unknown as ExecutionContext;
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const options = await worker.fetch(
      new Request("https://proof.test/internal/tick", {
        method: "OPTIONS",
        headers: { authorization: "Bearer x" },
      }),
      { ...config, OPERATOR_BEARER: "x" },
      ctx,
    );
    expectOperatorResponse(options, 405);
    expect(fetch).not.toHaveBeenCalled();
    const get = await worker.fetch(
      new Request("https://proof.test/internal/tick", { headers: { authorization: "Bearer x" } }),
      { ...config, OPERATOR_BEARER: "x" },
      ctx,
    );
    expectOperatorResponse(get, 405);
    const forbidden = await worker.fetch(
      new Request("https://proof.test/internal/tick", { method: "POST" }),
      { ...config, OPERATOR_BEARER: "x" },
      ctx,
    );
    expectOperatorResponse(forbidden, 401);
    const oversized = await worker.fetch(
      new Request("https://proof.test/internal/tick", {
        method: "POST",
        headers: { authorization: "Bearer x", "content-length": "1025" },
      }),
      { ...config, OPERATOR_BEARER: "x" },
      ctx,
    );
    expectOperatorResponse(oversized, 413);

    const streamed = await worker.fetch(
      new Request("https://proof.test/internal/tick", {
        method: "POST",
        headers: { authorization: "Bearer x" },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1025));
            controller.close();
          },
        }),
      }),
      { ...config, OPERATOR_BEARER: "x" },
      ctx,
    );
    expectOperatorResponse(streamed, 413);
  });
  it(
    "rejects an unauthorized dripped request without reading its body",
    { timeout: 5000 },
    async () => {
      expect.hasAssertions();
      let bodyReads = 0;
      const request = {
        url: "https://proof.test/internal/tick",
        method: "POST",
        headers: new Headers({ authorization: "Bearer wrong" }),
        get body() {
          bodyReads += 1;
          return new ReadableStream({
            pull() {
              return new Promise<void>(() => undefined);
            },
          });
        },
      } as unknown as Request;
      const response = await Promise.race([
        worker.fetch(request, { ...config, OPERATOR_BEARER: "x" }, {
          waitUntil: () => undefined,
        } as unknown as ExecutionContext),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 25)),
      ]);
      expect(response).not.toBe("timeout");
      expect((response as Response).status).toBe(401);
      expect((response as Response).headers.get("cache-control")).toBe("no-store");
      expect(bodyReads).toBe(0);
    },
  );
  it(
    "times out and cancels an authenticated body without starting provider work",
    { timeout: 5000 },
    async () => {
      expect.hasAssertions();
      let reads = 0;
      let cancellations = 0;
      const reader = {
        read() {
          reads += 1;
          return new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined);
        },
        cancel() {
          cancellations += 1;
          return new Promise<void>(() => undefined);
        },
      } as unknown as ReadableStreamDefaultReader<Uint8Array>;
      const request = {
        url: "https://proof.test/internal/tick",
        method: "POST",
        headers: new Headers({ authorization: "Bearer x" }),
        body: { getReader: () => reader },
      } as unknown as Request;
      const provider = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
      vi.stubGlobal("fetch", provider);

      const response = await handleInternalTick(request, { ...config, OPERATOR_BEARER: "x" }, 25);

      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(reads).toBe(1);
      expect(cancellations).toBe(1);
      expect(provider).not.toHaveBeenCalled();
    },
  );
  it(
    "does not start a tick when the deadline expires as the body finishes",
    { timeout: 5000 },
    async () => {
      expect.hasAssertions();
      let deadline: () => void = () => undefined;
      vi.stubGlobal("setTimeout", (callback: TimerHandler) => {
        deadline = callback as () => void;
        return 1;
      });
      vi.stubGlobal("clearTimeout", () => undefined);
      const request = {
        url: "https://proof.test/internal/tick",
        method: "POST",
        headers: new Headers({ authorization: "Bearer x" }),
        body: {
          getReader: () => ({
            read: () =>
              new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
                queueMicrotask(() => {
                  resolve({ done: true, value: undefined });
                  queueMicrotask(deadline);
                });
              }),
            cancel: () => Promise.resolve(),
          }),
        },
      } as unknown as Request;
      const provider = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
      vi.stubGlobal("fetch", provider);

      const response = await handleInternalTick(
        request,
        {
          ...config,
          POOL_ADDRESS: "0x00000000000000000000000000000000000000A3",
          OPERATOR_BEARER: "x",
          PRIMARY_RPC_URL: "https://primary.test",
          HISTORICAL_RPC_URL: "https://historical.test",
        },
        25,
      );

      expectOperatorResponse(response, 503);
      expect(provider).not.toHaveBeenCalled();
    },
  );
  it(
    "returns the actual post-tick checkpoint without storing the result",
    { timeout: 5000 },
    async () => {
      expect.hasAssertions();
      const calls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: RequestInit) => {
          const method = JSON.parse(String(init.body)).method;
          calls.push(method);
          if (method === "eth_chainId")
            return Response.json({ jsonrpc: "2.0", id: 1, result: "0xaa36a7" });
          if (method === "eth_blockNumber")
            return Response.json({ jsonrpc: "2.0", id: 1, result: "0x0" });
          if (method === "eth_getBlockByNumber") {
            const number = JSON.parse(String(init.body)).params[0];
            return Response.json({
              jsonrpc: "2.0",
              id: 1,
              result: { number, hash: zero, parentHash: zero },
            });
          }
          throw new Error(`unexpected ${method}`);
        }),
      );
      const response = await worker.fetch(
        new Request("https://proof.test/internal/tick", {
          method: "POST",
          headers: { authorization: "Bearer x" },
          body: "",
        }),
        {
          ...config,
          POOL_ADDRESS: "0x00000000000000000000000000000000000000A2",
          OPERATOR_BEARER: "x",
          PRIMARY_RPC_URL: "https://primary.test",
          HISTORICAL_RPC_URL: "https://historical.test",
        },
        { waitUntil: () => undefined } as unknown as ExecutionContext,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ nextBlock: 1, lastFinalizedBlock: 0 });
      expect(calls).toContain("eth_chainId");
    },
  );
});
