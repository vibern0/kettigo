"use client";

import { FormEvent, ReactNode, useEffect, useState } from "react";
import { checkAccess, joinWaitlist } from "@/lib/access";
import {
  hasCachedApprovedSession,
  rememberApprovedEmail,
} from "@/lib/access-cache";

type GateState = "checking" | "approved" | "email" | "pending" | "error";

export function AccessGate({ children }: { children: ReactNode }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<string>("Enter your email to check whether your access is ready.");
  const [submitting, setSubmitting] = useState(false);
  const [gateState, setGateState] = useState<GateState>("checking");

  useEffect(() => {
    setGateState(hasCachedApprovedSession() ? "approved" : "email");
  }, []);

  async function submitEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (email.trim() === "" || submitting) return;
    setSubmitting(true);
    setStatus("Checking access...");
    try {
      const access = await checkAccess(email);
      if (access.ok) {
        const normalizedEmail = email.trim().toLowerCase();
        rememberApprovedEmail(normalizedEmail);
        setGateState("approved");
        return;
      }

      const result = await joinWaitlist(email);
      if (result.ok) {
        setGateState("pending");
        setStatus("You're on the list. We'll let you know when your access opens.");
        return;
      }
      setGateState("error");
      setStatus("We could not join the waitlist right now. Please try again.");
    } catch {
      setGateState("error");
      setStatus("We could not check your access right now. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (gateState === "approved") {
    return <>{children}</>;
  }

  if (gateState === "checking") {
    return (
      <main
        aria-busy="true"
        className="min-h-[100svh] md:min-h-[calc(100vh-48px)]"
      >
        <span className="sr-only">Checking your session...</span>
      </main>
    );
  }

  return (
    <main className="relative mx-auto flex min-h-[100svh] w-full max-w-5xl flex-col justify-start overflow-hidden px-5 pb-8 pt-7 md:min-h-[calc(100vh-48px)] md:justify-center md:px-8 md:py-8">
      <div className="pointer-events-none absolute right-[-5rem] top-10 h-52 w-52 rounded-full border-[30px] border-[var(--peach)] opacity-70" />
      <div className="pointer-events-none absolute bottom-8 left-[-4rem] h-44 w-44 rotate-[-12deg] rounded-[42%_58%_52%_48%] bg-[var(--lilac)] opacity-60" />

      <div className="relative grid gap-6 md:grid-cols-[1.05fr_0.95fr] md:items-center">
        <section className="space-y-5">
          <div className="inline-flex rounded-full border border-[var(--cobalt-dark)] bg-[var(--citron)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em]">
            Early access
          </div>
          <div className="space-y-4">
            <h1 className="font-display text-4xl font-bold leading-[0.95] tracking-tight md:text-6xl">
              Your savings, with a chance to win.
            </h1>
            <p className="max-w-xl text-base leading-relaxed text-muted md:text-lg">
              Kettigo is opening gradually. Check your email first, then create or open your account when access
              is ready.
            </p>
          </div>
        </section>

        <section className="glass-surface space-y-5 rounded-[28px] p-5 md:p-6">
          <div className="space-y-1">
            <p className="label">Access check</p>
            <h2 className="font-display text-2xl font-bold tracking-tight">Enter your email</h2>
          </div>

          <form className="space-y-3" onSubmit={submitEmail}>
            <label className="block space-y-2">
              <span className="text-sm font-medium text-text">Email</span>
              <input
                className="input"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(event) => setEmail(event.currentTarget.value)}
              />
            </label>
            <button className="btn-primary w-full" type="submit" disabled={email.trim() === "" || submitting}>
              {submitting ? "Checking..." : "Continue"}
            </button>
          </form>

          <p className="text-sm leading-relaxed text-muted" role="status" aria-live="polite">
            {status}
          </p>
        </section>
      </div>
    </main>
  );
}
