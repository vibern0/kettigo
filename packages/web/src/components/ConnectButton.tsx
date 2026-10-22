"use client";

import { useWallet } from "@/lib/wallet-context";
import { shortAddress } from "@/lib/format";

export function ConnectButton({ fullWidth = false }: { fullWidth?: boolean }) {
  const {
    session,
    connect,
    connecting,
    error,
    status,
    hasSavedAccount,
    passkeyReady,
    pimlicoReady,
  } = useWallet();

  if (session) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <span className="h-2 w-2 rounded-full bg-success" />
        <span>Account active: {shortAddress(session.address)}</span>
      </div>
    );
  }

  const label = status === "awaiting-verification"
    ? "Confirm on your device..."
    : status === "creating" || status === "checking"
      ? "Opening account..."
      : status === "invalid-metadata"
        ? "Create a new account"
        : hasSavedAccount
          ? "Open account"
          : "Create account";
  const unavailable = !passkeyReady || !pimlicoReady;

  return (
    <div className="space-y-2">
      <button
        onClick={() => void connect()}
        disabled={connecting || unavailable}
        className={`btn-primary ${fullWidth ? "w-full" : ""}`}
      >
        {connecting && <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />}
        {label}
      </button>
      {error && <p className="text-sm text-danger">{error}</p>}
      {!passkeyReady && <p className="text-xs text-warning">Account access is unavailable on this device.</p>}
      {passkeyReady && !pimlicoReady && (
        <p className="text-xs text-warning">Transaction fee coverage is unavailable right now.</p>
      )}
    </div>
  );
}
