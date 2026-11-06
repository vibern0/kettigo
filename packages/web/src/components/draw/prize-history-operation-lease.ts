import type { AsyncAction } from "@/lib/action-center-model";
import {
  SafeUserOperationFailedError,
  SafeUserOperationNotSubmittedError,
  SafeUserOperationRejectedError,
} from "@/lib/passkey-operation";
import { drawOperationKey, isStoredDrawOperation } from "./draw-page-utils";
import type { ReviewLease } from "./review-lease";

const TERMINAL_STATUSES = ["completed", "failed", "rejected", "not-submitted"];

export function completeObservedPrizeHistoryOperations(
  actions: readonly AsyncAction[],
  owners: Map<string, symbol>,
  reviewLease: ReviewLease,
) {
  for (const action of actions) {
    if (
      !action.operation ||
      !isStoredDrawOperation(action.operation) ||
      !TERMINAL_STATUSES.includes(action.status)
    )
      continue;
    const key = drawOperationKey(action.operation);
    const owner = owners.get(key);
    if (!owner) continue;
    reviewLease.complete(owner);
    owners.delete(key);
  }
}

export function completeKnownPrizeHistoryOperation(
  owner: symbol,
  error: unknown,
  owners: Map<string, symbol>,
  reviewLease: ReviewLease,
) {
  if (!(
    error instanceof SafeUserOperationFailedError ||
    error instanceof SafeUserOperationNotSubmittedError ||
    error instanceof SafeUserOperationRejectedError
  ))
    return;
  const key = drawOperationKey(error.operation);
  const boundOwner = owners.get(key);
  if (boundOwner !== owner) return;
  owners.delete(key);
  reviewLease.complete(owner);
}
