"use client";

import { createPortal } from "react-dom";
import { AmountInput } from "@/components/AmountInput";
import { SheetViewport } from "@/components/SheetViewport";
import { formatUSDC } from "@/lib/format";
import {
  pendingWithdrawalBatchLabel,
  withdrawalStageCopy,
  type PendingWithdrawal,
  type WithdrawalStage,
} from "@/lib/withdrawal-state";

type PendingWithdrawalView = PendingWithdrawal & {
  stage: WithdrawalStage;
  closesAt?: bigint;
};

type PendingUnwrapView = {
  requestId: `0x${string}`;
};

type WithdrawalSheetProps = {
  step: "entry" | "confirm";
  amount: string;
  parsedAmount: bigint;
  principal: bigint | undefined;
  poolAfter: bigint | undefined;
  canEnterAmount: boolean;
  showWithdraw: boolean;
  pendingWithdrawals: readonly PendingWithdrawalView[];
  pendingUnwraps: readonly PendingUnwrapView[];
  automaticWithdrawals: boolean;
  preparing: boolean;
  confirming: boolean;
  working: boolean;
  pendingWorking: boolean;
  canReview: boolean;
  canRefresh: boolean;
  canConfirm: boolean;
  onAmountChange: (amount: string) => void;
  onMax: () => void;
  onReview: () => void;
  onBack: () => void;
  onConfirm: () => void;
  onClose: () => void;
  onRefresh: () => void;
  onClaim: (batchId: bigint) => void;
  onFinalize: (requestId: `0x${string}`) => void;
  onCopy: (requestId: `0x${string}`) => void;
  formatShortHash: (hash: `0x${string}`) => string;
};

type WithdrawalHistoryProps = Pick<
  WithdrawalSheetProps,
  | "pendingWithdrawals"
  | "pendingUnwraps"
  | "automaticWithdrawals"
  | "working"
  | "pendingWorking"
  | "canRefresh"
  | "onRefresh"
  | "onClaim"
  | "onFinalize"
  | "onCopy"
  | "formatShortHash"
>;

function PendingWithdrawalDetails({ request }: { request: PendingWithdrawalView }) {
  return (
    <>
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="font-semibold">{withdrawalStageCopy[request.stage]}</span>
        {request.amount !== undefined && (
          <span className="font-semibold tabular-nums">{formatUSDC(request.amount)} USDC</span>
        )}
      </div>
      <p className="text-xs text-muted">{pendingWithdrawalBatchLabel(request)}</p>
      {request.stage === "requested" && request.closesAt !== undefined && (
        <p className="text-xs text-muted">
          Batch closes{" "}
          {new Intl.DateTimeFormat("en-US", { timeStyle: "short" }).format(
            new Date(Number(request.closesAt) * 1000),
          )}
          .
        </p>
      )}
    </>
  );
}

function PendingWithdrawalAction({
  request,
  automaticWithdrawals,
  working,
  pendingWorking,
  onClaim,
  onFinalize,
}: Pick<
  WithdrawalHistoryProps,
  "automaticWithdrawals" | "working" | "pendingWorking" | "onClaim" | "onFinalize"
> & { request: PendingWithdrawalView }) {
  if (automaticWithdrawals || request.stage === "requested") return null;
  if (request.stage === "claimable") {
    return (
      <button
        className="btn-secondary w-full"
        disabled={working}
        onClick={() => onClaim(request.batchId)}
      >
        {pendingWorking ? "Receiving..." : "Receive USDC"}
      </button>
    );
  }
  if (request.stage === "finalizing" && request.unwrapRequestId) {
    return (
      <button
        className="btn-secondary w-full"
        disabled={working}
        onClick={() => onFinalize(request.unwrapRequestId!)}
      >
        {pendingWorking ? "Finalizing..." : "Finalize withdrawal"}
      </button>
    );
  }
  return null;
}

function PendingWithdrawalRow({
  request,
  automaticWithdrawals,
  working,
  pendingWorking,
  onClaim,
  onFinalize,
}: Pick<
  WithdrawalHistoryProps,
  "automaticWithdrawals" | "working" | "pendingWorking" | "onClaim" | "onFinalize"
> & { request: PendingWithdrawalView }) {
  return (
    <div
      key={`${request.batchId.toString()}:${request.txHash}`}
      className="space-y-2 rounded-2xl bg-white/35 p-3"
    >
      <PendingWithdrawalDetails request={request} />
      <PendingWithdrawalAction
        request={request}
        automaticWithdrawals={automaticWithdrawals}
        working={working}
        pendingWorking={pendingWorking}
        onClaim={onClaim}
        onFinalize={onFinalize}
      />
    </div>
  );
}

