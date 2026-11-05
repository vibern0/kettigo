import { NotEntitledError, RpcRateLimitError } from "@zama-fhe/sdk";
import { getAddress, type Address, type Hex } from "viem";

import type { PasskeySmartSession, PreparedSmartTransaction } from "./smart-session.ts";

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

function assertActive(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted.", "AbortError");
}

async function reconcile(
  dependencies: AdmissionCoordinatorDependencies,
  review: AdmissionReview,
): Promise<AdmissionResult> {
  const [membershipIndex, pending] = await Promise.all([
    dependencies.readMembershipIndex(dependencies.account),
    dependencies.readPendingAdmission(dependencies.account),
  ]);
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
      const pending = await dependencies.readPendingAdmission(dependencies.account, signal);
      assertActive(signal);
      if (!pending.requested) throw new AdmissionStaleError();
      const decrypted = await dependencies.decryptPublicBoolean(pending.marker);
      assertActive(signal);
      if (typeof decrypted.clearValue !== "boolean") {
        throw new Error("Reveal result is not a boolean.");
      }
      return Object.freeze({
        pending,
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
        { signal },
      );
      assertActive(signal);
      return readyAdmission(prepared, dependencies, review);
    },
  });
}

function readyAdmission(
  prepared: PreparedSmartTransaction,
  dependencies: AdmissionCoordinatorDependencies,
  review: AdmissionReview,
) {
  return Object.freeze({
    cancel: () => prepared.cancel(),
    // Do not make this async: prepared.send must begin within the Confirm gesture stack.
    confirm: () => {
      const sent = prepared.send();
      return sent.then(() => reconcile(dependencies, review));
    },
  });
}

export type ConfirmedVisibilityReadOptions<T> = Readonly<{
  read: () => Promise<T>;
  observeConfirmedVisibility: (signal?: AbortSignal) => Promise<boolean>;
  signal?: AbortSignal;
  isRateLimitError?: (error: unknown) => boolean;
}>;

/**
 * The SDK already waits for delegation propagation. This adds one application
 * retry solely for a typed RPC rate limit after an independent confirmed read.
 */
export async function readWithConfirmedVisibility<T>(
  options: ConfirmedVisibilityReadOptions<T>,
): Promise<T> {
  assertActive(options.signal);
  try {
    return await options.read();
  } catch (firstError) {
    assertActive(options.signal);
    if (firstError instanceof NotEntitledError) throw firstError;
    const isRateLimit =
      options.isRateLimitError ?? ((error: unknown) => error instanceof RpcRateLimitError);
    if (!isRateLimit(firstError)) throw firstError;
    const visible = await options.observeConfirmedVisibility(options.signal);
    assertActive(options.signal);
    if (!visible) throw firstError;
    try {
      return await options.read();
    } catch {
      // Preserve the original typed failure and its cause rather than masking it.
      throw firstError;
    }
  }
}
