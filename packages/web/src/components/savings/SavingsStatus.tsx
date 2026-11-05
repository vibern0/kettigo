import { LoadingAmount } from "@/components/LoadingAmount";
import { formatUSDC } from "@/lib/format";
import {
  balanceBucketLabels,
  withdrawalStageCopy,
  type PendingWithdrawal,
  type WithdrawalStage,
} from "@/lib/withdrawal-state";

type PendingWithdrawalView = PendingWithdrawal & { stage: WithdrawalStage };

type SavingsStatusProps = {
  walletBalance: bigint | undefined;
  principal: bigint | undefined;
  pendingTotal: bigint;
  pendingWithdrawals: readonly PendingWithdrawalView[];
  loading: boolean;
  error: string | null;
  accessRequired: boolean;
  accessConfirming: boolean;
  accessAvailable: boolean;
  automaticWithdrawals: boolean;
  withdrawalRefreshError: boolean;
  onAccessBack: () => void;
  onAccessConfirm: () => void;
  onAccessReview: () => void;
};

export function SavingsStatus(props: SavingsStatusProps) {
  return (
    <>
      <div className="card space-y-3">
        <p className="label">Personal status</p>
        <div className="flex items-center justify-between">
          <span className="text-muted text-sm">{balanceBucketLabels.walletUsdc}</span>
          <span className="font-semibold tabular-nums">{formatUSDC(props.walletBalance)} USDC</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted text-sm">{balanceBucketLabels.withdrawalInProgress}</span>
          <span className="font-semibold tabular-nums">
            {props.pendingWithdrawals.some((request) => request.amount === undefined)
              ? `${props.pendingWithdrawals.length} pending`
              : `${formatUSDC(props.pendingTotal)} USDC`}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted text-sm">{balanceBucketLabels.savingsBalance}</span>
          <span className="font-semibold tabular-nums text-text">
            {props.loading ? <LoadingAmount /> : `${formatUSDC(props.principal)} USDC`}
          </span>
        </div>
        {props.error && <p className="text-xs text-danger">{props.error}</p>}
        {props.accessRequired && (
          <div className="rounded-2xl bg-white/45 p-3 text-sm">
            <p className="text-muted">Review access to show your current savings balance.</p>
            {props.accessConfirming ? (
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button type="button" className="btn-secondary !px-3" onClick={props.onAccessBack}>
                  Back
                </button>
                <button type="button" className="btn-primary !px-3" onClick={props.onAccessConfirm}>
                  Confirm
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn-secondary mt-3 w-full"
                onClick={props.onAccessReview}
                disabled={!props.accessAvailable}
              >
                Review access
              </button>
            )}
          </div>
        )}
      </div>
      {props.pendingWithdrawals.length > 0 && (
        <section
          className="space-y-3 border-t border-text/10 py-4"
          aria-label="Pending withdrawals"
          aria-live="polite"
        >
          <h2 className="text-sm font-semibold">Pending withdrawals</h2>
          {props.automaticWithdrawals && (
            <p className="text-sm text-muted">USDC will arrive in your wallet automatically.</p>
          )}
          {props.withdrawalRefreshError && (
            <p className="text-sm text-muted">
              Updates are delayed. Your withdrawals are still pending.
            </p>
          )}
          {props.pendingWithdrawals.map((request) => (
            <div
              key={request.batchId.toString()}
              className="flex items-center justify-between gap-3 text-sm"
            >
              <span>{withdrawalStageCopy[request.stage]}</span>
              <span className="tabular-nums">
                {request.amount === undefined
                  ? "Amount pending"
                  : `${formatUSDC(request.amount)} USDC`}
              </span>
            </div>
          ))}
        </section>
      )}
    </>
  );
}
