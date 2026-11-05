import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  isAddress,
  isHex,
  type Address,
  type Hex,
} from "viem";
import { entryPoint07Address } from "viem/account-abstraction";

import { confidentialPrizePoolAbi } from "./contracts.ts";
import type {
  PrizeProof,
  PrizeProofClientOptions,
  PrizeProofResult,
} from "./prize-proof-client.ts";
import { createPrizeProofClient } from "./prize-proof-client.ts";
import {
  SafeUserOperationNotSubmittedError,
  SafeUserOperationRejectedError,
} from "./passkey-operation.ts";
import type {
  PasskeySmartSession,
  PreparedSmartTransaction,
  SafeUserOperationIdentity,
  SafeUserOperationReceipt,
  SmartAccountCall,
} from "./smart-session.ts";

export type PrizeCheckIntent = Readonly<{
  chainId: 11155111;
  pool: Address;
  account: Address;
  drawId: bigint;
  action: "checkPrize";
  operation: SafeUserOperationIdentity;
}>;

export type PrizeCheckIntentStore = Readonly<{
  save(intent: PrizeCheckIntent): Promise<void>;
  read(): PrizeCheckIntent | null;
  clear(intent: PrizeCheckIntent): Promise<void>;
}>;

export type PrizeCheckState =
  | Readonly<{ state: "checked"; drawId: bigint; award: Hex }>
  | Readonly<{ state: "ready"; drawId: bigint; proof: PrizeProof }>
  | Readonly<{
      state: "not-eligible" | "indexing" | "history-unavailable" | "unavailable";
      drawId: bigint;
      reason?: string;
    }>;

type PinnedRead = Readonly<{ blockHash?: Hex; signal?: AbortSignal }>;
type ProofClient = Readonly<{
  getProof(drawId: bigint, options?: { signal?: AbortSignal }): Promise<PrizeProofResult>;
}>;
type ReceiptSession = Pick<
  PasskeySmartSession,
  "address" | "prepareTransaction" | "lookupUserOperation"
>;

export type PrizeCheckCoordinatorDependencies = Readonly<{
  chainId: 11155111;
  pool: Address;
  account: Address;
  session: ReceiptSession;
  readChecked(drawId: bigint, options?: PinnedRead): Promise<boolean>;
  readAward(drawId: bigint, options?: PinnedRead): Promise<Hex>;
  readBlockHash(signal?: AbortSignal): Promise<Hex>;
  getProofClient(): ProofClient;
  prepareReadSessionCalls?(signal?: AbortSignal): Promise<readonly SmartAccountCall[]>;
  intentStore: PrizeCheckIntentStore;
}>;

type ReadyReview = Extract<PrizeCheckState, { state: "ready" }>;
export type PreparedPrizeCheck = Readonly<{
  cancel(): void;
  confirm(): Promise<PrizeCheckState>;
}>;

const ACTION = "checkPrize" as const;
const key = "kettigo.prize-check-intent.v1";
const ENTRY_POINT = getAddress(entryPoint07Address);
const aborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted.", "AbortError");
};
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

function assertDraw(drawId: bigint): void {
  if (typeof drawId !== "bigint" || drawId <= 0n || drawId > (1n << 256n) - 1n)
    throw new Error("The selected draw is invalid.");
}

function copiedProof(proof: PrizeProof): PrizeProof {
  return Object.freeze({
    ...proof,
    siblingHashes: Object.freeze([...proof.siblingHashes]),
    siblingSums: Object.freeze([...proof.siblingSums]),
    parentSums: Object.freeze([...proof.parentSums]),
  });
}

function sameOperation(left: SafeUserOperationIdentity, right: SafeUserOperationIdentity): boolean {
  return (
    left.chainId === right.chainId &&
    same(left.entryPoint, right.entryPoint) &&
    same(left.sender, right.sender) &&
    same(left.userOperationHash, right.userOperationHash)
  );
}

function validOperation(value: unknown, account: Address): value is SafeUserOperationIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).sort().join(",") !== "chainId,entryPoint,sender,userOperationHash")
    return false;
  const operation = value as SafeUserOperationIdentity;
  return (
    operation.chainId === 11155111 &&
    isAddress(operation.entryPoint) &&
    getAddress(operation.entryPoint) === ENTRY_POINT &&
    isAddress(operation.sender) &&
    getAddress(operation.sender) === account &&
    isHex(operation.userOperationHash) &&
    operation.userOperationHash.length === 66
  );
}

