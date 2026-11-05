"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";
import { sepolia } from "viem/chains";
import { confidentialPrizePoolAbi, RPC_URL } from "@/lib/contracts";
import {
  AdmissionPostConfirmationReadError,
  createAdmissionCoordinator,
  type PendingAdmission,
} from "@/lib/admission-coordinator";
import type { PasskeySmartSession } from "@/lib/smart-session";
import { decryptPublicBoolean, createPublicZamaSDK } from "@/lib/zama";
import { publicConfig } from "@/lib/runtime-config";
import { useActionCenter } from "@/components/ActionCenter";
import { useToast } from "@/components/Toast";

const client = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });

type ParticipationPanelProps = {
  account?: Address;
  pool?: Address;
  session?: PasskeySmartSession;
  onReviewStart: () => void;
};

export type ParticipationPanelHandle = { cancel: () => void };
type AdmissionReady = Awaited<ReturnType<ReturnType<typeof createAdmissionCoordinator>["prepare"]>>;

function poolVersion() {
  return (
    publicConfig("NEXT_PUBLIC_POOL_VERSION", process.env.NEXT_PUBLIC_POOL_VERSION || "legacy1") ===
    "2"
  );
}

function copyPending(
  value: readonly [Hex, bigint, Hex, boolean] | PendingAdmission,
): PendingAdmission {
  if (Array.isArray(value)) {
    return { balance: value[0], nonce: value[1], marker: value[2], requested: value[3] };
  }
  const pending = value as PendingAdmission;
  return {
    balance: pending.balance,
    nonce: pending.nonce,
    marker: pending.marker,
    requested: pending.requested,
  };
}

