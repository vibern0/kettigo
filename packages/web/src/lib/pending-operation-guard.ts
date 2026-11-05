import { getAddress, type Address, type Hex } from "viem";
import { entryPoint07Address } from "viem/account-abstraction";

import type { SafeUserOperationIdentity } from "./smart-session.ts";

const CHAIN_ID = 11155111 as const;
const VERSION = 1 as const;
const MAX_BYTES = 16_384;
const EXPECTED_ENTRY_POINT = getAddress(entryPoint07Address);

export type PendingOperationPhase = "prepared" | "attempted";
export type PendingOperationRecord = Readonly<{
  version: 1;
  chainId: 11155111;
  entryPoint: Address;
  sender: Address;
  userOperationHash: Hex;
  createdAt: number;
  phase: PendingOperationPhase;
}>;
export type PendingOperationStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type PendingOperationLockManager = {
  request<T>(
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: unknown | null) => Promise<T> | T,
  ): Promise<T>;
};
export type PendingOperationManagerOptions = Readonly<{
  sender: Address;
  entryPoint?: Address;
  storage?: PendingOperationStorage;
  locks?: PendingOperationLockManager;
  now?: () => number;
  acquisitionTimeoutMs?: number;
}>;

export class PendingOperationBusyError extends Error {
  constructor() {
    super("Another operation review is in progress.");
    this.name = "PendingOperationBusyError";
  }
}
export class PendingOperationRecoveryBlockedError extends Error {
  readonly record?: PendingOperationRecord;
  constructor(
    message = "Operation recovery is required.",
    record?: PendingOperationRecord,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "PendingOperationRecoveryBlockedError";
    this.record = record;
  }
}

function blocked(message: string, cause?: unknown): never {
  throw new PendingOperationRecoveryBlockedError(message, undefined, cause);
}
function normalizeIdentity(
  value: SafeUserOperationIdentity,
  sender: Address,
): Omit<PendingOperationRecord, "version" | "createdAt" | "phase"> {
  if (!value || typeof value !== "object" || value.chainId !== CHAIN_ID)
    blocked("The operation identity is invalid.");
  let entryPoint: Address;
  let operationSender: Address;
  try {
    entryPoint = getAddress(value.entryPoint);
    operationSender = getAddress(value.sender);
  } catch {
    blocked("The operation identity is invalid.");
  }
  if (
    entryPoint !== EXPECTED_ENTRY_POINT ||
    operationSender !== sender ||
    !/^0x[\da-fA-F]{64}$/.test(value.userOperationHash)
  )
    blocked("The operation identity is outside this account scope.");
  return {
    chainId: CHAIN_ID,
    entryPoint,
    sender: operationSender,
    userOperationHash: value.userOperationHash as Hex,
  };
}
function sameIdentity(
  record: PendingOperationRecord,
  identity: Omit<PendingOperationRecord, "version" | "createdAt" | "phase">,
): boolean {
  return (
    record.chainId === identity.chainId &&
    record.entryPoint === identity.entryPoint &&
    record.sender === identity.sender &&
    record.userOperationHash.toLowerCase() === identity.userOperationHash.toLowerCase()
  );
}
function freeze(record: PendingOperationRecord): PendingOperationRecord {
  return Object.freeze(record);
}
function itemFromJson(raw: string): Record<string, unknown> {
  if (raw.length > MAX_BYTES) blocked("The saved operation record is too large.");
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value))
      blocked("The saved operation record is malformed.");
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof PendingOperationRecoveryBlockedError) throw error;
    return blocked("The saved operation record is malformed.", error);
  }
}
function isRecordShape(item: Record<string, unknown>): boolean {
  return (
    Object.keys(item).sort().join(",") ===
      "chainId,createdAt,entryPoint,phase,sender,userOperationHash,version" &&
    item.version === VERSION &&
    item.chainId === CHAIN_ID &&
    (item.phase === "prepared" || item.phase === "attempted") &&
    Number.isSafeInteger(item.createdAt) &&
    (item.createdAt as number) >= 0
  );
}
function storedAddresses(item: Record<string, unknown>): { entryPoint: Address; sender: Address } {
  try {
    return {
      entryPoint: getAddress(item.entryPoint as string),
      sender: getAddress(item.sender as string),
    };
  } catch (error) {
    return blocked("The saved operation record is malformed.", error);
  }
}
function parseStoredRecord(
  raw: string,
  entryPoint: Address,
  sender: Address,
): PendingOperationRecord {
  const item = itemFromJson(raw);
  if (!isRecordShape(item)) blocked("The saved operation record is malformed.");
  const saved = storedAddresses(item);
  if (
    saved.entryPoint !== entryPoint ||
    saved.sender !== sender ||
    typeof item.userOperationHash !== "string" ||
    !/^0x[\da-fA-F]{64}$/.test(item.userOperationHash)
  )
    blocked("The saved operation record is for a different account.");
  return freeze({
    version: VERSION,
    chainId: CHAIN_ID,
    entryPoint: saved.entryPoint,
    sender: saved.sender,
    userOperationHash: item.userOperationHash as Hex,
    createdAt: item.createdAt as number,
    phase: item.phase as PendingOperationPhase,
  });
}

export type PendingOperationLease = Readonly<{
  readCurrent(): PendingOperationRecord | null;
  stagePrepared(identity: SafeUserOperationIdentity): PendingOperationRecord;
  markAttempted(identity: SafeUserOperationIdentity): PendingOperationRecord;
  clearMatching(identity: SafeUserOperationIdentity): boolean;
  assertActive(): void;
  release(): Promise<void>;
}>;

