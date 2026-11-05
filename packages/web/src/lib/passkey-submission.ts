import { getAddress, RpcRequestError, type Address, type Hex } from "viem";
import type { UserOperation } from "viem/account-abstraction";

import {
  lookupCanonicalUserOperationReceipt,
  SafeUserOperationIntegrityError,
  type CanonicalReceiptDependencies,
  type EthereumBlock,
  type EthereumReceipt,
} from "./canonical-user-operation-receipt.ts";
import { createPasskeyFeeEstimator } from "./passkey-fee-estimator.ts";
import {
  getSafeUserOperationIdentity,
  SafeUserOperationFailedError,
  SafeUserOperationNotSubmittedError,
  SafeUserOperationPendingError,
  SafeUserOperationRejectedError,
  sameHash,
} from "./passkey-operation.ts";
import { withPasskeyStage, type PasskeyGasDiagnostics } from "./passkey-gas.ts";
import type {
  SafeUserOperationIdentity,
  SafeUserOperationReceipt,
  SmartAccountCall,
  SmartTransactionOptions,
} from "./smart-session.ts";

const DEFAULT_RECEIPT_TIMEOUT_MS = 120_000;
const DEFAULT_RECEIPT_POLL_MS = 1_500;
const USER_OPERATION_REJECTION_CODES = new Set([
  -32602, -32500, -32501, -32502, -32503, -32504, -32505, -32507, -32508,
]);
export const submissionTimedOut = Symbol("submission-timed-out");

type SafeOperationLike = {
  getUserOperation?(): UserOperation<"0.7">;
};

export type SubmissionRelay = {
  createTransaction(input: {
    transactions: Array<{ to: string; data: string; value: string }>;
    options?: { feeEstimator?: ReturnType<typeof createPasskeyFeeEstimator> };
  }): Promise<unknown>;
  signSafeOperation(operation: unknown): Promise<unknown>;
  executeTransaction(input: { executable: unknown }): Promise<string>;
  getUserOperationReceipt(userOperationHash: string): Promise<{
    success: boolean;
    receipt: { transactionHash: string };
    userOpHash: string;
    sender: string;
  } | null>;
};

export type PasskeySubmissionDependencies = {
  estimateVerifierGas(address: Address): Promise<bigint>;
  getTransactionReceipt(
    input: { hash: Hex },
    options?: { signal?: AbortSignal },
  ): Promise<EthereumReceipt | null>;
  getBlock(
    input: { blockNumber: bigint },
    options?: { signal?: AbortSignal },
  ): Promise<EthereumBlock | null>;
  sleep(milliseconds: number): Promise<void>;
  receiptTimeoutMs?: number;
  receiptPollMs?: number;
};

export async function sendPasskeyCalls(
  relay: SubmissionRelay,
  calls: SmartAccountCall[],
  dependencies: PasskeySubmissionDependencies,
  verifierAddress: Address,
  expectedSender: Address,
  normalizeSignature: (operation: unknown) => unknown,
  beforeSigning?: () => void,
  options?: SmartTransactionOptions,
  onAccepted?: () => void,
): Promise<Hex> {
  const diagnostics: PasskeyGasDiagnostics = {};
  const operation = await withPasskeyStage(diagnostics, "estimation", () =>
    relay.createTransaction({
      transactions: calls.map((call) => ({
        to: getAddress(call.to),
        data: call.data,
        value: (call.value ?? 0n).toString(),
      })),
      options: {
        feeEstimator: createPasskeyFeeEstimator(undefined, {
          estimateVerifierGas: () => dependencies.estimateVerifierGas(verifierAddress),
          diagnostics,
        }),
      },
    }),
  );
  beforeSigning?.();
  const signed = normalizeSignature(
    await withPasskeyStage(diagnostics, "signing", () => relay.signSafeOperation(operation)),
  );
  return submitSignedPasskeyOperation(
    relay,
    signed,
    dependencies,
    diagnostics,
    expectedSender,
    options,
    onAccepted,
  );
}

