import * as Sentry from "@sentry/browser";

let initialized = false;

function redact(value: string) {
  return value.replace(/https?:\/\/[^\s)]+/gi, "[redacted-url]")
    .replace(/0x[0-9a-f]{16,}/gi, "[redacted]")
    .replace(/Request body:[^\n]*/gi, "Request body: [redacted]");
}

function passkeyDiagnostics(error: unknown): Record<string, string> | undefined {
  if (!error || typeof error !== "object") return undefined;
  const source = (error as { passkeyDiagnostics?: Record<string, unknown> }).passkeyDiagnostics;
  if (!source || typeof source !== "object") return undefined;
  const result: Record<string, string> = {};
  for (const key of [
    "verifierGas", "bundlerVerificationGas", "requestedVerificationGas", "sponsoredVerificationGas",
    "submittedVerificationGas", "submittedCallGas", "submittedPreVerificationGas",
    "submittedMaxFeePerGas", "submittedMaxPriorityFeePerGas",
  ]) {
    const value = source[key];
    if (typeof value === "string" && /^\d{1,40}$/.test(value)) result[key] = value;
  }
  if (typeof source.phase === "string" && ["estimation", "sponsorship", "signing", "submission", "receipt"].includes(source.phase)) result.phase = source.phase;
  if (source.verifierProbe === "measured" || source.verifierProbe === "fallback") result.verifierProbe = source.verifierProbe;
  if (typeof source.aaCode === "string" && /^AA\d{2}$/.test(source.aaCode)) result.aaCode = source.aaCode;
  return Object.keys(result).length ? result : undefined;
}

export function initializeClientErrors() {
  if (initialized || typeof window === "undefined") return;
  Sentry.init({
    // Browser ingestion DSN, not an account API credential.
    dsn: "https://1wUDLFc7g8tpcchuQ2CXZTyJ@s2796372.us-west-2a.betterstackdata.com/2796373",
    // Brave blocks direct ingestion. Forward through our Worker instead.
    tunnel: "/api/client-events",
    // Every failed retry matters, even when its stack matches the last attempt.
    integrations: (defaults) => defaults.filter((integration) => integration.name !== "Dedupe"),
    environment: "production",
    beforeSend(event) {
      // RPC exceptions can contain calldata, keys in URLs, and account amounts.
      delete event.request;
      delete event.user;
      delete event.extra;
      delete event.breadcrumbs;
      for (const exception of event.exception?.values ?? []) {
        if (exception.value) exception.value = redact(exception.value);
      }
      return event;
    },
  });
  initialized = true;
}

export function reportClientError(error: unknown, context: { action: string; stage: string }) {
  try {
    initializeClientErrors();
    const reported = new Error(redact(error instanceof Error ? error.message : String(error)));
    reported.name = error instanceof Error ? error.name : "Error";
    if (error instanceof Error && error.stack) {
      const frames = error.stack.split("\n").slice(1).map((line) =>
        line.replace(/https?:\/\/[^\s)]+/gi, (url) =>
          /^https:\/\/app\.kettigo\.xyz\/_next\/static\//i.test(url)
            ? url.replace(/[?#].*/, "")
            : "[redacted-url]",
        ),
      );
      reported.stack = `${reported.name}: ${reported.message}\n${frames.join("\n")}`;
    }
    const diagnostics = passkeyDiagnostics(error);
    Sentry.captureException(reported, {
      tags: context,
      ...(diagnostics ? { contexts: { passkey_operation: diagnostics } } : {}),
    });
  } catch {
    // Reporting must not interrupt the retry path or hide the original error.
  }
}

export function reportClientToast(
  toast: { title: string; description?: string },
  context: { action: string; stage: string },
  cause?: unknown,
) {
  const toastMessage = [toast.title, toast.description].filter(Boolean).join(": ");
  const error = cause instanceof Error
    ? cause
    : cause === undefined
      ? new Error(toastMessage)
      : new Error(`${toastMessage}: ${String(cause)}`);
  reportClientError(error, context);
}
