"use client";

import Link from "next/link";
import { ConnectButton } from "@/components/ConnectButton";
import { LoadingAmount } from "@/components/LoadingAmount";
import { useUSDCBalance } from "@/lib/usePoolData";
import { useWallet } from "@/lib/wallet-context";
import { formatUSDC } from "@/lib/format";
import { balanceBucketLabels } from "@/lib/withdrawal-state";

// Home page summary for the active draw, account balances, and next action.
export default function HomePage() {
  const {
    session,
    principal,
    confidentialBalancesLoading,
    confidentialBalancesError,
  } = useWallet();
  const { data: usdcData } = useUSDCBalance(session?.address);
  const usdcBalance = usdcData?.[0]?.result as bigint | undefined;

  return (
    <div className="space-y-6">
      {/* Hero */}
      <section className="space-y-3">
        <h1 className="font-display text-4xl font-bold leading-tight tracking-tight">
          Play for prizes.
          <br />
          Keep your deposit.
        </h1>
        <p className="text-muted leading-relaxed">
          Your deposit is your entry.
        </p>
      </section>

      {/* Balance (if connected) */}
      {session && (
        <section className="card space-y-3">
          <p className="label">Your account</p>
          <div className="flex items-baseline justify-between">
            <span className="text-muted">{balanceBucketLabels.walletUsdc}</span>
            <span className="font-semibold tabular-nums text-text">
              {formatUSDC(usdcBalance)} USDC
            </span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-muted">{balanceBucketLabels.savingsBalance}</span>
            <span className="font-semibold tabular-nums text-text">
              {confidentialBalancesLoading ? <LoadingAmount /> : `${formatUSDC(principal)} USDC`}
            </span>
          </div>
          {confidentialBalancesError && <p className="text-xs text-danger">{confidentialBalancesError}</p>}
          <Link href="/savings" className="btn-primary w-full">
            Deposit / Withdraw
          </Link>
        </section>
      )}

      {/* Connect */}
      {!session && (
        <section className="card space-y-4">
          <p className="label">Get started</p>
          <p className="text-muted text-sm">
            Create an account with your device. No passwords, extensions, or hidden fees.
          </p>
          <ConnectButton fullWidth />
        </section>
      )}

      {/* How it works */}
      <section className="space-y-3">
        <p className="label">How it works</p>
        <ol className="space-y-3">
          {[
            { n: 1, t: "Deposit USDC", d: "Add savings when you are ready. Your balance remains the base for prize eligibility." },
            { n: 2, t: "Stay eligible", d: "Your balance when the winner is selected sets your chances." },
            { n: 3, t: "Check and claim", d: "Check your result. If you’ve won, claim your winnings or keep playing." },
          ].map((s) => (
            <li key={s.n} className="flex gap-3 card !p-4">
              <div className={`w-8 h-8 rounded-xl font-bold grid place-items-center flex-shrink-0 ${s.n % 2 === 0 ? "accent-cyan" : "accent-rose"}`}>
                {s.n}
              </div>
              <div>
                <p className="font-display font-semibold">{s.t}</p>
                <p className="text-sm text-muted">{s.d}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <p className="text-xs text-muted text-center pt-4">
        Keep playing. Your deposit stays yours.{" "}
        <Link href="/draw" className="text-brand hover:underline">
          View results
        </Link>
      </p>
    </div>
  );
}