export type PendingOperationManager = Readonly<{
  storageKey: string;
  readCurrent(): PendingOperationRecord | null;
  acquireReview(): Promise<PendingOperationLease>;
  acquireRecovery(): Promise<PendingOperationLease>;
}>;

export function createPendingOperationManager(
  options: PendingOperationManagerOptions,
): PendingOperationManager {
  let sender: Address;
  let entryPoint: Address;
  try {
    sender = getAddress(options.sender);
    entryPoint = getAddress(options.entryPoint ?? EXPECTED_ENTRY_POINT);
  } catch {
    return blocked("The operation scope is invalid.");
  }
  if (entryPoint !== EXPECTED_ENTRY_POINT) return blocked("The operation scope is invalid.");
  const storage = options.storage;
  const locks = options.locks;
  const now = options.now ?? Date.now;
  const storageKey = `kettigo:pending-user-operation:v${VERSION}:${CHAIN_ID}:${entryPoint.toLowerCase()}:${sender.toLowerCase()}`;
  const lockName = `kettigo:pending-user-operation:${CHAIN_ID}:${entryPoint.toLowerCase()}:${sender.toLowerCase()}`;

  const storageOrBlocked = (): PendingOperationStorage => {
    if (
      !storage ||
      typeof storage.getItem !== "function" ||
      typeof storage.setItem !== "function" ||
      typeof storage.removeItem !== "function"
    )
      blocked("Operation storage is unavailable.");
    return storage;
  };
  const parse = (raw: string): PendingOperationRecord => parseStoredRecord(raw, entryPoint, sender);
  const read = (): PendingOperationRecord | null => {
    let raw: string | null;
    try {
      raw = storageOrBlocked().getItem(storageKey);
    } catch (error) {
      return blocked("Operation storage could not be read.", error);
    }
    return raw === null ? null : parse(raw);
  };
  const persist = (record: PendingOperationRecord | null): void => {
    const target = storageOrBlocked();
    try {
      if (record === null) target.removeItem(storageKey);
      else target.setItem(storageKey, JSON.stringify(record));
      const raw = target.getItem(storageKey);
      if ((record === null && raw !== null) || (record !== null && raw !== JSON.stringify(record)))
        blocked("Operation storage could not be verified.");
      if (record !== null) parse(raw!);
    } catch (error) {
      if (error instanceof PendingOperationRecoveryBlockedError) throw error;
      blocked("Operation storage could not be written.", error);
    }
  };
  const acquire = async (kind: "review" | "recovery"): Promise<PendingOperationLease> => {
    if (!locks || typeof locks.request !== "function") blocked("Operation locks are unavailable.");
    let resolveLease!: (lease: PendingOperationLease | null) => void;
    let rejectLease!: (error: unknown) => void;
    const granted = new Promise<PendingOperationLease | null>((resolve, reject) => {
      resolveLease = resolve;
      rejectLease = reject;
    });
    let released = false;
    let active = false;
    let expired = false;
    let releaseHold!: () => void;
    let requestDone: Promise<unknown> = Promise.resolve();
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const makeLease = (): PendingOperationLease =>
      Object.freeze({
        readCurrent: read,
        assertActive: () => {
          if (!active) blocked("This operation lease is no longer active.");
        },
        stagePrepared: (value) => {
          if (!active) blocked("This operation lease is no longer active.");
          const identity = normalizeIdentity(value, sender);
          const existing = read();
          if (existing && !sameIdentity(existing, identity))
            throw new PendingOperationRecoveryBlockedError(undefined, existing);
          if (existing) return existing;
          const createdAt = now();
          if (!Number.isSafeInteger(createdAt) || createdAt < 0)
            blocked("The operation clock is invalid.");
          const record = freeze({
            version: VERSION,
            ...identity,
            createdAt,
            phase: "prepared" as const,
          });
          persist(record);
          return record;
        },
        markAttempted: (value) => {
          if (!active) blocked("This operation lease is no longer active.");
          const identity = normalizeIdentity(value, sender);
          const existing = read();
          if (!existing || !sameIdentity(existing, identity) || existing.phase !== "prepared")
            throw new PendingOperationRecoveryBlockedError(undefined, existing ?? undefined);
          const record = freeze({ ...existing, phase: "attempted" as const });
          persist(record);
          return record;
        },
        clearMatching: (value) => {
          if (!active) blocked("This operation lease is no longer active.");
          const existing = read();
          const identity = normalizeIdentity(value, sender);
          if (!existing || !sameIdentity(existing, identity)) return false;
          persist(null);
          return true;
        },
        release: async () => {
          if (!released) {
            released = true;
            active = false;
            releaseHold();
          }
          await requestDone;
        },
      });
    requestDone = Promise.resolve().then(() =>
      locks.request(lockName, { mode: "exclusive", ifAvailable: true }, async (lock) => {
        if (!lock) {
          resolveLease(null);
          return;
        }
        if (expired) return;
        active = true;
        try {
          if (kind === "review") {
            const existing = read();
            if (existing) throw new PendingOperationRecoveryBlockedError(undefined, existing);
          }
          resolveLease(makeLease());
          await hold;
        } catch (error) {
          rejectLease(error);
          throw error;
        } finally {
          active = false;
        }
      }),
    );
    void requestDone.catch((error) =>
      rejectLease(
        new PendingOperationRecoveryBlockedError(
          "Operation lock acquisition failed.",
          undefined,
          error,
        ),
      ),
    );
    const timeoutMs = options.acquisitionTimeoutMs ?? 2_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      granted,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          resolve(null);
        }, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!result) throw new PendingOperationBusyError();
    return result;
  };
  return Object.freeze({
    storageKey,
    readCurrent: read,
    acquireReview: () => acquire("review"),
    acquireRecovery: () => acquire("recovery"),
  });
}
