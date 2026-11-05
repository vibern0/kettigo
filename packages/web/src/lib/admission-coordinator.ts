import { NotEntitledError, RpcRateLimitError } from "@zama-fhe/sdk";
import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";

import type {
  PasskeySmartSession,
  PreparedSmartTransaction,
  SmartTransactionOptions,
} from "./smart-session.ts";

export type PendingAdmission = Readonly<{
  balance: Hex;
  nonce: bigint;
  marker: Hex;
  requested: boolean;
}>;

export type AdmissionReview = Readonly<{
  pending: PendingAdmission;
  positive: boolean;
  decryptionProof: Hex;
}>;

export type AdmissionResult = Readonly<{
  state: "admitted" | "not-admitted";
  membershipIndex: bigint;
  pending: PendingAdmission;
}>;

export class AdmissionStaleError extends Error {
  constructor() {
    super("Your savings changed before the review was ready. Please review it again.");
    this.name = "AdmissionStaleError";
  }
}

export class AdmissionReconciliationError extends Error {
  constructor() {
    super("We could not confirm your savings status. Please check again.");
    this.name = "AdmissionReconciliationError";
  }
}

/** A send completed, but the following display-only reads were unavailable. */
export class AdmissionPostConfirmationReadError extends Error {
  constructor(cause: unknown) {
    super("Savings status needs a refresh.", { cause });
    this.name = "AdmissionPostConfirmationReadError";
  }
}

export type AdmissionCoordinatorDependencies = Readonly<{
  account: Address;
  pool: Address;
  session: Pick<PasskeySmartSession, "prepareTransaction">;
  decryptPublicBoolean: (
    marker: Hex,
  ) => Promise<Readonly<{ clearValue: boolean; decryptionProof: Hex }>>;
  readPendingAdmission: (account: Address, signal?: AbortSignal) => Promise<PendingAdmission>;
  readMembershipIndex: (account: Address, signal?: AbortSignal) => Promise<bigint>;
  encodeFinalizeAdmission: (
    args: Readonly<{
      account: Address;
      nonce: bigint;
      positive: boolean;
      proof: Hex;
    }>,
  ) => Hex;
}>;

function samePending(left: PendingAdmission, right: PendingAdmission) {
  return (
    left.nonce === right.nonce &&
    left.marker.toLowerCase() === right.marker.toLowerCase() &&
    left.requested === right.requested
  );
}

function copyPending(pending: PendingAdmission): PendingAdmission {
  return Object.freeze({
    balance: pending.balance,
    nonce: pending.nonce,
    marker: pending.marker,
    requested: pending.requested,
  });
}

function assertActive(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted.", "AbortError");
}

async function reconcile(
  dependencies: AdmissionCoordinatorDependencies,
  review: AdmissionReview,
  signal?: AbortSignal,
): Promise<AdmissionResult> {
  assertActive(signal);
  const membershipIndex = await dependencies.readMembershipIndex(dependencies.account, signal);
  assertActive(signal);
  const pending = copyPending(
    await dependencies.readPendingAdmission(dependencies.account, signal),
  );
  assertActive(signal);
  if (review.positive && (membershipIndex === 0n || pending.requested)) {
    throw new AdmissionReconciliationError();
  }
  return Object.freeze({
    state: review.positive && membershipIndex > 0n ? "admitted" : "not-admitted",
    membershipIndex,
    pending,
  });
}

export function createAdmissionCoordinator(input: AdmissionCoordinatorDependencies) {
  const dependencies: AdmissionCoordinatorDependencies = Object.freeze({
    ...input,
    account: getAddress(input.account),
    pool: getAddress(input.pool),
  });

  return Object.freeze({
    async review(signal?: AbortSignal): Promise<AdmissionReview> {
      assertActive(signal);
      const pending = copyPending(
        await dependencies.readPendingAdmission(dependencies.account, signal),
      );
      assertActive(signal);
      if (!pending.requested) throw new AdmissionStaleError();
      const decrypted = await dependencies.decryptPublicBoolean(pending.marker);
      assertActive(signal);
      if (typeof decrypted.clearValue !== "boolean") {
        throw new Error("Reveal result is not a boolean.");
      }
      return Object.freeze({
        pending: copyPending(pending),
        positive: decrypted.clearValue,
        decryptionProof: decrypted.decryptionProof,
      });
    },

    async prepare(review: AdmissionReview, signal?: AbortSignal) {
      assertActive(signal);
      // This is deliberately the final RPC read before exact call preparation.
      const current = await dependencies.readPendingAdmission(dependencies.account, signal);
      assertActive(signal);
      if (!samePending(review.pending, current)) throw new AdmissionStaleError();
      const data = dependencies.encodeFinalizeAdmission({
        account: dependencies.account,
        nonce: review.pending.nonce,
        positive: review.positive,
        proof: review.decryptionProof,
      });
      const prepared = await dependencies.session.prepareTransaction(
        [{ to: dependencies.pool, data }],
        {
          signal,
        },
      );
      if (signal?.aborted) {
        try {
          prepared.cancel();
        } finally {
          assertActive(signal);
        }
      }
      return readyAdmission(prepared, dependencies, review, signal);
    },
  });
}