export const ParticipationPanel = forwardRef<ParticipationPanelHandle, ParticipationPanelProps>(
  function ParticipationPanel({ account, pool, session, onReviewStart }, ref) {
    const toast = useToast();
    const { runAction } = useActionCenter();
    const [hydrated, setHydrated] = useState(false);
    const [pending, setPending] = useState<PendingAdmission>();
    const [member, setMember] = useState<bigint>();
    const [ready, setReady] = useState<AdmissionReady>();
    const [busy, setBusy] = useState(false);
    const [unresolved, setUnresolved] = useState(false);
    const abortRef = useRef<AbortController>();
    const epoch = useRef(0);
    const enabled = hydrated && poolVersion() && Boolean(account && pool && session);

    const cancel = () => {
      epoch.current += 1;
      abortRef.current?.abort();
      abortRef.current = undefined;
      ready?.cancel();
      setReady(undefined);
      setBusy(false);
    };
    useImperativeHandle(ref, () => ({ cancel }), [ready]);
    useEffect(() => setHydrated(true), []);
    useEffect(
      () => () => {
        epoch.current += 1;
        abortRef.current?.abort();
        ready?.cancel();
      },
      [account, pool, session],
    );

    const refresh = async () => {
      if (!account || !pool || !poolVersion()) return;
      const selectedAccount = getAddress(account);
      const selectedPool = getAddress(pool);
      const request = epoch.current;
      setUnresolved(false);
      try {
        const [nextMember, nextPending] = await Promise.all([
          client.readContract({
            address: selectedPool,
            abi: confidentialPrizePoolAbi,
            functionName: "membershipIndexOf",
            args: [selectedAccount],
          }),
          client.readContract({
            address: selectedPool,
            abi: confidentialPrizePoolAbi,
            functionName: "pendingAdmissionOf",
            args: [selectedAccount],
          }),
        ]);
        if (request !== epoch.current) return;
        setMember(nextMember);
        setPending(copyPending(nextPending));
      } catch {
        if (request === epoch.current) setUnresolved(true);
      }
    };

    useEffect(() => {
      if (enabled) void refresh();
    }, [enabled, account, pool]);
    if (!enabled) return null;

    const begin = async () => {
      if (!account || !pool || !session) return;
      onReviewStart();
      cancel();
      const request = ++epoch.current;
      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(true);
      const selectedAccount = getAddress(account);
      const selectedPool = getAddress(pool);
      try {
        const coordinator = createAdmissionCoordinator({
          account: selectedAccount,
          pool: selectedPool,
          session,
          decryptPublicBoolean: async (marker) => {
            const sdk = createPublicZamaSDK();
            try {
              return await decryptPublicBoolean(sdk, marker);
            } finally {
              sdk.terminate();
            }
          },
          readPendingAdmission: async (owner, signal) => {
            if (signal?.aborted) throw signal.reason;
            const value = await client.readContract({
              address: selectedPool,
              abi: confidentialPrizePoolAbi,
              functionName: "pendingAdmissionOf",
              args: [owner],
            });
            if (signal?.aborted) throw signal.reason;
            return copyPending(value);
          },
          readMembershipIndex: async (owner, signal) => {
            if (signal?.aborted) throw signal.reason;
            const value = await client.readContract({
              address: selectedPool,
              abi: confidentialPrizePoolAbi,
              functionName: "membershipIndexOf",
              args: [owner],
            });
            if (signal?.aborted) throw signal.reason;
            return value;
          },
          encodeFinalizeAdmission: ({ account: owner, nonce, positive, proof }) =>
            encodeFunctionData({
              abi: confidentialPrizePoolAbi,
              functionName: "finalizeAdmission",
              args: [owner, nonce, positive, proof],
            }),
        });
        const review = await coordinator.review(controller.signal);
        if (!review.positive) {
          if (request === epoch.current)
            toast({ tone: "error", title: "No savings are ready to add yet." });
          return;
        }
        const nextReady = await coordinator.prepare(review, controller.signal);
        if (request !== epoch.current || controller.signal.aborted) {
          nextReady.cancel();
          return;
        }
        setReady(nextReady);
      } catch (error) {
        if (!controller.signal.aborted && request === epoch.current) {
          toast({ tone: "error", title: "Please review your savings again." });
        }
      } finally {
        if (request === epoch.current) setBusy(false);
      }
    };

    const confirm = () => {
      const prepared = ready;
      if (!prepared || !session) return;
      setReady(undefined);
      // runAction invokes its runner synchronously, preserving the wallet gesture stack.
      runAction(
        { label: "Finish savings setup", type: "approval", account: session.address },
        async ({ update }) => {
          update({ status: "waiting-wallet" });
          try {
            const result = await prepared.confirm();
            update({ status: "completed" });
            setMember(result.membershipIndex);
            setPending(result.pending);
            toast({ tone: "success", title: "Savings setup complete." });
          } catch (error) {
            if (session.getPendingOperation?.()?.phase === "attempted") {
              update({
                status: "confirming",
                error: "Still processing. Check status to see the latest update.",
              });
              return;
            }
            if (error instanceof AdmissionPostConfirmationReadError) {
              // The canonical send completed; only the follow-up display reads failed.
              setUnresolved(true);
              update({ status: "updating", error: "Savings status needs a refresh." });
              return;
            }
            throw error;
          }
        },
      );
    };

    const active = member !== undefined && member > 0n;
    return (
      <section className="card space-y-3" aria-label="Savings participation">
        <p className="label">Savings participation</p>
        {unresolved ? (
          <>
            <p className="text-sm text-muted">Your savings status needs a refresh.</p>
            <button type="button" className="btn-secondary w-full" onClick={() => void refresh()}>
              Refresh status
            </button>
          </>
        ) : active ? (
          <p className="text-sm text-muted">
            Your savings are participating. Eligibility is determined at the end of each draw.
          </p>
        ) : pending?.requested ? (
          ready ? (
            <div className="grid grid-cols-2 gap-2">
              <button type="button" className="btn-secondary" onClick={cancel}>
                Back
              </button>
              <button type="button" className="btn-primary" onClick={confirm}>
                Confirm
              </button>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted">
                Finish setup to include your savings in future draws. Eligibility is determined at
                the end of each draw.
              </p>
              <button
                type="button"
                className="btn-primary w-full"
                disabled={busy}
                onClick={() => void begin}
              >
                {busy ? "Reviewing…" : "Review participation"}
              </button>
            </>
          )
        ) : (
          <p className="text-sm text-muted">
            Add to savings, then finish setup when you are ready to participate.
          </p>
        )}
      </section>
    );
  },
);
