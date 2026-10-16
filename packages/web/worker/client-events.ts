// Public browser ingestion credentials; this endpoint never accepts a target URL.
const DSN = "https://1wUDLFc7g8tpcchuQ2CXZTyJ@s2796372.us-west-2a.betterstackdata.com/2796373";
const INGESTION = "https://s2796372.us-west-2a.betterstackdata.com/api/2796373/envelope/?sentry_key=1wUDLFc7g8tpcchuQ2CXZTyJ&sentry_version=7";
const MAX_ENVELOPE_BYTES = 65_536;

export async function handleClientEvents(request: Request, forward: typeof fetch = fetch): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  if (request.method !== "POST") return new Response(null, { status: 405, headers });
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return new Response(null, { status: 403, headers });
  }
  if (!request.body) return new Response(null, { status: 400, headers });

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ENVELOPE_BYTES) {
        await reader.cancel();
        return new Response(null, { status: 413, headers });
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    const envelope = JSON.parse(body.split("\n", 1)[0]);
    if (envelope.dsn !== DSN) return new Response(null, { status: 400, headers });
  } catch {
    return new Response(null, { status: 400, headers });
  } finally {
    reader.releaseLock();
  }

  try {
    const upstream = await forward(INGESTION, {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    // Do not forward browser cookies or upstream response headers.
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch {
    return new Response(null, { status: 502, headers });
  }
}