function intent(
  scope: Readonly<{ pool: Address; account: Address; drawId: bigint }>,
  operation: SafeUserOperationIdentity,
): PrizeCheckIntent {
  if (!validOperation(operation, scope.account))
    throw new Error("The prepared operation has a different scope.");
  return Object.freeze({
    chainId: 11155111,
    pool: scope.pool,
    account: scope.account,
    drawId: scope.drawId,
    action: ACTION,
    operation: Object.freeze({
      chainId: 11155111,
      entryPoint: getAddress(operation.entryPoint),
      sender: getAddress(operation.sender),
      userOperationHash: operation.userOperationHash,
    }),
  });
}

/** A bounded, action-specific record. It deliberately does not replace the generic Safe pending guard. */
export function createPrizeCheckIntentStore(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
): PrizeCheckIntentStore {
  const parse = (raw: string | null): PrizeCheckIntent | null => {
    if (raw === null) return null;
    if (raw.length > 2048) throw new Error("Saved prize-check intent is corrupt.");
    try {
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (Object.keys(value).sort().join(",") !== "account,action,chainId,drawId,operation,pool")
        throw new Error("invalid schema");
      if (
        value.action !== ACTION ||
        value.chainId !== 11155111 ||
        typeof value.drawId !== "string" ||
        !/^[1-9][0-9]*$/.test(value.drawId) ||
        typeof value.pool !== "string" ||
        typeof value.account !== "string" ||
        !isAddress(value.pool) ||
        !isAddress(value.account)
      )
        throw new Error("invalid schema");
      const drawId = BigInt(value.drawId);
      assertDraw(drawId);
      const candidate = {
        pool: getAddress(value.pool as Address),
        account: getAddress(value.account as Address),
        drawId,
      };
      if (!validOperation(value.operation, candidate.account)) throw new Error("invalid operation");
      return intent(candidate, value.operation);
    } catch (error) {
      throw new Error("Saved prize-check intent is corrupt.", { cause: error });
    }
  };
  return Object.freeze({
    async save(value) {
      const normalized = intent(value, value.operation);
      const existing = parse(storage.getItem(key));
      if (existing && !sameIntent(existing, normalized))
        throw new Error("Another prize check is already pending.");
      storage.setItem(
        key,
        JSON.stringify({
          chainId: normalized.chainId,
          pool: normalized.pool,
          account: normalized.account,
          drawId: normalized.drawId.toString(),
          action: ACTION,
          operation: normalized.operation,
        }),
      );
      if (!sameIntent(parse(storage.getItem(key)), normalized))
        throw new Error("Could not save the pending prize check.");
    },
    read: () => parse(storage.getItem(key)),
    async clear(value) {
      const current = parse(storage.getItem(key));
      if (!current || !sameIntent(current, value)) return;
      storage.removeItem(key);
      if (storage.getItem(key) !== null)
        throw new Error("Could not clear the pending prize check.");
    },
  });
}

function sameIntent(left: PrizeCheckIntent | null, right: PrizeCheckIntent): boolean {
  return (
    !!left &&
    left.chainId === right.chainId &&
    left.drawId === right.drawId &&
    left.action === right.action &&
    same(left.pool, right.pool) &&
    same(left.account, right.account) &&
    sameOperation(left.operation, right.operation)
  );
}

function readState(
  scope: Readonly<{ account: Address; drawId: bigint }>,
  dependencies: PrizeCheckCoordinatorDependencies,
  options?: PinnedRead,
): Promise<PrizeCheckState> {
  return dependencies.readChecked(scope.drawId, options).then(async (checked) => {
    aborted(options?.signal);
    if (!checked) throw new Error("The prize check was not confirmed.");
    const award = await dependencies.readAward(scope.drawId, options);
    aborted(options?.signal);
    return Object.freeze({ state: "checked" as const, drawId: scope.drawId, award });
  });
}

