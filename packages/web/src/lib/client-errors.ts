import * as Sentry from "@sentry/browser";

let initialized = false;

function redact(value: string) {
  return value.replace(/https?:\/\/[^\s)]+/gi, "[redacted-url]")
    .replace(/0x[0-9a-f]{16,}/gi, "[redacted]")
    .replace(/Request body:[^\n]*/gi, "Request body: [redacted]");
}

export function initializeClientErrors() {
  if (initialized || typeof window === "undefined") return;
  Sentry.init({
    // Browser ingestion DSN, not an account API credential.
    dsn: "https://1wUDLFc7g8tpcchuQ2CXZTyJ@s2796372.us-west-2a.betterstackdata.com/2796373",
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
    Sentry.captureException(reported, { tags: context });
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
