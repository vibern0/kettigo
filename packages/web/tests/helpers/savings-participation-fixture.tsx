import { render, screen } from "@testing-library/react";
import { vi, type Mock } from "vitest";
import React, { type ComponentType, type ReactNode, type Ref, type RefObject } from "react";
import type { Address } from "viem";
import {
  ParticipationPanel,
  type ParticipationPanelHandle,
} from "@/components/savings/ParticipationPanel";
import { ToastProvider } from "@/components/Toast";
import type { PasskeySmartSession } from "@/lib/smart-session";

export type PendingAdmission = [`0x${string}`, bigint, `0x${string}`, boolean];

export type ParticipationFixture = {
  account: `0x${string}`;
  pool: `0x${string}`;
  version: string;
  reads: Mock;
  archive: Mock;
  prepare: Mock;
  send: Mock;
  decrypt: Mock;
  encrypt: Mock;
  smartReads: Mock;
  membershipIndex: bigint;
  walletBalance: bigint;
  principal: bigint | undefined;
  accessState: "ready" | "access-required";
  session: { address: `0x${string}`; prepareTransaction: typeof vi.fn } | undefined;
  pending: PendingAdmission[];
};

export const participationMarker = `0x${"a".repeat(64)}` as const;
export const participationProof = "0x1234" as const;

export function pendingAdmission(requested = true): PendingAdmission {
  return [participationMarker, 7n, participationMarker, requested];
}

export function resetParticipationFixture(fixture: ParticipationFixture) {
  fixture.version = "legacy1";
  fixture.pending = [pendingAdmission()];
  fixture.membershipIndex = 0n;
  fixture.walletBalance = 0n;
  fixture.principal = undefined;
  fixture.accessState = "ready";
  fixture.reads.mockReset();
  fixture.archive.mockReset();
  fixture.prepare.mockReset();
  fixture.send.mockReset();
  fixture.decrypt.mockReset();
  fixture.encrypt.mockReset();
  fixture.smartReads.mockReset();
  fixture.session = { address: fixture.account, prepareTransaction: fixture.prepare };
  fixture.reads.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === "membershipIndexOf") return fixture.membershipIndex;
    if (functionName === "pendingAdmissionOf") return fixture.pending.shift() ?? pendingAdmission();
    if (functionName === "balanceOf") return fixture.walletBalance;
    return 0n;
  });
  fixture.archive.mockResolvedValue([]);
  fixture.prepare.mockResolvedValue({ cancel: vi.fn(), send: fixture.send });
  fixture.send.mockImplementation(async () => {
    fixture.membershipIndex = 1n;
    fixture.pending = [pendingAdmission(false)];
    return "0xdead";
  });
  fixture.decrypt.mockResolvedValue({ clearValue: true, decryptionProof: participationProof });
  fixture.encrypt.mockResolvedValue({
    handle: participationMarker,
    inputProof: participationProof,
  });
  fixture.smartReads.mockResolvedValue([]);
}

export function participationMetadataReadCount(reads: Mock) {
  return reads.mock.calls.filter(([call]) =>
    ["membershipIndexOf", "pendingAdmissionOf"].includes(call.functionName),
  ).length;
}

export function renderSavingsParticipation(
  SavingsPage: ComponentType,
  ToastProvider: ComponentType<{ children: ReactNode }>,
) {
  return render(
    <ToastProvider>
      <SavingsPage />
    </ToastProvider>,
  );
}

export function participationPanelTree(
  ref: Ref<ParticipationPanelHandle>,
  account: Address,
  pool: Address,
  session: PasskeySmartSession,
) {
  return (
    <ToastProvider>
      <ParticipationPanel
        ref={ref}
        account={account}
        pool={pool}
        session={session}
        onReviewStart={() => {}}
      />
    </ToastProvider>
  );
}

export function renderParticipationPanel(
  ref: Ref<ParticipationPanelHandle>,
  account: Address,
  pool: Address,
  session: PasskeySmartSession,
) {
  return render(participationPanelTree(ref, account, pool, session));
}

export async function startRetainedParticipationScope(
  fixture: ParticipationFixture,
  ref: Ref<ParticipationPanelHandle>,
  alternateAccount: Address,
) {
  const session = fixture.session as unknown as PasskeySmartSession;
  fixture.version = "2";
  fixture.reads.mockImplementation(
    async ({ functionName, args }: { functionName: string; args: string[] }) => {
      const isAlternate = args[0]?.toLowerCase() === alternateAccount.toLowerCase();
      if (functionName === "membershipIndexOf") return isAlternate ? 0n : 1n;
      if (functionName === "pendingAdmissionOf")
        return isAlternate ? pendingAdmission() : pendingAdmission(false);
      return 0n;
    },
  );
  const view = renderParticipationPanel(ref, fixture.account, fixture.pool, session);
  await screen.findByText(
    "Your savings are participating. Eligibility is determined at the end of each draw.",
  );
  const refreshOldScope = (ref as RefObject<ParticipationPanelHandle>).current!.refresh;
  view.rerender(
    participationPanelTree(ref, alternateAccount, fixture.pool, {
      ...session,
      address: alternateAccount,
    }),
  );
  await screen.findByRole("button", { name: "Review participation" });
  return { refreshOldScope, readsBeforeOldRefresh: participationMetadataReadCount(fixture.reads) };
}
