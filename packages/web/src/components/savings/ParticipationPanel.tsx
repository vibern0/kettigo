"use client";

import { useEffect, useState } from "react";
import { createPublicClient, getAddress, http, type Address } from "viem";
import { deploymentChain } from "@/lib/deployment-chain.ts";
import { confidentialPrizePoolAbi, RPC_URL } from "@/lib/contracts";

const client = createPublicClient({ chain: deploymentChain, transport: http(RPC_URL) });
const statusCopy = {
  loading: "Checking your savings status…",
  pending: "Your savings are being added to future draws automatically.",
  active: "Your savings are participating. Eligibility is determined at the end of each draw.",
  empty: "Add to savings to participate in future draws.",
  paused: "New savings are not available right now.",
  unavailable: "Your savings status is unavailable. We’ll check again shortly.",
};

type ParticipationPanelProps = {
  account: Address;
  pool: Address;
  freshDepositEnabled: boolean;
  refreshCount: number;
};

export function ParticipationPanel({
  account,
  pool,
  freshDepositEnabled,
  refreshCount,
}: ParticipationPanelProps) {
  const [status, setStatus] = useState<keyof typeof statusCopy>("loading");
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const address = getAddress(pool);
    const args = [getAddress(account)] as const;

    async function refresh() {
      try {
        const [member, pending] = await Promise.all([
          client.readContract({
            address,
            abi: confidentialPrizePoolAbi,
            functionName: "membershipIndexOf",
            args,
          }),
          client.readContract({
            address,
            abi: confidentialPrizePoolAbi,
            functionName: "pendingAdmissionOf",
            args,
          }),
        ]);
        if (cancelled) return;
        if (member > 0n) {
          setStatus("active");
          return;
        }
        if (!pending.requested) {
          setStatus(freshDepositEnabled ? "empty" : "paused");
          return;
        }
        setStatus("pending");
      } catch {
        if (cancelled) return;
        setStatus("unavailable");
      }
      timer = setTimeout(refresh, 10_000);
    }
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [account, pool, freshDepositEnabled, refreshCount]);

  return (
    <section className="card space-y-3" aria-label="Savings participation">
      <p className="label">Savings participation</p>
      <p className="text-sm text-muted" role="status">
        {statusCopy[status]}
      </p>
    </section>
  );
}