export async function submitSignedPasskeyOperation(
  relay: SubmissionRelay,
  signed: unknown,
  dependencies: PasskeySubmissionDependencies,
  diagnostics: PasskeyGasDiagnostics,
  expectedSender: Address,
  options?: SmartTransactionOptions,
  onAccepted?: () => void,
): Promise<Hex> {
  const operation = signed as SafeOperationLike;
  if (!operation.getUserOperation) throw new Error("Safe did not provide a final UserOperation.");
  const userOperation = operation.getUserOperation();
  if (!userOperation) throw new Error("Safe did not provide a final UserOperation.");
  const identity = getSafeUserOperationIdentity(userOperation);
  if (identity.sender !== getAddress(expectedSender))
    throw new SafeUserOperationIntegrityError(identity, "The operation is not for this Safe.");
  recordSubmittedGas(diagnostics, userOperation);
  const deadline =
    Date.now() + Math.max(0, dependencies.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS);
  try {
    options?.onSigned?.();
    await awaitSubmissionObserver(
      options?.onOperationPrepared,
      identity,
      remainingSubmissionDeadline(deadline),
    );
  } catch (error) {
    throw new SafeUserOperationNotSubmittedError(identity, error);
  }
  if (remainingSubmissionDeadline(deadline) <= 0)
    throw new SafeUserOperationNotSubmittedError(identity);
  let hash: string;
  try {
    const sent = await withinSubmissionDeadline(
      () =>
        withPasskeyStage(diagnostics, "submission", () =>
          relay.executeTransaction({ executable: signed }),
        ),
      remainingSubmissionDeadline(deadline),
    );
    if (sent === submissionTimedOut) throw new Error("The sponsored transaction is still pending.");
    hash = sent;
  } catch (error) {
    const rejection = bundlerRejection(error);
    const wrapped = rejection
      ? new SafeUserOperationRejectedError(identity, rejection.code, error)
      : new SafeUserOperationPendingError(identity, error);
    Object.assign(wrapped, {
      passkeyDiagnostics: (error as { passkeyDiagnostics?: unknown }).passkeyDiagnostics,
    });
    throw wrapped;
  }
  if (!sameHash(hash, identity.userOperationHash))
    throw new SafeUserOperationIntegrityError(
      identity,
      "The relay returned a different operation hash.",
    );
  onAccepted?.();
  try {
    const outcome = await withPasskeyStage(diagnostics, "receipt", () =>
      pollCanonicalUserOperationReceipt(
        canonicalReceiptDependencies(relay, dependencies),
        identity,
        dependencies,
        deadline,
      ),
    );
    if (outcome.state === "pending") throw new SafeUserOperationPendingError(identity);
    if (outcome.state === "failed")
      throw new SafeUserOperationFailedError(identity, outcome.transactionHash);
    return outcome.transactionHash;
  } catch (error) {
    if (
      error instanceof SafeUserOperationFailedError ||
      error instanceof SafeUserOperationIntegrityError
    )
      throw error;
    if (error instanceof SafeUserOperationPendingError) throw error;
    throw new SafeUserOperationPendingError(identity, error);
  }
}

function submittedRequestMethod(error: RpcRequestError): string | undefined {
  const request = error.metaMessages?.find((message) => message.startsWith("Request body: "));
  if (!request) return undefined;
  try {
    const body: unknown = JSON.parse(request.slice("Request body: ".length));
    if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
    const method = (body as { method?: unknown }).method;
    return typeof method === "string" ? method : undefined;
  } catch {
    return undefined;
  }
}

function bundlerRejection(error: unknown): RpcRequestError | undefined {
  const seen = new Set<object>();
  let candidate = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!(candidate instanceof Error) || seen.has(candidate)) return undefined;
    seen.add(candidate);
    if (
      candidate instanceof RpcRequestError &&
      USER_OPERATION_REJECTION_CODES.has(candidate.code) &&
      submittedRequestMethod(candidate) === "eth_sendUserOperation"
    )
      return candidate;
    candidate = candidate.cause;
  }
  return undefined;
}