export function createPrizeCheckCoordinator(input: PrizeCheckCoordinatorDependencies) {
  if (input.chainId !== 11155111) throw new Error("Unsupported chain.");
  const scope = Object.freeze({ pool: getAddress(input.pool), account: getAddress(input.account) });
  if (getAddress(input.session.address) !== scope.account)
    throw new Error("Session account differs from prize-check account.");
  const dependencies = Object.freeze({ ...input, pool: scope.pool, account: scope.account });
  const review = async (drawId: bigint, signal?: AbortSignal): Promise<PrizeCheckState> => {
    assertDraw(drawId);
    aborted(signal);
    const blockHash = await dependencies.readBlockHash(signal);
    aborted(signal);
    const isChecked = await dependencies.readChecked(drawId, { blockHash, signal });
    aborted(signal);
    if (isChecked) return readState({ ...scope, drawId }, dependencies, { blockHash, signal });
    const outcome = await dependencies.getProofClient().getProof(drawId, { signal });
    aborted(signal);
    if (outcome.kind !== "proof")
      return Object.freeze({
        state: outcome.kind,
        drawId,
        reason: "reason" in outcome ? outcome.reason : undefined,
      });
    return Object.freeze({ state: "ready", drawId, proof: copiedProof(outcome.proof) });
  };
  const prepare = async (
    reviewed: ReadyReview,
    signal?: AbortSignal,
  ): Promise<PreparedPrizeCheck> => {
    assertDraw(reviewed.drawId);
    aborted(signal);
    const proof = copiedProof(reviewed.proof);
    if (
      proof.drawId !== reviewed.drawId ||
      getAddress(proof.account) !== scope.account ||
      getAddress(proof.pool) !== scope.pool ||
      proof.chainId !== 11155111n
    )
      throw new Error("The proof is outside this prize-check scope.");
    const calls = dependencies.prepareReadSessionCalls
      ? await dependencies.prepareReadSessionCalls(signal)
      : [];
    aborted(signal);
    const isChecked = await dependencies.readChecked(reviewed.drawId, { signal });
    aborted(signal);
    if (isChecked) throw new Error("This draw has already been checked.");
    const data = encodeFunctionData({
      abi: confidentialPrizePoolAbi,
      functionName: "checkPrize",
      args: [
        proof.drawId,
        scope.account,
        proof.index,
        proof.generation,
        proof.balance,
        [...proof.siblingHashes],
        [...proof.siblingSums],
        [...proof.parentSums],
      ],
    });
    const prepared = await dependencies.session.prepareTransaction(
      [...calls, { to: scope.pool, data }],
      { signal },
    );
    if (signal?.aborted) {
      prepared.cancel();
      aborted(signal);
    }
    return ready(prepared, { ...scope, drawId: reviewed.drawId }, dependencies, signal);
  };
  const reconcile = async (
    saved: PrizeCheckIntent,
    signal?: AbortSignal,
  ): Promise<PrizeCheckState | SafeUserOperationReceipt> => {
    aborted(signal);
    if (!sameIntentForScope(saved, scope))
      throw new Error("The saved prize check belongs to a different account or draw.");
    if (!dependencies.session.lookupUserOperation)
      throw new Error("Operation reconciliation is unavailable.");
    const result = await dependencies.session.lookupUserOperation(saved.operation);
    aborted(signal);
    if (!sameOperation(result.operation, saved.operation))
      throw new Error("Operation reconciliation returned a different operation.");
    if (result.state === "pending") return result;
    await dependencies.intentStore.clear(saved);
    aborted(signal);
    if (result.state === "failed") return result;
    return readState({ ...scope, drawId: saved.drawId }, dependencies, {
      blockHash: result.blockHash,
      signal,
    });
  };
  return Object.freeze({
    review,
    prepare,
    reconcile,
    pending: () => {
      const saved = dependencies.intentStore.read();
      if (saved && !sameIntentForScope(saved, scope))
        throw new Error("The saved prize check belongs to a different account or draw.");
      return saved;
    },
  });
}

function sameIntentForScope(
  intentValue: PrizeCheckIntent,
  scope: Readonly<{ pool: Address; account: Address }>,
): boolean {
  try {
    assertDraw(intentValue.drawId);
    return (
      intentValue.chainId === 11155111 &&
      intentValue.action === ACTION &&
      same(intentValue.pool, scope.pool) &&
      same(intentValue.account, scope.account) &&
      validOperation(intentValue.operation, scope.account)
    );
  } catch {
    return false;
  }
}

function ready(
  prepared: PreparedSmartTransaction,
  scope: Readonly<{ pool: Address; account: Address; drawId: bigint }>,
  dependencies: PrizeCheckCoordinatorDependencies,
  signal?: AbortSignal,
): PreparedPrizeCheck {
  let active = true,
    attempted = false,
    confirmation: Promise<PrizeCheckState> | undefined;
  let observed: PrizeCheckIntent | undefined;
  const cancel = () => {
    if (!active || attempted) return;
    active = false;
    remove();
    prepared.cancel();
  };
  const remove = () => signal?.removeEventListener("abort", cancel);
  signal?.addEventListener("abort", cancel, { once: true });
  return Object.freeze({
    cancel,
    confirm: () => {
      if (confirmation) return confirmation;
      try {
        aborted(signal);
      } catch (error) {
        return Promise.reject(error);
      }
      if (!active) return Promise.reject(new Error("Please review this draw again."));
      active = false;
      attempted = true;
      remove();
      try {
        // Deliberately no await before this call: credential mediation needs the Confirm stack.
        const sent = prepared.send({
          onOperationPrepared: async (operation) => {
            aborted(signal);
            const captured = intent(scope, operation);
            await dependencies.intentStore.save(captured);
            aborted(signal);
            observed = captured;
          },
        });
        confirmation = sent.then(
          async () => {
            if (!observed) throw new Error("The pending prize check could not be recovered.");
            const result = await createPrizeCheckCoordinator(dependencies).reconcile(
              observed,
              signal,
            );
            if ("state" in result && result.state === "checked") return result;
            if (result.state === "failed") throw new Error("The prize check was rejected onchain.");
            throw new Error("The prize check is still processing.");
          },
          async (error) => {
            if (
              observed &&
              (error instanceof SafeUserOperationNotSubmittedError ||
                error instanceof SafeUserOperationRejectedError) &&
              sameOperation(error.operation, observed.operation)
            )
              await dependencies.intentStore.clear(observed);
            throw error;
          },
        );
      } catch (error) {
        confirmation = Promise.reject(error);
      }
      return confirmation;
    },
  });
}

