const ACCESS_CACHE_KEY = "kettigo.access.v1";

type AccessStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type AccessCache = {
  approvedEmail?: string;
};

export function readCachedApprovedEmail(storage = getAccessStorage()): string | null {
  return readCache(storage).approvedEmail ?? null;
}

export function rememberApprovedEmail(email: string, storage = getAccessStorage()) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return;
  writeCache({ ...readCache(storage), approvedEmail: normalizedEmail }, storage);
}

export function hasCachedApprovedSession(storage = getAccessStorage()): boolean {
  return readCache(storage).approvedEmail !== undefined;
}

function readCache(storage: AccessStorage | null): AccessCache {
  if (!storage) return {};
  try {
    const raw = storage.getItem(ACCESS_CACHE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};

    const approvedEmail = typeof parsed.approvedEmail === "string" ? normalizeEmail(parsed.approvedEmail) : null;
    return approvedEmail ? { approvedEmail } : {};
  } catch {
    return {};
  }
}

function writeCache(cache: AccessCache, storage: AccessStorage | null) {
  if (!storage) return;
  try {
    storage.setItem(ACCESS_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // best-effort cache only
  }
}

function normalizeEmail(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  return normalized === "" ? null : normalized;
}

function getAccessStorage(): AccessStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
