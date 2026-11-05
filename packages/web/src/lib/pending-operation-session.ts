import type { Address, Hex } from "viem";

import {
  createPendingOperationManager,
  PendingOperationRecoveryBlockedError,
  type PendingOperationLockManager,
  type PendingOperationRecord,
  type PendingOperationStorage,
} from "./pending-operation-guard.ts";
import {
  SafeUserOperationFailedError,
  SafeUserOperationNotSubmittedError,
  SafeUserOperationRejectedError,
} from "./passkey-operation.ts";
import type {
  PasskeySmartSession,
  PendingOperationRecoveryResult,
  PreparedSmartTransaction,
  PrepareSmartTransactionOptions,
  SafeUserOperationIdentity,
  SmartAccountCall,
  SmartTransactionOptions,
} from "./smart-session.ts";

export type { PendingOperationLockManager } from "./pending-operation-guard.ts";

type InternalTransactionOptions = SmartTransactionOptions & {
  __assertPendingOperationLease?: () => void;
};

export type PendingOperationSessionOptions = Readonly<{
  storage?: PendingOperationStorage;
  locks?: PendingOperationLockManager;
  preparationTimeoutMs?: number;
}>;

function unavailable(): PendingOperationStorage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function browserLocks(): PendingOperationLockManager | undefined {
  try {
    return typeof navigator === "undefined" ? undefined : navigator.locks;
  } catch {
    return undefined;
  }
}

function operation(record: PendingOperationRecord): SafeUserOperationIdentity {
  return Object.freeze({
    chainId: record.chainId,
    entryPoint: record.entryPoint,
    sender: record.sender,
    userOperationHash: record.userOperationHash,
  });
}

function clearKnown(
  lease: { clearMatching(identity: SafeUserOperationIdentity): boolean },
  error: unknown,
  staged: SafeUserOperationIdentity | undefined,
): void {
  if (
    error instanceof SafeUserOperationNotSubmittedError ||
    error instanceof SafeUserOperationRejectedError ||
    (error instanceof SafeUserOperationFailedError &&
      staged &&
      error.operation.userOperationHash.toLowerCase() === staged.userOperationHash.toLowerCase())
  )
    lease.clearMatching(error.operation);
}

