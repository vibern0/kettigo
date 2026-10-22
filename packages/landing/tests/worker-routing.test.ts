import { describe, expect, it, vi } from "vitest";
import { makeContext, makeEnv } from "./helpers";
import worker from "../worker/index";

describe("Worker routing", () => {
  it("ignores accidental scheduled events without enqueueing work", () => {
    const waitUntil = vi.fn();
    const context = { waitUntil } as unknown as ExecutionContext;
    const controller = {
      cron: "* * * * *",
      noRetry: vi.fn(),
      scheduledTime: Date.UTC(2026, 9, 9, 12, 3),
    } as unknown as ScheduledController;

    worker.scheduled(controller, makeEnv(), context);

    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("rejects cross-origin API submissions", async () => {
    const response = await worker.fetch(
      new Request("https://kettigo.com/api/waitlist", {
        method: "POST",
        headers: { origin: "https://evil.example", "content-type": "application/json" },
        body: "{}",
      }),
      makeEnv(),
      makeContext(),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 405 for GET on the waitlist endpoint", async () => {
    const response = await worker.fetch(new Request("https://kettigo.com/api/waitlist"), makeEnv(), makeContext());

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns JSON 404 for unknown API routes", async () => {
    const response = await worker.fetch(new Request("https://kettigo.com/api/nope"), makeEnv(), makeContext());

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: false,
      code: "invalid_request",
      message: "We could not accept this request.",
    });
  });

  it("delegates pages to Assets and applies document headers", async () => {
    const assets = vi.fn(async () => new Response("<html></html>", { headers: { "content-type": "text/html" } }));

    const response = await worker.fetch(new Request("https://kettigo.com/"), makeEnv(assets), makeContext());

    expect(assets).toHaveBeenCalledOnce();
    expect(response.headers.get("content-security-policy")).toContain("challenges.cloudflare.com");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
  });
});
