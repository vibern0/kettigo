import {
  isValidEmail,
  normalizeEmail,
  readAccessStatus,
  registerWaitlistInterest,
} from "./worker/access";
import { runtimeConfigScript, type PublicRuntimeEnv } from "./worker/runtime-config-bootstrap";
import { resolveSelectedPoolScope } from "./worker/selected-pool-scope";
import { dispatchKeeperWorkflow } from "./worker/github-keeper-dispatch";
import { handleClientEvents } from "./worker/client-events";

type D1StatementLike = {
  bind(...values: unknown[]): D1StatementLike;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<unknown>;
};

type Env = PublicRuntimeEnv & {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  DB: {
    prepare(sql: string): D1StatementLike;
  };
  GITHUB_WORKFLOW_AUTH: string;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const routeResponse = await handleRequestRoute(request, url, env);
    return routeResponse ?? handleAssetRoute(request, url, env);
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const scheduledMinute = Math.floor(controller.scheduledTime / 60_000);
    if (scheduledMinute % 5 !== 0) {
      console.log(
        JSON.stringify({
          event: "keeper_dispatch",
          outcome: "skipped_off_cycle",
          cron: controller.cron,
          scheduledTime: controller.scheduledTime,
        }),
      );
      return;
    }

    try {
      const status = await dispatchKeeperWorkflow(env.GITHUB_WORKFLOW_AUTH);
      console.log(JSON.stringify({ event: "keeper_dispatch", outcome: "accepted", status }));
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "keeper_dispatch",
          outcome: "failed",
          error: error instanceof Error ? error.message : "Unknown error",
        }),
      );
      throw error;
    }
  },
};

async function handleRequestRoute(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response | undefined> {
  if (url.pathname === "/api/client-events") return handleClientEvents(request);
  if (url.pathname === "/config.js") return runtimeConfigResponse(url, env);
  if (url.pathname === "/api/waitlist" && request.method === "POST")
    return handleWaitlist(request, env);
  if (url.pathname === "/api/access/status" && request.method === "POST")
    return handleAccessStatus(request, env);
  return url.pathname.startsWith("/api/")
    ? json({ ok: false, status: "invalid_request" }, 404)
    : undefined;
}

function runtimeConfigResponse(url: URL, env: Env): Response {
  const selection = resolveSelectedPoolScope(url, env);
  if (!selection.ok) return invalidSavingsScope(selection.code);
  return new Response(runtimeConfigScript(env, selection.scope), {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function handleAssetRoute(request: Request, url: URL, env: Env): Promise<Response> {
  const scopedSelection = isScopeHtmlPath(url.pathname)
    ? resolveSelectedPoolScope(url, env)
    : undefined;
  if (scopedSelection && !scopedSelection.ok) return invalidSavingsScope(scopedSelection.code);

  const asset = await env.ASSETS.fetch(assetRequest(request));
  if (!asset.headers.get("content-type")?.toLowerCase().includes("text/html")) return asset;

  const selection = scopedSelection ?? resolveSelectedPoolScope(url, env);
  if (!selection.ok) return invalidSavingsScope(selection.code);
  const bootstrap = runtimeConfigScript(env, selection.scope);
  const rewritten = new HTMLRewriter()
    .on("head", {
      element(element) {
        element.prepend(`<script>${bootstrap}</script>`, { html: true });
      },
    })
    .transform(asset);
  return rewrittenHtml(rewritten);
}

async function handleWaitlist(request: Request, env: Env): Promise<Response> {
  try {
    const body = await readJsonBody(request);
    const email = typeof body.email === "string" ? body.email : "";
    const normalized = normalizeEmail(email);
    if (!isValidEmail(normalized)) {
      return json({ ok: false, status: "invalid_request" }, 400);
    }
    return json(await registerWaitlistInterest(env.DB, normalized), 200);
  } catch {
    return json({ ok: false, status: "temporarily_unavailable" }, 503);
  }
}

async function handleAccessStatus(request: Request, env: Env): Promise<Response> {
  try {
    const body = await readJsonBody(request);
    const email = typeof body.email === "string" ? body.email : "";
    const result = await readAccessStatus(env.DB, email);
    return json(result, result.status === "invalid_request" ? 400 : 200);
  } catch {
    return json({ ok: false, status: "temporarily_unavailable" }, 503);
  }
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (
    !contentType
      .split(";")
      .map((part) => part.trim())
      .includes("application/json")
  ) {
    throw new Error("invalid_content_type");
  }
  const parsed = await request.json();
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("invalid_body");
  }
  return parsed as Record<string, unknown>;
}

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function invalidSavingsScope(
  code: "invalid_savings_scope" | "unavailable_savings_scope",
): Response {
  return new Response("Savings selection is unavailable.", {
    status: 400,
    headers: { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" },
  });
}

function rewrittenHtml(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  for (const name of [
    "content-length",
    "etag",
    "digest",
    "content-digest",
    "content-md5",
    "integrity",
  ])
    headers.delete(name);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function assetRequest(request: Request): Request {
  if (!isScopeHtmlPath(new URL(request.url).pathname)) return request;
  const headers = new Headers(request.headers);
  headers.delete("if-none-match");
  headers.delete("if-modified-since");
  return new Request(request, { headers });
}

function isScopeHtmlPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/draw" ||
    pathname === "/draw/" ||
    pathname === "/profile" ||
    pathname === "/profile/" ||
    pathname === "/savings" ||
    pathname === "/savings/"
  );
}
