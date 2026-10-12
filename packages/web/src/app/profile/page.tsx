"use client";

import { useWallet } from "@/lib/wallet-context";
import { useUSDCBalance } from "@/lib/usePoolData";
import { formatUSDC, shortAddress } from "@/lib/format";
import { ConnectButton } from "@/components/ConnectButton";
import { LoadingAmount } from "@/components/LoadingAmount";
import { balanceBucketLabels } from "@/lib/withdrawal-state";

// Profile page for wallet status, account details, and balance summary.
export default function ProfilePage() {
  const {
    session,
    passkeyReady,
    pimlicoReady,
    disconnect,
    confidentialBalance,
    principal,
    confidentialBalancesLoading,
    confidentialBalancesError,
  } = useWallet();

  const { data: usdcData } = useUSDCBalance(session?.address);
  const usdcBalance = usdcData?.[0]?.result as bigint | undefined;

  if (!session) {
    return (
      <div className="space-y-4 animate-fade-in">
        <h1 className="font-display text-2xl font-bold">Account</h1>
        <div className="card text-center space-y-4">
          <p className="text-muted">Sign in to view your account.</p>
          <ConnectButton fullWidth />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 animate-fade-in">
      <h1 className="font-display text-2xl font-bold">Account</h1>

      <div className="card space-y-3">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-gradient-to-br from-brand to-brandHover grid place-items-center text-white font-bold text-lg">
            {shortAddress(session.address).slice(1, 3).toUpperCase()}
          </div>
          <div>
            <p className="text-sm text-muted">Smart account</p>
            <p className="font-mono text-sm">{shortAddress(session.address)}</p>
          </div>
        </div>
      </div>

      <div className="card space-y-2">
        <p className="label">Summary</p>
        <div className="flex justify-between text-sm">
          <span className="text-muted">{balanceBucketLabels.walletUsdc}</span>
          <span className="font-semibold tabular-nums">
            {formatUSDC(usdcBalance)} USDC
          </span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted">{balanceBucketLabels.prizeTokens}</span>
          <span className="font-semibold tabular-nums">
            {confidentialBalancesLoading ? <LoadingAmount /> : `${formatUSDC(confidentialBalance)} USDC`}
          </span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted">{balanceBucketLabels.savingsBalance}</span>
          <span className="font-semibold tabular-nums text-brand">
            {confidentialBalancesLoading ? <LoadingAmount /> : `${formatUSDC(principal)} USDC`}
          </span>
        </div>
        {confidentialBalancesError && <p className="text-xs text-danger">{confidentialBalancesError}</p>}
      </div>

      <div className="card space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-muted">Account access</span>
          <span>{passkeyReady ? "✓" : "—"}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted">Transaction fees</span>
          <span>{pimlicoReady ? "✓" : "—"}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted">Network</span>
          <span>Live</span>
        </div>
      </div>

      <button
        onClick={() => void disconnect()}
        className="btn-secondary w-full text-danger"
      >
        Sign out
      </button>
    </div>
  );
}