function WithdrawalHistory(props: WithdrawalHistoryProps) {
  if (props.pendingWithdrawals.length === 0 && props.pendingUnwraps.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted text-sm">Pending withdrawals</span>
        <button
          className="btn-ghost !py-1 !px-3 !text-xs bg-surface2"
          disabled={!props.canRefresh}
          onClick={props.onRefresh}
        >
          {props.pendingWorking ? "Refreshing..." : "Refresh"}
        </button>
      </div>
      {props.pendingWithdrawals.map((request) => (
        <PendingWithdrawalRow
          key={`${request.batchId.toString()}:${request.txHash}`}
          request={request}
          automaticWithdrawals={props.automaticWithdrawals}
          working={props.working}
          pendingWorking={props.pendingWorking}
          onClaim={props.onClaim}
          onFinalize={props.onFinalize}
        />
      ))}
      {props.pendingUnwraps.map((request) => (
        <div key={request.requestId} className="space-y-2">
          <button
            type="button"
            className="font-mono text-xs text-muted underline-offset-2 transition-colors hover:text-text hover:underline"
            title="Copy withdrawal ID"
            onClick={() => props.onCopy(request.requestId)}
          >
            {props.formatShortHash(request.requestId)}
          </button>
          <button
            className="btn-secondary w-full"
            disabled={props.working}
            onClick={() => props.onFinalize(request.requestId)}
          >
            {props.pendingWorking ? "Finalizing..." : "Finalize withdrawal"}
          </button>
        </div>
      ))}
    </div>
  );
}

function WithdrawalSheetHeader({ onClose }: Pick<WithdrawalSheetProps, "onClose">) {
  return (
    <>
      <div className="mx-auto h-1.5 w-12 rounded-full bg-text/20" />
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="label">Withdraw</p>
          <h2 id="withdraw-sheet-title" className="font-display text-xl font-bold">
            Move savings to USDC
          </h2>
        </div>
        <button
          type="button"
          aria-label="Close withdrawal sheet"
          onClick={onClose}
          className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/40 text-muted transition-colors hover:bg-white/60 hover:text-text"
        >
          <svg
            aria-hidden="true"
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
          >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </div>
    </>
  );
}

function WithdrawalConfirmation(
  props: Pick<
    WithdrawalSheetProps,
    "parsedAmount" | "poolAfter" | "confirming" | "canConfirm" | "onBack" | "onConfirm"
  >,
) {
  return (
    <div className="space-y-4">
      <div className="rounded-3xl border border-white/55 bg-white/35 p-4">
        <p className="label">Confirm</p>
        <div className="mt-3 space-y-2 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted">Withdraw</span>
            <span className="font-semibold tabular-nums">
              {formatUSDC(props.parsedAmount)} USDC
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted">Savings after</span>
            <span className="font-semibold tabular-nums">{formatUSDC(props.poolAfter)} USDC</span>
          </div>
        </div>
        <p className="mt-3 rounded-2xl bg-white/45 px-3 py-2 text-xs text-muted">
          Your chances of winning update after this request.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          className="btn-secondary !px-3"
          onClick={props.onBack}
          disabled={props.confirming}
        >
          Back
        </button>
        <button
          type="button"
          className="btn-primary !px-3"
          disabled={!props.canConfirm}
          onClick={props.onConfirm}
        >
          {props.confirming ? (
            <>
              <span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
              Confirming...
            </>
          ) : (
            "Confirm"
          )}
        </button>
      </div>
    </div>
  );
}

function WithdrawalAmountForm(props: WithdrawalSheetProps) {
  if (!props.canEnterAmount) return null;
  return (
    <>
      <AmountInput
        label="Amount"
        maxLabel={`${formatUSDC(props.principal)} USDC`}
        value={props.amount}
        onChange={props.onAmountChange}
        onMax={props.onMax}
        disabled={props.step === "confirm"}
      />
      {props.step === "entry" ? (
        <button
          onClick={props.onReview}
          disabled={!props.canReview || props.preparing}
          className="btn-secondary w-full"
        >
          {props.preparing ? "Preparing..." : "Review withdrawal"}
        </button>
      ) : (
        <WithdrawalConfirmation {...props} />
      )}
    </>
  );
}

function WithdrawalSheetDialog(props: WithdrawalSheetProps) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="withdraw-sheet-title"
      className="glass-surface relative max-h-[min(86dvh,100%)] w-full sm:max-w-[448px] space-y-4 overflow-y-auto rounded-t-[30px] p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-[0_-28px_64px_-38px_rgb(43_45_50_/_0.55)] animate-fade-in"
    >
      <WithdrawalSheetHeader onClose={props.onClose} />
      <WithdrawalAmountForm {...props} />
      <WithdrawalHistory {...props} />
      {!props.showWithdraw && (
        <p className="text-sm text-muted">No deposited funds or pending withdrawals yet.</p>
      )}
    </div>
  );
}

export function WithdrawalSheet(props: WithdrawalSheetProps) {
  return createPortal(
    <SheetViewport className="fixed inset-0 z-50 flex items-end justify-center bg-text/35 backdrop-blur-sm sm:px-4 sm:pb-4">
      <button
        type="button"
        aria-label="Close withdrawal sheet"
        className="absolute inset-0 h-full w-full cursor-default"
        onClick={props.onClose}
      />
      <WithdrawalSheetDialog {...props} />
    </SheetViewport>,
    document.body,
  );
}
