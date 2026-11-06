"use client";

import { createPortal } from "react-dom";
import { AmountInput } from "@/components/AmountInput";
import { SheetViewport } from "@/components/SheetViewport";
import { formatUSDC } from "@/lib/format";

type DepositSheetProps = {
  step: "entry" | "confirm";
  amount: string;
  parsedAmount: bigint;
  walletBalance: bigint | undefined;
  remainingDeposit: bigint;
  walletAfter: bigint | undefined;
  poolAfter: bigint | undefined;
  preparing: boolean;
  confirming: boolean;
  canReview: boolean;
  canConfirm: boolean;
  onAmountChange: (amount: string) => void;
  onMax: () => void;
  onReview: () => void;
  onBack: () => void;
  onConfirm: () => void;
  onClose: () => void;
};

type DepositConfirmationProps = Pick<
  DepositSheetProps,
  | "parsedAmount"
  | "walletAfter"
  | "poolAfter"
  | "confirming"
  | "canConfirm"
  | "onBack"
  | "onConfirm"
>;

function DepositConfirmation(props: DepositConfirmationProps) {
  return (
    <div className="space-y-4">
      <div className="rounded-3xl border border-white/55 bg-white/35 p-4">
        <p className="label">Confirm</p>
        <div className="mt-3 space-y-2 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted">Deposit</span>
            <span className="font-semibold tabular-nums">
              {formatUSDC(props.parsedAmount)} USDC
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted">Wallet after</span>
            <span className="font-semibold tabular-nums">{formatUSDC(props.walletAfter)} USDC</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted">Pool after</span>
            <span className="font-semibold tabular-nums">{formatUSDC(props.poolAfter)} USDC</span>
          </div>
        </div>
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
      {props.confirming && (
        <p role="status" className="text-sm text-muted">
          Approve with your passkey when asked. Your deposit will then continue in Activity.
        </p>
      )}
    </div>
  );
}

type DepositSheetDialogProps = DepositSheetProps & { max: bigint };

function DepositSheetHeader({ onClose }: Pick<DepositSheetProps, "onClose">) {
  return (
    <>
      <div className="mx-auto h-1.5 w-12 rounded-full bg-text/20" />
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="label">Deposit</p>
          <h2 id="deposit-sheet-title" className="font-display text-xl font-bold">
            Add to savings
          </h2>
        </div>
        <button
          type="button"
          aria-label="Close deposit sheet"
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

function DepositSheetForm(props: DepositSheetDialogProps) {
  return (
    <>
      <AmountInput
        label="Amount"
        maxLabel={`${formatUSDC(props.max)} USDC`}
        value={props.amount}
        onChange={props.onAmountChange}
        onMax={props.onMax}
        disabled={props.step === "confirm" || props.preparing}
      />
      <p className="rounded-2xl bg-white/45 px-3 py-2 text-xs text-muted">
        Current account limit: 1,000.00 USDC.
      </p>
      {props.step === "entry" ? (
        <button
          onClick={props.onReview}
          disabled={!props.canReview || props.preparing}
          className="btn-primary w-full"
        >
          {props.preparing ? "Preparing deposit..." : "Review deposit"}
        </button>
      ) : (
        <DepositConfirmation
          parsedAmount={props.parsedAmount}
          walletAfter={props.walletAfter}
          poolAfter={props.poolAfter}
          confirming={props.confirming}
          canConfirm={props.canConfirm}
          onBack={props.onBack}
          onConfirm={props.onConfirm}
        />
      )}
    </>
  );
}

function DepositSheetDialog(props: DepositSheetDialogProps) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="deposit-sheet-title"
      className="glass-surface relative max-h-[min(86dvh,100%)] w-full sm:max-w-[448px] space-y-4 overflow-y-auto rounded-t-[30px] p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-[0_-28px_64px_-38px_rgb(43_45_50_/_0.55)] animate-fade-in"
    >
      <DepositSheetHeader onClose={props.onClose} />
      <DepositSheetForm {...props} />
    </div>
  );
}

export function DepositSheet(props: DepositSheetProps) {
  const max =
    props.walletBalance !== undefined && props.walletBalance < props.remainingDeposit
      ? props.walletBalance
      : props.remainingDeposit;

  return createPortal(
    <SheetViewport className="fixed inset-0 z-50 flex items-end justify-center bg-text/35 backdrop-blur-sm sm:px-4 sm:pb-4">
      <button
        type="button"
        aria-label="Close deposit sheet"
        className="absolute inset-0 h-full w-full cursor-default"
        onClick={props.onClose}
      />
      <DepositSheetDialog {...props} max={max} />
    </SheetViewport>,
    document.body,
  );
}
