import type { Env, WaitlistResponse } from "./types";
import { withSecurityHeaders } from "./security";
import { registerWaitlist } from "./waitlist";

const INVALID_REQUEST: WaitlistResponse = {
  ok: false,
  code: "invalid_request",
  message: "We could not accept this request.",
};
const TEMPORARILY_UNAVAILABLE: WaitlistResponse = {
  ok: false,
  code: "temporarily_unavailable",
  message: "Please try again in a moment.",
};

export default {
  scheduled(controller: ScheduledController, _env: Env, _context: ExecutionContext): void {
    console.warn(
      JSON.stringify({
        event: "stale_scheduled_trigger_ignored",
        cron: controller.cron,
        scheduledTime: controller.scheduledTime,
      }),
    );
  },

  async fetch(request: Request, env: Env, _context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }

    const response = await env.ASSETS.fetch(request);
    return withSecurityHeaders(response, "document");
  },

};

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const started = Date.now();
  const requestId = crypto.randomUUID();
  let outcome = "unhandled";

  try {
    let response: Response;
    if (url.pathname !== "/api/waitlist") {
      response = apiResponse(INVALID_REQUEST, 404);
    } else if (request.method !== "POST") {
      response = apiResponse(INVALID_REQUEST, 405, { allow: "POST" });
    } else if (!hasAllowedOrigin(request, url)) {
      response = apiResponse(INVALID_REQUEST, 403);
    } else {
      response = await registerWaitlist(request, env);
    }

    outcome = `${response.status}`;
    return withSecurityHeaders(response, "api");
  } catch {
    outcome = "error";
    return withSecurityHeaders(apiResponse(TEMPORARILY_UNAVAILABLE, 503), "api");
  } finally {
    console.log(
      JSON.stringify({
        requestId,
        outcome,
        durationMs: Date.now() - started,
      }),
    );
  }
}

function hasAllowedOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null) {
    return origin === url.origin;
  }
  return request.headers.get("sec-fetch-site") === null;
}

function apiResponse(body: WaitlistResponse, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      ...headers,
    },
  });
}
