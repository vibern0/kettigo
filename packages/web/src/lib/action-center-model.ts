export const ACTION_HISTORY_LIMIT = 12;

export type AsyncActionType =
  "deposit" | "withdraw" | "claim" | "faucet" | "approval" | "wrap" | "draw" | "check" | "pending";

export type AsyncActionStatus =
  | "preparing"
  | "waiting-wallet"
  | "submitted"
  | "confirming"
  | "updating"
  | "completed"
  | "failed"
  | "rejected"
  | "not-submitted"
  | "dismissed";

export type PendingActionOperation = Readonly<{
  chainId: 11155111;
  entryPoint: string;
  sender: string;
  userOperationHash: string;
}>;

export type AsyncAction = {
  id: string;
  label: string;
  type: AsyncActionType;
  status: AsyncActionStatus;
  account?: string;
  txHash?: string;
  requestId?: string;
  operation?: PendingActionOperation;
  creditScope?: CreditActionScope;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

export type NewAsyncAction = {
  id?: string;
  label: string;
  type: AsyncActionType;
  account?: string;
  txHash?: string;
  requestId?: string;
  operation?: PendingActionOperation;
  creditScope?: CreditActionScope;
  status?: AsyncActionStatus;
  error?: string;
  createdAt?: number;
  updatedAt?: number;
};

export type ActionPatch = Partial<
  Pick<AsyncAction, "status" | "txHash" | "requestId" | "operation" | "error" | "updatedAt">
>;

export type CreditActionScope = Readonly<{
  kind: "prize-credit";
  action: "claimPrize" | "addPrizeToSavings";
  pool: string;
  mode: "legacy1" | "2";
}>;

export function isFinalActionStatus(status: AsyncActionStatus) {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "rejected" ||
    status === "not-submitted" ||
    status === "dismissed"
  );
}

export function countPendingActions(actions: AsyncAction[]) {
  return actions.filter((action) => !isFinalActionStatus(action.status)).length;
}

export function createActionId(createdAt = Date.now()) {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${createdAt}-${random}`;
}

export function trimActionHistory(actions: AsyncAction[]) {
  const sorted = [...actions].sort((left, right) => right.updatedAt - left.updatedAt);
  const current = sorted.filter((action) => !isFinalActionStatus(action.status));
  const history = sorted
    .filter((action) => isFinalActionStatus(action.status))
    .slice(0, ACTION_HISTORY_LIMIT);
  return [...current, ...history].sort((left, right) => right.updatedAt - left.updatedAt);
}

export function addAction(actions: AsyncAction[], input: NewAsyncAction): AsyncAction[] {
  const createdAt = input.createdAt ?? Date.now();
  const action: AsyncAction = {
    id: input.id ?? createActionId(createdAt),
    label: input.label,
    type: input.type,
    account: input.account,
    txHash: input.txHash,
    requestId: input.requestId,
    operation: input.operation,
    creditScope: input.creditScope,
    status: input.status ?? "preparing",
    error: input.error,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
  };

  return trimActionHistory([action, ...actions]);
}

export function updateAction(
  actions: AsyncAction[],
  id: string,
  patch: ActionPatch,
): AsyncAction[] {
  return trimActionHistory(
    actions.map((action) =>
      action.id === id
        ? {
            ...action,
            ...patch,
            updatedAt: patch.updatedAt ?? Date.now(),
          }
        : action,
    ),
  );
}

export function dismissAction(actions: AsyncAction[], id: string): AsyncAction[] {
  return actions.filter((action) => action.id !== id || !isFinalActionStatus(action.status));
}
