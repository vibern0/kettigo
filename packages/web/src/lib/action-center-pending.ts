import { getAddress, type Address, type Hex } from "viem";
import { entryPoint07Address } from "viem/account-abstraction";

import {
  updateAction,
  type ActionPatch,
  type AsyncAction,
  type PendingActionOperation,
} from "./action-center-model";
import type { PendingOperationRecoveryResult, PendingOperationRecord } from "./smart-session";

const EXPECTED_ENTRY_POINT = getAddress(entryPoint07Address);
const HASH_PATTERN = /^0x[\da-fA-F]{64}$/;

export type PendingOperationDisplay = Readonly<{
  chainId: 11155111;
  entryPoint: Address;
  sender: Address;
  userOperationHash: Hex;
  phase: "prepared" | "attempted";
}>;

function displayOperation(record: PendingOperationRecord): PendingOperationDisplay | undefined {
  if (record.chainId !== 11155111 || !HASH_PATTERN.test(record.userOperationHash)) return undefined;
  try {
    const entryPoint = getAddress(record.entryPoint);
    if (entryPoint !== EXPECTED_ENTRY_POINT) return undefined;
    return {
      chainId: 11155111,
      entryPoint,
      sender: getAddress(record.sender),
      userOperationHash: record.userOperationHash,
      phase: record.phase,
    };
  } catch {
    return undefined;
  }
}

function asStoredOperation(operation: PendingOperationDisplay): PendingActionOperation {
  return {
    chainId: operation.chainId,
    entryPoint: operation.entryPoint,
    sender: operation.sender,
    userOperationHash: operation.userOperationHash,
  };
}

export function actionForPendingOperation(
  record: PendingOperationRecord,
  now = Date.now(),
): AsyncAction {
  const operation = displayOperation(record);
  if (!operation) throw new Error("Unsupported pending operation.");
  return {
    id: `pending-${operation.userOperationHash}`,
    label: "Your action",
    type: "pending",
    status: operation.phase === "prepared" ? "preparing" : "confirming",
    account: operation.sender,
    operation: asStoredOperation(operation),
    error:
      operation.phase === "attempted"
        ? "Still processing. Check status to see the latest update."
        : undefined,
    createdAt: record.createdAt,
    updatedAt: now,
  };
}

export function patchForRunnerError(
  action: AsyncAction,
  pending?: PendingOperationRecord | null,
  error?: unknown,
): ActionPatch {
  if (
    action.status === "submitted" ||
    action.status === "confirming" ||
    pending?.phase === "attempted"
  ) {
    return {
      status: "confirming",
      error: "Still processing. Check status to see the latest update.",
    };
  }
  if (
    typeof error === "object" &&
    error !== null &&
    (("code" in error && error.code === 4001) ||
      ("name" in error && error.name === "UserRejectedRequestError"))
  ) {
    return { status: "rejected", error: "Approval was not completed." };
  }
  return { status: "failed", error: "This action could not be completed. Try again." };
}

export function applyRunnerError(
  actions: AsyncAction[],
  id: string,
  pending: PendingOperationRecord | null | undefined,
  error: unknown,
): AsyncAction[] {
  const action = actions.find((item) => item.id === id);
  return action ? updateAction(actions, id, patchForRunnerError(action, pending, error)) : actions;
}

export function applyRunnerErrorFromPendingReader(
  actions: AsyncAction[],
  id: string,
  readPending: () => PendingOperationRecord | null | undefined,
  error: unknown,
): AsyncAction[] {
  try {
    return applyRunnerError(actions, id, readPending(), error);
  } catch {
    return applyRunnerError(actions, id, undefined, error);
  }
}

export function patchForPendingRecovery(result: PendingOperationRecoveryResult): ActionPatch {
  switch (result.state) {
    case "pending":
      return {
        status: "confirming",
        error: "Still processing. Check status to see the latest update.",
      };
    case "not-submitted":
      return { status: "not-submitted", error: "This action was not sent. Review it again." };
    case "confirmed":
      return { status: "completed", txHash: result.transactionHash, error: undefined };
    case "failed":
      return {
        status: "failed",
        txHash: result.transactionHash,
        error: "This action did not go through.",
      };
    case "none":
      return { status: "failed", error: "Status is no longer available." };
  }
}

export function matchesPendingOperation(
  action: AsyncAction,
  record: PendingOperationRecord,
): boolean {
  const operation = displayOperation(record);
  if (!operation || !action.operation) return false;
  return (
    action.operation.chainId === operation.chainId &&
    action.operation.entryPoint === operation.entryPoint &&
    action.operation.sender === operation.sender &&
    action.operation.userOperationHash === operation.userOperationHash
  );
}