type ViemRequestClient = Readonly<{
  request(args: { method: string; params: readonly unknown[] }): Promise<unknown>;
}>;
type ReaderOptions = Readonly<{ signal?: AbortSignal; blockHash?: Hex }>;

/** Reads proof anchors with raw EIP-1898 calls; a rejected canonical hash is never downgraded. */
export function createViemPrizeChainReader(client: ViemRequestClient, pool: Address) {
  const target = getAddress(pool);
  const call = async (data: Hex, options: ReaderOptions = {}): Promise<Hex> => {
    aborted(options.signal);
    const block = options.blockHash
      ? { blockHash: options.blockHash, requireCanonical: true }
      : "latest";
    const result = await client.request({
      method: "eth_call",
      params: [{ to: target, data }, block],
    });
    aborted(options.signal);
    if (!isHex(result)) throw new Error("Invalid chain read response.");
    return result;
  };
  return Object.freeze({
    async readBlockHash(options: ReaderOptions = {}): Promise<Hex> {
      aborted(options.signal);
      const block = await client.request({
        method: "eth_getBlockByNumber",
        params: ["latest", false],
      });
      aborted(options.signal);
      if (!block || typeof block !== "object" || !isHex((block as { hash?: unknown }).hash))
        throw new Error("Invalid block response.");
      return (block as { hash: Hex }).hash;
    },
    async getBlockHash(blockNumber: bigint, options: ReaderOptions = {}): Promise<Hex> {
      aborted(options.signal);
      const block = await client.request({
        method: "eth_getBlockByNumber",
        params: [`0x${blockNumber.toString(16)}`, false],
      });
      aborted(options.signal);
      if (!block || typeof block !== "object" || !isHex((block as { hash?: unknown }).hash))
        throw new Error("Invalid block response.");
      return (block as { hash: Hex }).hash;
    },
    async readDraw(drawId: bigint, options: ReaderOptions = {}) {
      const data = encodeFunctionData({
        abi: confidentialPrizePoolAbi,
        functionName: "draws",
        args: [drawId],
      });
      const raw = await call(data, options);
      const value = decodeFunctionResult({
        abi: confidentialPrizePoolAbi,
        functionName: "draws",
        data: raw,
      }) as readonly [Hex, Hex, Hex, Hex, Hex, bigint, bigint];
      return Object.freeze({
        rootHash: value[0],
        rootSum: value[1],
        ticket: value[2],
        upperBound: value[5],
        closeBlockNumber: value[6],
      });
    },
    async readChecked(drawId: bigint, account: Address, options: ReaderOptions = {}) {
      const raw = await call(
        encodeFunctionData({
          abi: confidentialPrizePoolAbi,
          functionName: "checked",
          args: [drawId, getAddress(account)],
        }),
        options,
      );
      return decodeFunctionResult({
        abi: confidentialPrizePoolAbi,
        functionName: "checked",
        data: raw,
      }) as boolean;
    },
    async readAward(drawId: bigint, account: Address, options: ReaderOptions = {}) {
      const raw = await call(
        encodeFunctionData({
          abi: confidentialPrizePoolAbi,
          functionName: "encryptedAwardOf",
          args: [drawId, getAddress(account)],
        }),
        options,
      );
      return decodeFunctionResult({
        abi: confidentialPrizePoolAbi,
        functionName: "encryptedAwardOf",
        data: raw,
      }) as Hex;
    },
  });
}

export function createViemPrizeProofClient(
  options: Omit<PrizeProofClientOptions, "chainReader"> & { client: ViemRequestClient },
) {
  return createPrizeProofClient({
    ...options,
    chainReader: createViemPrizeChainReader(options.client, options.pool),
  });
}
