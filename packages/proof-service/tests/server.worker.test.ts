import { env as workerEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { branchHash, leafHash } from "../src/domain.ts";
import { handle, type Env } from "../src/server.ts";
import worker from "../src/worker.ts";

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

describe("proof HTTP boundary", () => {
  it("returns an allowlisted CORS preflight and keeps disallowed origins opaque", async () => {
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
  });
  it("does not initialize an archive from a GET request", async () => {
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
  it("rejects non-canonical chain, draw, cursor and page values", async () => {
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
  it("only permits authenticated POST tick requests", async () => {
    const ctx = { waitUntil: () => undefined } as unknown as ExecutionContext;
    const get = await worker.fetch(
      new Request("https://proof.test/internal/tick", { headers: { authorization: "Bearer x" } }),
      { ...config, OPERATOR_BEARER: "x" },
      ctx,
    );
    expect(get.status).toBe(405);
    const forbidden = await worker.fetch(
      new Request("https://proof.test/internal/tick", { method: "POST" }),
      { ...config, OPERATOR_BEARER: "x" },
      ctx,
    );
    expect(forbidden.status).toBe(401);
    const oversized = await worker.fetch(
      new Request("https://proof.test/internal/tick", {
        method: "POST",
        headers: { authorization: "Bearer x", "content-length": "1025" },
      }),
      { ...config, OPERATOR_BEARER: "x" },
      ctx,
    );
    expect(oversized.status).toBe(413);
  });
});
