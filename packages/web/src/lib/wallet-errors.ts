import { classifyPasskeyError } from "./passkey-webauthn.ts";

export type WalletFailureStatus =
  | "unsupported"
  | "cancelled"
  | "invalid-metadata"
  | "service-unavailable";

export type WalletFailure = {
  status: WalletFailureStatus;
  message: string;
};

export function getWalletError(error: unknown): WalletFailure {
  const passkeyKind = classifyPasskeyError(error);
  if (passkeyKind === "cancelled") {
    return { status: "cancelled", message: "Verification was cancelled. You can try again." };
  }
  if (passkeyKind === "unsupported") {
    return { status: "unsupported", message: "This browser or device cannot create your account." };
  }

  const details = collectMessages(error).join(" ");
  if (/invalid passkey metadata|saved account|does not match/i.test(details)) {
    return {
      status: "invalid-metadata",
      message: "Saved account details cannot be used. Creating another account will give you a different address.",
    };
  }
  if (/pimlico|bundler|paymaster|sponsored transaction/i.test(details)) {
    return {
      status: "service-unavailable",
      message: "Account service is unavailable right now. Try again.",
    };
  }
  return { status: "service-unavailable", message: "Could not open your account. Try again." };
}

export function getWalletErrorMessage(error: unknown): string {
  return getWalletError(error).message;
}

function collectMessages(error: unknown, messages: string[] = []): string[] {
  if (!error) return messages;
  if (error instanceof Error) {
    messages.push(error.message);
    collectMessages(error.cause, messages);
  } else if (typeof error === "object" && error !== null) {
    const value = error as { message?: unknown; cause?: unknown };
    if (typeof value.message === "string") messages.push(value.message);
    collectMessages(value.cause, messages);
  } else {
    messages.push(String(error));
  }
  return messages;
}
