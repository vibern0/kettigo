import { decodeEventLog, getAddress, getEventSelector, type Address, type Hex } from "viem";
import { entryPoint07Abi } from "viem/account-abstraction";

export type SafeUserOperationIdentity = Readonly<{
  chainId: 11155111;
  entryPoint: Address;
  sender: Address;
  userOperationHash: Hex;
}>;

export type SafeUserOperationReceipt =
  | Readonly<{ state: "pending"; operation: SafeUserOperationIdentity }>
  | Readonly<{
      state: "confirmed";
      operation: SafeUserOperationIdentity;
      transactionHash: Hex;
      blockNumber: bigint;
      blockHash: Hex;
    }>
  | Readonly<{
      state: "failed";
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

function address(value: unknown, operation: SafeUserOperationIdentity, message: string): Address {
  if (typeof value !== "string") return integrity(operation, message);
  try {
    return getAddress(value);
  } catch {
    return integrity(operation, message);
  }
}

function hash(value: unknown, operation: SafeUserOperationIdentity, message: string): Hex {
  if (typeof value !== "string" || !/^0x[\da-fA-F]{64}$/.test(value))
    return integrity(operation, message);
  return value as Hex;
}

async function bounded<T>(
  deadline: number,
  signal: AbortSignal,
  callback: () => Promise<T>,
): Promise<T | typeof timedOut> {
  const remaining = deadline - Date.now();
  if (remaining <= 0 || signal.aborted) return timedOut;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = Promise.resolve().then(callback);
  // A non-cooperating RPC promise can still settle after we return. Observe its
  // rejection so a timeout never creates an unhandled rejection.
  void work.catch(() => undefined);
  const timeout = new Promise<typeof timedOut>((resolve) => {
    timer = setTimeout(() => resolve(timedOut), remaining);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Reconciles a bundler receipt with the independently-read Ethereum receipt,
 * block, and exactly one EntryPoint 0.7 UserOperationEvent.
 */
export async function lookupCanonicalUserOperationReceipt(
  dependencies: CanonicalReceiptDependencies,
  operation: SafeUserOperationIdentity,
  options: CanonicalReceiptOptions = {},
): Promise<SafeUserOperationReceipt> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const bundler = await bounded(deadline, controller.signal, () =>
      dependencies.getUserOperationReceipt(operation.userOperationHash, {
        signal: controller.signal,
      }),
    );
    if (bundler === timedOut || controller.signal.aborted || bundler === null)
      return pending(operation);
    if (typeof bundler !== "object" || typeof bundler.success !== "boolean")
      integrity(operation, "The relay returned an invalid operation receipt.");
    if (
      !sameHex(
        hash(bundler.userOpHash, operation, "The relay returned an invalid operation hash."),
        operation.userOperationHash,
      )
    ) {
      integrity(operation, "The relay returned a different operation hash.");
    }
    if (
      address(bundler.sender, operation, "The relay returned an invalid operation sender.") !==
      operation.sender
    ) {
      integrity(operation, "The relay returned a different operation sender.");
    }
    const transactionHash = hash(
      bundler.receipt?.transactionHash,
      operation,
      "The relay returned an invalid transaction hash.",
    );
    let receipt: EthereumReceipt | null | typeof timedOut;
    try {
      receipt = await bounded(deadline, controller.signal, () =>
        dependencies.getTransactionReceipt(
          { hash: transactionHash },
          { signal: controller.signal },
        ),
      );
    } catch {
      return pending(operation);
    }
    if (receipt === timedOut || controller.signal.aborted || receipt === null)
      return pending(operation);
    if (
      typeof receipt !== "object" ||
      !sameHex(
        hash(receipt.transactionHash, operation, "The chain returned an invalid transaction hash."),
        transactionHash,
      )
    ) {
      integrity(operation, "The chain returned a different transaction hash.");
    }
    if (receipt.status !== "success") return pending(operation);
    const blockHash = hash(
      receipt.blockHash,
      operation,
      "The chain returned an invalid block hash.",
    );
    if (
      typeof receipt.blockNumber !== "bigint" ||
      receipt.blockNumber < 0n ||
      !Array.isArray(receipt.logs)
    ) {
      integrity(operation, "The chain returned an invalid transaction receipt.");
    }
    let block: EthereumBlock | null | typeof timedOut;
    try {
      block = await bounded(deadline, controller.signal, () =>
        dependencies.getBlock({ blockNumber: receipt.blockNumber }, { signal: controller.signal }),
      );
    } catch {
      return pending(operation);
    }
    if (block === timedOut || controller.signal.aborted || block === null)
      return pending(operation);
    if (
      block.number !== receipt.blockNumber ||
      !sameHex(hash(block.hash, operation, "The chain returned an invalid block hash."), blockHash)
    )
      return pending(operation);

    let matching = 0;
    let success = false;
    for (const log of receipt.logs) {
      if (
        !log ||
        !Array.isArray(log.topics) ||
        log.topics[0]?.toLowerCase() !== USER_OPERATION_EVENT_TOPIC.toLowerCase()
      )
        continue;
      let decoded: ReturnType<typeof decodeEventLog>;
      try {
        decoded = decodeEventLog({
          abi: entryPoint07Abi,
          data: log.data as Hex,
          topics: log.topics as [Hex, ...Hex[]],
          strict: true,
        });
      } catch {
        integrity(operation, "The chain returned a malformed UserOperationEvent.");
      }
      if (decoded.eventName !== "UserOperationEvent") continue;
      const args = decoded.args as { userOpHash?: string; sender?: string; success?: boolean };
      if (!args.userOpHash || !sameHex(args.userOpHash, operation.userOperationHash)) continue;
      if (
        address(log.address, operation, "The chain returned an invalid event address.") !==
        operation.entryPoint
      )
        integrity(operation, "The operation event came from a different EntryPoint.");
      if (
        address(args.sender, operation, "The chain returned an invalid event sender.") !==
        operation.sender
      )
        integrity(operation, "The operation event has a different sender.");
      if (
        log.transactionHash &&
        !sameHex(
          hash(
            log.transactionHash,
            operation,
            "The chain returned an invalid event transaction hash.",
          ),
          transactionHash,
        )
      )
        integrity(operation, "The operation event has a different transaction hash.");
      if (
        log.blockHash &&
        !sameHex(
          hash(log.blockHash, operation, "The chain returned an invalid event block hash."),
          blockHash,
        )
      )
        integrity(operation, "The operation event has a different block hash.");
      if (log.blockNumber !== undefined && log.blockNumber !== receipt.blockNumber)
        integrity(operation, "The operation event has a different block number.");
      if (typeof args.success !== "boolean")
        integrity(operation, "The chain returned an invalid operation event.");
      matching += 1;
      success = args.success;
    }
    if (matching === 0) return pending(operation);
    if (matching !== 1) integrity(operation, "The chain returned duplicate operation events.");
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