function readyAdmission(
  prepared: PreparedSmartTransaction,
  dependencies: AdmissionCoordinatorDependencies,
  review: AdmissionReview,
  signal?: AbortSignal,
) {
  let active = true;
  let attempted = false;
  let confirmation: Promise<AdmissionResult> | undefined;
  const removeAbort = () => signal?.removeEventListener("abort", cancel);
  function cancel() {
    if (!active || attempted) return;
    active = false;
    removeAbort();
    prepared.cancel();
  }
  signal?.addEventListener("abort", cancel, { once: true });
  return Object.freeze({
    cancel,
    reviewedPending: copyPending(review.pending),
    // Do not make this async: prepared.send must begin within the Confirm gesture stack.
    confirm: (options?: SmartTransactionOptions) => {
      if (confirmation) return confirmation;
      try {
        assertActive(signal);
      } catch (error) {
        return Promise.reject(error);
      }
      if (!active) return Promise.reject(new Error("Please review your savings again."));
      attempted = true;
      active = false;
      removeAbort();
      try {
        const sent = prepared.send(options);
        confirmation = sent.then(async () => {
          try {
            return await reconcile(dependencies, review, signal);
          } catch (error) {
            if (signal?.aborted) throw error;
            if (error instanceof AdmissionReconciliationError) throw error;
            throw new AdmissionPostConfirmationReadError(error);
          }
        });
      } catch (error) {
        confirmation = Promise.reject(error);
      }
      return confirmation;
    },
  });
}

export type ConfirmedVisibilityScope = Readonly<{
  account: Address;
  pool: Address;
  handle: Hex;
}>;

export type ConfirmedVisibilityObservation = Readonly<
  ConfirmedVisibilityScope & { blockNumber: bigint; visible: boolean }
>;

export type ConfirmedVisibilityReadOptions<T> = Readonly<{
  read: () => Promise<T>;
  scope: ConfirmedVisibilityScope;
  observeConfirmedVisibility: (
    scope: ConfirmedVisibilityScope,
    signal?: AbortSignal,
  ) => Promise<ConfirmedVisibilityObservation>;
  signal?: AbortSignal;
}>;

function normalizedVisibilityScope(scope: ConfirmedVisibilityScope): ConfirmedVisibilityScope {
  if (
    !isAddress(scope.account) ||
    !isAddress(scope.pool) ||
    !isHex(scope.handle) ||
    scope.handle.length !== 66
  ) {
    throw new Error("Visibility scope is invalid.");
  }
  return Object.freeze({
    account: getAddress(scope.account),
    pool: getAddress(scope.pool),
    handle: scope.handle,
  });
}

function isConfirmedObservation(
  scope: ConfirmedVisibilityScope,
  observation: ConfirmedVisibilityObservation,
): boolean {
  return (
    typeof observation?.blockNumber === "bigint" &&
    observation.blockNumber >= 0n &&
    typeof observation.visible === "boolean" &&
    isAddress(observation.account) &&
    isAddress(observation.pool) &&
    isHex(observation.handle) &&
    getAddress(observation.account) === scope.account &&
    getAddress(observation.pool) === scope.pool &&
    observation.handle.toLowerCase() === scope.handle.toLowerCase()
  );
}

/**
 * The SDK already waits for delegation propagation. This adds one application
 * retry solely for a typed RPC rate limit after an independent confirmed read.
 */
export async function readWithConfirmedVisibility<T>(
  options: ConfirmedVisibilityReadOptions<T>,
): Promise<T> {
  assertActive(options.signal);
  const scope = normalizedVisibilityScope(options.scope);
  let firstError: unknown;
  try {
    const result = await options.read();
    assertActive(options.signal);
    return result;
  } catch (error) {
    assertActive(options.signal);
    firstError = error;
  }
  if (firstError instanceof NotEntitledError || !(firstError instanceof RpcRateLimitError)) {
    throw firstError;
  }
  let observation: ConfirmedVisibilityObservation;
  try {
    observation = await options.observeConfirmedVisibility(scope, options.signal);
    assertActive(options.signal);
  } catch {
    if (options.signal?.aborted) assertActive(options.signal);
    throw firstError;
  }
  if (!isConfirmedObservation(scope, observation) || !observation.visible) throw firstError;
  try {
    const result = await options.read();
    assertActive(options.signal);
    return result;
  } catch {
    assertActive(options.signal);
    // Preserve the original typed failure and its cause rather than masking it.
    throw firstError;
  }
}
