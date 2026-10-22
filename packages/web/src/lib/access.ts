export type WaitlistResult =
  | { ok: true; status: "joined" | "already_joined" }
  | { ok: false; status: "invalid_request" | "temporarily_unavailable" };

export type AccessStatus =
  | { ok: true; status: "approved" }
  | { ok: false; status: "pending" | "invalid_request" | "temporarily_unavailable" };

export async function joinWaitlist(email: string, fetcher: typeof fetch = fetch): Promise<WaitlistResult> {
  return postJson<WaitlistResult>("/api/waitlist", { email }, fetcher, {
    ok: false,
    status: "temporarily_unavailable",
  });
}

export async function checkAccess(email: string, fetcher: typeof fetch = fetch): Promise<AccessStatus> {
  return postJson<AccessStatus>("/api/access/status", { email }, fetcher, {
    ok: false,
    status: "temporarily_unavailable",
  });
}

async function postJson<T>(
  url: string,
  payload: unknown,
  fetcher: typeof fetch,
  fallback: T,
): Promise<T> {
  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const parsed = await response.json();
    return isRecord(parsed) && typeof parsed.ok === "boolean" && typeof parsed.status === "string"
      ? (parsed as T)
      : fallback;
  } catch {
    return fallback;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