function racePreparation<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal?.aborted)
    return Promise.reject(signal.reason ?? new DOMException("Aborted.", "AbortError"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbort = () => undefined;
  const stopped = new Promise<never>((_, reject) => {
    const abort = () => reject(signal?.reason ?? new DOMException("Aborted.", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    removeAbort = () => {
      signal?.removeEventListener("abort", abort);
    };
  });
  const timed = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Transaction preparation timed out.")), timeoutMs);
  });
  return Promise.race([promise, timed, stopped]).finally(() => {
    if (timer) clearTimeout(timer);
    removeAbort();
  });
}

/** Adds a durable same-origin operation fence without changing raw signing behavior. */
export function createGuardedPasskeySession(
  raw: PasskeySmartSession,
  options: PendingOperationSessionOptions = {},
): PasskeySmartSession {
  const manager = () =>
    createPendingOperationManager({
      sender: raw.address as Address,
      storage: options.storage ?? unavailable(),
      locks: options.locks ?? browserLocks(),
    });
  const release = (lease: { release(): Promise<void> }) =>
    void lease.release().catch(() => undefined);
  const timeoutMs = Math.max(1, options.preparationTimeoutMs ?? 30_000);

  const guardedOptions = (
    lease: {
      assertActive(): void;
      stagePrepared(identity: SafeUserOperationIdentity): PendingOperationRecord;
      markAttempted(identity: SafeUserOperationIdentity): PendingOperationRecord;
    },
    caller: SmartTransactionOptions | undefined,
    staged: { identity?: SafeUserOperationIdentity; attempted?: () => void },
  ): InternalTransactionOptions => ({
    ...caller,
    __assertPendingOperationLease: () => lease.assertActive(),
    onOperationPrepared: async (identity) => {
      lease.assertActive();
      staged.identity = operation(lease.stagePrepared(identity));
      await caller?.onOperationPrepared?.(identity);
      lease.assertActive();
      staged.identity = operation(lease.markAttempted(identity));
      staged.attempted?.();
    },
  });

  const settle = async (
    lease: {
      clearMatching(identity: SafeUserOperationIdentity): boolean;
      release(): Promise<void>;
    },
    result: Promise<Hex>,
    staged: { identity?: SafeUserOperationIdentity },
  ): Promise<Hex> => {
    try {
      const hash = await result;
      if (!staged.identity)
        throw new PendingOperationRecoveryBlockedError("The operation was never durably staged.");
      lease.clearMatching(staged.identity);
      return hash;
    } catch (error) {
      try {
        clearKnown(lease, error, staged.identity);
      } catch {
        // The original transaction error is more useful and the guard remains fail-closed.
      }
      throw error;
    } finally {
      release(lease);
    }
  };

  return {
    address: raw.address,
    signTypedData: raw.signTypedData.bind(raw),
    lookupUserOperation: raw.lookupUserOperation?.bind(raw),
    getPendingOperation: () => manager().readCurrent(),
    recoverPendingOperation: async (): Promise<PendingOperationRecoveryResult> => {
      const current = manager().readCurrent();
      if (!current) return Object.freeze({ state: "none" as const });
      if (!raw.lookupUserOperation)
        throw new PendingOperationRecoveryBlockedError(
          "Operation recovery is unavailable.",
          current,
        );
      const lease = await manager().acquireRecovery();
      try {
        const record = lease.readCurrent();
        if (!record) return Object.freeze({ state: "none" as const });
        const identity = operation(record);
        if (record.phase === "prepared") {
          lease.clearMatching(identity);
          return Object.freeze({ state: "not-submitted" as const, operation: identity });
        }
        const result = await raw.lookupUserOperation(identity);
        if (result.state !== "pending") lease.clearMatching(identity);
        return result;
      } finally {
        await lease.release();
      }
    },
    prepareTransaction: async (
      calls: SmartAccountCall[],
      preparation: PrepareSmartTransactionOptions = {},
    ): Promise<PreparedSmartTransaction> => {
      const lease = await manager().acquireReview();
      let active = true;
      const rawPreparation = raw.prepareTransaction(calls);
      void rawPreparation.then(
        (prepared) => {
          if (!active) prepared.cancel();
        },
        () => undefined,
      );
      let prepared: PreparedSmartTransaction;
      try {
        prepared = await racePreparation(rawPreparation, timeoutMs, preparation.signal);
      } catch (error) {
        active = false;
        release(lease);
        throw error;
      }
      return {
        cancel() {
          if (!active) return;
          active = false;
          try {
            prepared.cancel();
          } finally {
            release(lease);
          }
        },
        send(transactionOptions?: SmartTransactionOptions): Promise<Hex> {
          if (!active)
            return Promise.reject(new Error("Please go back and review your transaction again."));
          try {
            lease.assertActive();
            // This invocation intentionally happens before any await: WebAuthn needs the click stack.
            const staged: { identity?: SafeUserOperationIdentity } = {};
            const sent = prepared.send(guardedOptions(lease, transactionOptions, staged));
            active = false;
            return settle(lease, sent, staged);
          } catch (error) {
            active = false;
            release(lease);
            return Promise.reject(error);
          }
        },
      };
    },
    sendTransaction: async (calls, transactionOptions) => {
      const lease = await manager().acquireReview();
      let resolveAttempted!: () => void;
      const attempted = new Promise<void>((resolve) => {
        resolveAttempted = resolve;
      });
      const staged: { identity?: SafeUserOperationIdentity; attempted?: () => void } = {
        attempted: resolveAttempted,
      };
      try {
        lease.assertActive();
        const sent = settle(
          lease,
          raw.sendTransaction(calls, guardedOptions(lease, transactionOptions, staged)),
          staged,
        );
        const handoff = racePreparation(attempted, timeoutMs, undefined).then(() => sent);
        return await Promise.race([sent, handoff]);
      } catch (error) {
        if (staged.identity) {
          try {
            lease.clearMatching(staged.identity);
          } catch {
            // A cleanup failure remains fail-closed; do not replace the first error.
          }
        }
        release(lease);
        throw error;
      }
    },
  };
}
