import {
  isValidEmail,
  normalizeEmail,
  readAccessStatus,
  registerWaitlistInterest,
} from "./worker/access";
import {
  runtimeConfigScript,
  type PublicRuntimeEnv,
} from "./worker/runtime-config-bootstrap";
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

    if (url.pathname === "/api/client-events") {
      return handleClientEvents(request);
    }

    if (url.pathname === "/config.js") {
      return new Response(
        runtimeConfigScript(env),
        {
          headers: {
            "content-type": "application/javascript; charset=utf-8",
            "cache-control": "no-store",
          },
        },
      );
    }

    if (url.pathname === "/api/waitlist" && request.method === "POST") {
      return handleWaitlist(request, env);
    }

    if (url.pathname === "/api/access/status" && request.method === "POST") {
      return handleAccessStatus(request, env);
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ ok: false, status: "invalid_request" }, 404);
    }

    const asset = await env.ASSETS.fetch(request);
    if (!asset.headers.get("content-type")?.toLowerCase().includes("text/html")) {
      return asset;
    }

    const bootstrap = runtimeConfigScript(env);
    return new HTMLRewriter()
      .on("head", {
        element(element) {
          element.prepend(`<script>${bootstrap}</script>`, { html: true });
        },
      })
      .transform(asset);
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const scheduledMinute = Math.floor(controller.scheduledTime / 60_000);
    if (scheduledMinute % 5 !== 0) {
      console.log(JSON.stringify({
        event: "keeper_dispatch",
        outcome: "skipped_off_cycle",
        cron: controller.cron,
        scheduledTime: controller.scheduledTime,
      }));
      return;
    }

    try {
      const status = await dispatchKeeperWorkflow(env.GITHUB_WORKFLOW_AUTH);
      console.log(JSON.stringify({ event: "keeper_dispatch", outcome: "accepted", status }));
    } catch (error) {
      console.error(JSON.stringify({
        event: "keeper_dispatch",
        outcome: "failed",
        error: error instanceof Error ? error.message : "Unknown error",
      }));
      throw error;
    }
  },
};

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
  if (!contentType.split(";").map((part) => part.trim()).includes("application/json")) {
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
