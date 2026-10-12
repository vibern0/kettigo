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
    <div className="space-y-6 animate-fade-in">
      {/* Hero */}
      <section className="space-y-3">
        <h1 className="font-display text-4xl font-bold leading-tight tracking-tight">
          Your savings,
          <br />
          with a chance to win.
        </h1>
        <p className="text-muted leading-relaxed">
          Put your money to work. Get tickets for a weekly draw. Your principal
          stays available whenever you want to withdraw.
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
            { n: 1, t: "Deposit", d: "USDC enters savings and stays available at any time." },
            { n: 2, t: "Get tickets", d: "Each USDC counts as one ticket for the weekly draw." },
            { n: 3, t: "Win without losing", d: "The prize comes from yield. Your principal always returns." },
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
        Save, stay flexible, and check each draw for prizes.{" "}
        <Link href="/draw" className="text-brand hover:underline">
          View next draw
        </Link>
      </p>
    </div>
  );
}
