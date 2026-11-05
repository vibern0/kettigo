import { decodeEventLog, getAddress, getEventSelector, type Address, type Hex } from "viem";
import { entryPoint07Abi, entryPoint07Address } from "viem/account-abstraction";

export type SafeUserOperationIdentity = Readonly<{
  chainId: 11155111;
  entryPoint: Address;
  sender: Address;
  userOperationHash: Hex;
}>;
export type SafeUserOperationReceipt =
  | Readonly<{ state: "pending"; operation: SafeUserOperationIdentity }>
  | Readonly<{
      state: "confirmed" | "failed";
      operation: SafeUserOperationIdentity;
      transactionHash: Hex;
      blockNumber: bigint;
      blockHash: Hex;
    }>;
export class SafeUserOperationIntegrityError extends Error {
  readonly operation: SafeUserOperationIdentity;
  constructor(operation: SafeUserOperationIdentity, message: string) {
    super(message);
    this.name = "SafeUserOperationIntegrityError";
    this.operation = operation;
  }
}
export type BundlerReceipt = {
  success: boolean;
  userOpHash: string;
  sender: string;
  receipt: { transactionHash: string };
};
export type EthereumLog = {
  address: string;
  topics: readonly string[];
  data: string;
  transactionHash?: string;
  blockHash?: string;
  blockNumber?: bigint;
};
export type EthereumReceipt = {
  transactionHash: string;
  status: "success" | "reverted" | string;
  blockHash: string;
  blockNumber: bigint;
  logs: readonly EthereumLog[];
};
export type EthereumBlock = { hash: string; number: bigint };
export type CanonicalReceiptDependencies = {
  getUserOperationReceipt: (
    userOperationHash: Hex,
    options?: { signal?: AbortSignal },
  ) => Promise<BundlerReceipt | null>;
  getTransactionReceipt: (
    input: { hash: Hex },
    options?: { signal?: AbortSignal },
  ) => Promise<EthereumReceipt | null>;
  getBlock: (
    input: { blockNumber: bigint },
    options?: { signal?: AbortSignal },
  ) => Promise<EthereumBlock | null>;
};
export type CanonicalReceiptOptions = { timeoutMs?: number; signal?: AbortSignal };

