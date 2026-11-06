import { getAddress, type Address, type Hex } from "viem";
import {
  entryPoint07Address,
  getUserOperationHash,
  type UserOperation,
} from "viem/account-abstraction";
import { sepolia } from "viem/chains";

import type { SafeUserOperationIdentity } from "./smart-session.ts";

export function getSafeUserOperationIdentity(
  userOperation: UserOperation<"0.7">,
): SafeUserOperationIdentity {
  const sender = getAddress(userOperation.sender);
  return Object.freeze({
    chainId: sepolia.id,
    entryPoint: getAddress(entryPoint07Address),
    sender,
    userOperationHash: getUserOperationHash({
      chainId: sepolia.id,
      entryPointAddress: getAddress(entryPoint07Address),
      entryPointVersion: "0.7",
      userOperation: { ...userOperation, sender },
    }),
  });
}

export class SafeUserOperationPendingError extends Error {
  readonly operation: SafeUserOperationIdentity;
  constructor(operation: SafeUserOperationIdentity, cause?: unknown) {
    super("The sponsored transaction is still pending. Please try again.", { cause });
    this.name = "SafeUserOperationPendingError";
    this.operation = operation;
  }
}

export class SafeUserOperationFailedError extends Error {
  readonly operation: SafeUserOperationIdentity;
  readonly transactionHash?: Hex;
  constructor(operation: SafeUserOperationIdentity, transactionHash?: Hex) {
    super("The sponsored transaction failed.");
    this.name = "SafeUserOperationFailedError";
    this.operation = operation;
    this.transactionHash = transactionHash;
  }
}

export class SafeUserOperationRejectedError extends Error {
  readonly operation: SafeUserOperationIdentity;
  readonly code: number;
  constructor(operation: SafeUserOperationIdentity, code: number, cause?: unknown) {
    super("The sponsored transaction was rejected before submission.", { cause });
    this.name = "SafeUserOperationRejectedError";
    this.operation = operation;
    this.code = code;
  }
}

/** The signed operation is known, but no UserOperation was submitted. */
export class SafeUserOperationNotSubmittedError extends Error {
  readonly operation: SafeUserOperationIdentity;
  constructor(operation: SafeUserOperationIdentity, cause?: unknown) {
    super("The sponsored transaction was not submitted. Please review and try again.", { cause });
    this.name = "SafeUserOperationNotSubmittedError";
    this.operation = operation;
  }
}

export function sameHash(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function asAddress(value: string): Address {
  return getAddress(value);
}