function remainingSubmissionDeadline(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function recordSubmittedGas(
  diagnostics: PasskeyGasDiagnostics,
  operation: UserOperation<"0.7">,
): void {
  if (typeof operation.verificationGasLimit === "bigint")
    diagnostics.submittedVerificationGas = operation.verificationGasLimit.toString();
  if (typeof operation.callGasLimit === "bigint")
    diagnostics.submittedCallGas = operation.callGasLimit.toString();
  if (typeof operation.preVerificationGas === "bigint")
    diagnostics.submittedPreVerificationGas = operation.preVerificationGas.toString();
  if (typeof operation.maxFeePerGas === "bigint")
    diagnostics.submittedMaxFeePerGas = operation.maxFeePerGas.toString();
  if (typeof operation.maxPriorityFeePerGas === "bigint")
    diagnostics.submittedMaxPriorityFeePerGas = operation.maxPriorityFeePerGas.toString();
}

export async function withinSubmissionDeadline<T>(
  callback: () => Promise<T>,
  timeoutMs: number,
): Promise<T | typeof submissionTimedOut> {
  if (timeoutMs <= 0) return submissionTimedOut;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = Promise.resolve().then(callback);
  void work.catch(() => undefined);
  const timeout = new Promise<typeof submissionTimedOut>((resolve) => {
    timer = setTimeout(() => resolve(submissionTimedOut), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function awaitSubmissionObserver(
  observer: SmartTransactionOptions["onOperationPrepared"],
  identity: SafeUserOperationIdentity,
  timeoutMs = DEFAULT_RECEIPT_TIMEOUT_MS,
): Promise<void> {
  if (!observer) return;
  const result = await withinSubmissionDeadline(
    () => Promise.resolve(observer(identity)),
    Math.max(0, timeoutMs),
  );
  if (result === submissionTimedOut) throw new Error("The transaction review timed out.");
}

async function pollCanonicalUserOperationReceipt(
  dependencies: CanonicalReceiptDependencies,
  identity: SafeUserOperationIdentity,
  options: Pick<PasskeySubmissionDependencies, "receiptTimeoutMs" | "receiptPollMs" | "sleep">,
  deadline = Date.now() + Math.max(0, options.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS),
): Promise<SafeUserOperationReceipt> {
  const pollMs = Math.max(0, options.receiptPollMs ?? DEFAULT_RECEIPT_POLL_MS);
  while (true) {
    const remainingForLookup = deadline - Date.now();
    if (remainingForLookup <= 0) return Object.freeze({ state: "pending", operation: identity });
    const outcome = await lookupCanonicalUserOperationReceipt(dependencies, identity, {
      timeoutMs: remainingForLookup,
    });
    if (outcome.state !== "pending") return outcome;
    const remainingForSleep = deadline - Date.now();
    if (remainingForSleep <= 0) return outcome;
    const sleep = await withinSubmissionDeadline(
      () => options.sleep(Math.min(pollMs, remainingForSleep)),
      remainingForSleep,
    );
    if (sleep === submissionTimedOut)
      return Object.freeze({ state: "pending", operation: identity });
  }
}

export function canonicalReceiptDependencies(
  relay: Pick<SubmissionRelay, "getUserOperationReceipt">,
  dependencies: Pick<PasskeySubmissionDependencies, "getTransactionReceipt" | "getBlock">,
): CanonicalReceiptDependencies {
  return {
    getUserOperationReceipt: (operationHash) => relay.getUserOperationReceipt(operationHash),
    getTransactionReceipt: (input, options) => dependencies.getTransactionReceipt(input, options),
    getBlock: (input, options) => dependencies.getBlock(input, options),
  };
}
