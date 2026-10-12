"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { createPortal } from "react-dom";
import { useWallet } from "@/lib/wallet-context";
import { shortAddress } from "@/lib/format";
import { cn } from "@/lib/cn";

const NAV = [
  { href: "/", label: "Home" },
  { href: "/savings", label: "Save" },
  { href: "/draw", label: "Draw" },
];

export function Header() {
  const path = usePathname();
  const { session, connect, connecting, disconnect, passkeyReady, pimlicoReady, hasSavedAccount } = useWallet();
  const [accountSheetOpen, setAccountSheetOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const navItems = NAV;

  async function copyAddress() {
    if (!session) return;
    await navigator.clipboard.writeText(session.address);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_600);
  }

  async function signOut() {
    setAccountSheetOpen(false);
    await disconnect();
  }

  const accountSheet =
    session && accountSheetOpen && typeof document !== "undefined"
      ? createPortal(
          <div
            className="fixed inset-0 z-50 flex items-end justify-center bg-text/20 px-3 pb-3 backdrop-blur-sm"
            role="presentation"
            onClick={() => setAccountSheetOpen(false)}
          >
            <div
              className="glass-surface w-full max-w-[456px] rounded-[28px] p-4 shadow-2xl"
              role="dialog"
              aria-modal="true"
              aria-label="Account"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-text/20" />
              <div className="space-y-3">
                <div className="rounded-3xl border border-white/55 bg-white/35 p-4">
                  <p className="font-display text-sm font-semibold text-text">Account</p>
                  <p className="mt-2 break-all font-mono text-xs leading-relaxed text-muted">
                    {session.address}
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    className="btn-secondary !px-3 !py-3 !text-sm"
                    onClick={() => void copyAddress()}
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                  <button
                    type="button"
                    className="btn-primary !px-3 !py-3 !text-sm"
                    onClick={() => void signOut()}
                  >
                    Log out
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )
      : null;

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-white/40 bg-white/30 backdrop-blur-2xl">
        <div className="flex items-center justify-between px-5 h-16">
          <Link href="/" className="flex items-center gap-2">
            <Image
              src="/kettigo-mark-header.svg"
              alt="Kettigo"
              width={32}
              height={32}
              className="h-8 w-8 rounded-xl shadow-lg shadow-black/10"
              priority
            />
            <span className="font-display font-semibold tracking-tight text-lg">Kettigo</span>
          </Link>

          {session ? (
            <button
              type="button"
              onClick={() => setAccountSheetOpen(true)}
              className="flex items-center gap-2 rounded-full bg-white/35 border border-white/60 px-3 py-1.5 hover:bg-white/55 transition-colors backdrop-blur-xl"
              title={session.address}
              aria-haspopup="dialog"
              aria-expanded={accountSheetOpen}
            >
              <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
              <span className="text-xs font-medium">
                {shortAddress(session.address)}
              </span>
            </button>
          ) : (
            <button
              onClick={() => void connect()}
              disabled={connecting || !passkeyReady || !pimlicoReady}
              className="btn-secondary !py-2 !px-4 !text-sm"
            >
              {connecting ? "Opening..." : hasSavedAccount ? "Open account" : "Create account"}
            </button>
          )}
        </div>

        <nav className="flex gap-2 px-3 pb-3 overflow-x-auto">
          {navItems.map((item) => {
            const active = path === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "px-3 py-1.5 rounded-full text-sm font-medium transition-colors whitespace-nowrap",
                  "font-display",
                  active
                    ? "bg-citron text-text shadow-lg shadow-black/10"
                    : "border border-white/25 bg-white/10 text-white/90 hover:bg-white/20 hover:text-white"
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>
      {accountSheet}
    </>
  );
}