const DEFAULT_LOOKUP_TIMEOUT_MS = 10_000;
const EXPECTED_ENTRY_POINT = getAddress(entryPoint07Address);
const USER_OPERATION_EVENT_TOPIC = getEventSelector(
  entryPoint07Abi.find((item) => item.type === "event" && item.name === "UserOperationEvent")!,
);
const timedOut = Symbol("timed-out");

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
function pending(operation: SafeUserOperationIdentity): SafeUserOperationReceipt {
  return Object.freeze({ state: "pending" as const, operation });
}
function integrity(operation: SafeUserOperationIdentity, message: string): never {
  throw new SafeUserOperationIntegrityError(operation, message);
}
function abortError(signal: AbortSignal): never {
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The receipt lookup was aborted.", "AbortError");
}
function hash(value: unknown, operation: SafeUserOperationIdentity, message: string): Hex {
  if (typeof value !== "string" || !/^0x[\da-fA-F]{64}$/.test(value))
    return integrity(operation, message);
  return value as Hex;
}
function address(value: unknown, operation: SafeUserOperationIdentity, message: string): Address {
  if (typeof value !== "string") return integrity(operation, message);
  try {
    return getAddress(value);
  } catch {
    return integrity(operation, message);
  }
}
function canonicalOperation(value: SafeUserOperationIdentity): SafeUserOperationIdentity {
  const fallback = Object.freeze({
    chainId: 11155111 as const,
    entryPoint: EXPECTED_ENTRY_POINT,
    sender: EXPECTED_ENTRY_POINT,
    userOperationHash: `0x${"00".repeat(32)}` as Hex,
  });
  if (!value || typeof value !== "object")
    return integrity(fallback, "The operation identity is invalid.");
  const sender = address(value.sender, fallback, "The operation identity has an invalid sender.");
  const userOperationHash = hash(
    value.userOperationHash,
    fallback,
    "The operation identity has an invalid hash.",
  );
  const normalized = Object.freeze({
    chainId: 11155111 as const,
    entryPoint: address(
      value.entryPoint,
      fallback,
      "The operation identity has an invalid EntryPoint.",
    ),
    sender,
    userOperationHash,
  });
  if (value.chainId !== 11155111)
    return integrity(normalized, "The operation identity is for a different chain.");
  if (normalized.entryPoint !== EXPECTED_ENTRY_POINT)
    return integrity(normalized, "The operation identity has an unexpected EntryPoint.");
  return normalized;
}
async function bounded<T>(
  deadline: number,
  signal: AbortSignal,
  callback: () => Promise<T>,
): Promise<T | typeof timedOut> {
  if (signal.aborted) return abortError(signal);
  const remaining = deadline - Date.now();
  if (remaining <= 0) return timedOut;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbort: () => void = () => undefined;
  const work = Promise.resolve().then(callback);
  void work.catch(() => undefined);
  const timeout = new Promise<typeof timedOut>((resolve) => {
    timer = setTimeout(() => resolve(timedOut), remaining);
  });
  const cancelled = new Promise<never>((_, reject) => {
    const abort = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("The receipt lookup was aborted.", "AbortError"),
      );
    signal.addEventListener("abort", abort, { once: true });
    removeAbort = () => signal.removeEventListener("abort", abort);
  });
  try {
    return await Promise.race([work, timeout, cancelled]);
  } finally {
    if (timer) clearTimeout(timer);
    removeAbort();
  }
}
async function readOrPending<T>(
  deadline: number,
  signal: AbortSignal,
  callback: () => Promise<T>,
): Promise<T | typeof timedOut | null> {
  try {
    return await bounded(deadline, signal, callback);
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}
function expectedEmitter(log: EthereumLog, operation: SafeUserOperationIdentity): boolean {
  try {
    return typeof log.address === "string" && getAddress(log.address) === operation.entryPoint;
  } catch {
    return false;
  }
}
function decodedEvent(log: EthereumLog, operation: SafeUserOperationIdentity) {
  try {
    return decodeEventLog({
      abi: entryPoint07Abi,
      data: log.data as Hex,
      topics: log.topics as [Hex, ...Hex[]],
      strict: true,
    });
  } catch {
    return integrity(operation, "The chain returned a malformed UserOperationEvent.");
  }
}
function validateEventLocation(
  log: EthereumLog,
  operation: SafeUserOperationIdentity,
  transactionHash: Hex,
  blockHash: Hex,
  blockNumber: bigint,
): void {
  if (
    log.transactionHash &&
    !sameHex(
      hash(log.transactionHash, operation, "The operation event has an invalid transaction hash."),
      transactionHash,
    )
  )
    integrity(operation, "The operation event has a different transaction hash.");
  if (
    log.blockHash &&
    !sameHex(
      hash(log.blockHash, operation, "The operation event has an invalid block hash."),
      blockHash,
    )
  )
    integrity(operation, "The operation event has a different block hash.");
  if (log.blockNumber !== undefined && log.blockNumber !== blockNumber)
    integrity(operation, "The operation event has a different block number.");
}
function eventSuccess(
  log: EthereumLog,
  operation: SafeUserOperationIdentity,
  transactionHash: Hex,
  blockHash: Hex,
  blockNumber: bigint,
): boolean | undefined {
  if (
    !expectedEmitter(log, operation) ||
    !Array.isArray(log.topics) ||
    log.topics[0]?.toLowerCase() !== USER_OPERATION_EVENT_TOPIC.toLowerCase()
  )
    return undefined;
  const decoded = decodedEvent(log, operation);
  if (decoded.eventName !== "UserOperationEvent") return undefined;
  const args = decoded.args as { userOpHash?: string; sender?: string; success?: boolean };
  if (!args.userOpHash || !sameHex(args.userOpHash, operation.userOperationHash)) return undefined;
  if (
    address(args.sender, operation, "The operation event has an invalid sender.") !==
    operation.sender
  )
    return integrity(operation, "The operation event has a different sender.");
  validateEventLocation(log, operation, transactionHash, blockHash, blockNumber);
  if (typeof args.success !== "boolean")
    return integrity(operation, "The chain returned an invalid operation event.");
  return args.success;
}
function transactionHashFromBundler(
  bundler: BundlerReceipt,
  operation: SafeUserOperationIdentity,
): Hex {
  if (typeof bundler !== "object" || typeof bundler.success !== "boolean")
    integrity(operation, "The relay returned an invalid operation receipt.");
  if (
    !sameHex(
      hash(bundler.userOpHash, operation, "The relay returned an invalid operation hash."),
      operation.userOperationHash,
    )
  )
    integrity(operation, "The relay returned a different operation hash.");
  if (
    address(bundler.sender, operation, "The relay returned an invalid operation sender.") !==
    operation.sender
  )
    integrity(operation, "The relay returned a different operation sender.");
  return hash(
    bundler.receipt?.transactionHash,
    operation,
    "The relay returned an invalid transaction hash.",
  );
}
function validateReceipt(
  receipt: EthereumReceipt,
  operation: SafeUserOperationIdentity,
  transactionHash: Hex,
): Hex | undefined {
  if (
    typeof receipt !== "object" ||
    !sameHex(
      hash(receipt.transactionHash, operation, "The chain returned an invalid transaction hash."),
      transactionHash,
    )
  )
    integrity(operation, "The chain returned a different transaction hash.");
  if (receipt.status !== "success") return undefined;
  const blockHash = hash(receipt.blockHash, operation, "The chain returned an invalid block hash.");
  if (
    typeof receipt.blockNumber !== "bigint" ||
    receipt.blockNumber < 0n ||
    !Array.isArray(receipt.logs)
  )
    integrity(operation, "The chain returned an invalid transaction receipt.");
  return blockHash;
}
function canonicalBlock(
  block: EthereumBlock | typeof timedOut | null,
  receipt: EthereumReceipt,
  blockHash: Hex,
  operation: SafeUserOperationIdentity,
): boolean {
  return (
    block !== timedOut &&
    block !== null &&
    block.number === receipt.blockNumber &&
    sameHex(hash(block.hash, operation, "The chain returned an invalid block hash."), blockHash)
  );
}
function selectEvent(
  receipt: EthereumReceipt,
  operation: SafeUserOperationIdentity,
  transactionHash: Hex,
  blockHash: Hex,
): boolean | undefined {
  let selected: boolean | undefined;
  for (const log of receipt.logs) {
    if (!log || typeof log !== "object") continue;
    const success = eventSuccess(log, operation, transactionHash, blockHash, receipt.blockNumber);
    if (success === undefined) continue;
    if (selected !== undefined)
      integrity(operation, "The chain returned duplicate operation events.");
    selected = success;
  }
  return selected;
}

/** Reconciles independent relay and Ethereum evidence for one EntryPoint v0.7 operation. */
export async function lookupCanonicalUserOperationReceipt(
  dependencies: CanonicalReceiptDependencies,
  rawOperation: SafeUserOperationIdentity,
  options: CanonicalReceiptOptions = {},
): Promise<SafeUserOperationReceipt> {
  const operation = canonicalOperation(rawOperation);
  if (options.signal?.aborted) abortError(options.signal);
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  const deadline = Date.now() + Math.max(0, options.timeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS);
  try {
    const bundler = await readOrPending(deadline, controller.signal, () =>
      dependencies.getUserOperationReceipt(operation.userOperationHash, {
        signal: controller.signal,
      }),
    );
    if (bundler === timedOut || bundler === null) return pending(operation);
    const transactionHash = transactionHashFromBundler(bundler, operation);
    const receipt = await readOrPending(deadline, controller.signal, () =>
      dependencies.getTransactionReceipt({ hash: transactionHash }, { signal: controller.signal }),
    );
    if (receipt === timedOut || receipt === null) return pending(operation);
    const blockHash = validateReceipt(receipt, operation, transactionHash);
    if (blockHash === undefined) return pending(operation);
    const block = await readOrPending(deadline, controller.signal, () =>
      dependencies.getBlock({ blockNumber: receipt.blockNumber }, { signal: controller.signal }),
    );
    if (!canonicalBlock(block, receipt, blockHash, operation)) return pending(operation);
    const success = selectEvent(receipt, operation, transactionHash, blockHash);
    if (success === undefined) return pending(operation);
    if (success !== bundler.success)
      integrity(operation, "The relay and chain disagree about operation success.");
    return Object.freeze({
      state: success ? ("confirmed" as const) : ("failed" as const),
      operation,
      transactionHash,
      blockNumber: receipt.blockNumber,
      blockHash,
    });
  } finally {
    controller.abort();
    options.signal?.removeEventListener("abort", abort);
  }
}
