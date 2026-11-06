import { decodeEventLog, getAddress, type Address, type Hex } from "viem";

import { confidentialPrizePoolAbi, confidentialUsdcAbi } from "../../../../protocol/src/index.ts";
// @ts-expect-error The accepted graph is authored as checked JavaScript.
import { workloadFingerprint } from "./eoa-workload-definition.mjs";

type Sdk = {
  encrypt(input: {
    values: readonly { type: "euint64"; value: bigint }[];
    contractAddress: Address;
    userAddress: Address;
  }): Promise<{ encryptedValues: readonly Hex[]; inputProof: Hex }>;
  decryption?: {
    decryptValues(
      input: readonly { encryptedValue: Hex; contractAddress: Address }[],
    ): Promise<Record<Hex, unknown>>;
    decryptPublicValues(input: readonly Hex[]): Promise<{
      clearValues: Record<Hex, unknown>;
      abiEncodedClearValues: Hex;
      decryptionProof: Hex;
    }>;
  };
};
type Reference = Record<string, unknown>;
type Action = { id: string; kind: string; operation?: unknown };
type RecordValue = Hex | string | boolean | readonly Hex[];
export type ResolvedReference = Readonly<{
  reference: Reference;
  value: RecordValue;
  scope: Record<string, unknown>;
}>;
const UINT64_MAX = (1n << 64n) - 1n;
const h32 = (value: unknown, label: string): Hex => {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new Error(`workload data: invalid ${label}`);
  return value.toLowerCase() as Hex;
};
const bytes = (value: unknown, label: string): Hex => {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value) || value.length % 2)
    throw new Error(`workload data: invalid ${label}`);
  return value.toLowerCase() as Hex;
};
const addr = (value: unknown, label: string): Address => {
  try {
    return getAddress(value as Address);
  } catch {
    throw new Error(`workload data: invalid ${label}`);
  }
};
const decimal = (value: unknown, label: string, max = (1n << 256n) - 1n): string => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
    throw new Error(`workload data: invalid ${label}`);
  const parsed = BigInt(value);
  if (parsed > max) throw new Error(`workload data: invalid ${label}`);
  return value;
};
const clearUint = (value: unknown, label: string): string => {
  if (typeof value !== "bigint" || value < 0n || value > UINT64_MAX)
    throw new Error(`workload data: invalid ${label}`);
  return value.toString();
};
const refs = (value: unknown, found: Reference[] = []): Reference[] => {
  if (Array.isArray(value)) value.forEach((entry) => refs(entry, found));
  else if (value && typeof value === "object") {
    const record = value as Reference;
    if (typeof record.kind === "string") found.push(record);
    else Object.values(record).forEach((entry) => refs(entry, found));
  }
  return found;
};
const actionFor = (compiled: { actions: Action[] }, actionId: string) => {
  const action = compiled.actions.find((entry) => entry.id === actionId);
  if (!action || action.kind !== "eoa")
    throw new Error("workload data: action is not an EOA action");
  return action;
};
const roleContract = (
  compiled: { definition: { contracts: Record<string, string> } },
  ref: Reference,
) =>
  ref.contractRole
    ? addr(compiled.definition.contracts[String(ref.contractRole)], "reference contract")
    : null;
const scopeFor = (
  compiled: unknown,
  action: Action,
  ref: Reference,
  contract: Address | null,
  extra: Record<string, unknown> = {},
) =>
  Object.freeze({
    actionId: action.id,
    workloadFingerprint: workloadFingerprint(compiled),
    reference: ref,
    contract,
    ...extra,
  });

/** One euint64 encryption; this data-only helper never gains a write route. */
export async function resolveSdkInput(input: {
  sdk: Sdk;
  contract: string;
  actor: string;
  amount: string;
}): Promise<{ handle: Hex; proof: Hex }> {
  const contract = addr(input.contract, "SDK contract"),
    actor = addr(input.actor, "SDK actor"),
    amount = BigInt(decimal(input.amount, "SDK amount", UINT64_MAX));
  const encrypted = await input.sdk.encrypt({
    values: [{ type: "euint64", value: amount }],
    contractAddress: contract,
    userAddress: actor,
  });
  if (!Array.isArray(encrypted.encryptedValues) || encrypted.encryptedValues.length !== 1)
    throw new Error("workload data: expected one encrypted value");
  return {
    handle: h32(encrypted.encryptedValues[0], "encrypted value"),
    proof: bytes(encrypted.inputProof, "input proof"),
  };
}

export async function decryptOwnedUint64(input: {
  sdk: Sdk;
  handle: Hex;
  pool: string;
}): Promise<string> {
  const pool = addr(input.pool, "owned decrypt pool");
  if (!input.sdk.decryption) throw new Error("workload data: SDK decryption unavailable");
  const handle = h32(input.handle, "owned handle"),
    values = await input.sdk.decryption.decryptValues([
      { encryptedValue: handle, contractAddress: pool },
    ]);
  if (!Object.hasOwn(values, handle))
    throw new Error("workload data: owned decrypt missing handle");
  return clearUint(values[handle], "owned clear value");
}

export async function decryptPublic(input: {
  sdk: Sdk;
  handles: readonly Hex[];
}): Promise<{ values: readonly string[]; proof: Hex }> {
  if (!input.sdk.decryption || !input.handles.length)
    throw new Error("workload data: public decryption unavailable");
  const handles = input.handles.map((handle) => h32(handle, "public handle"));
  if (new Set(handles).size !== handles.length)
    throw new Error("workload data: duplicate public handle");
  const result = await input.sdk.decryption.decryptPublicValues(handles);
  const values = handles.map((handle) => {
    if (!Object.hasOwn(result.clearValues, handle))
      throw new Error("workload data: public decrypt missing handle");
    return clearUint(result.clearValues[handle], "public clear value");
  });
  return { values, proof: bytes(result.decryptionProof, "decryption proof") };
}

/** Resolves only the graph's encryption inputs and matching proofs. Receipt and proof evidence stays injected. */
export async function resolveSdkReferences(input: {
  compiled: { actions: Action[]; definition: { contracts: Record<string, string> } };
  actionId: string;
  sdk: Sdk;
  readCurrentPrincipal?: (reference: Reference) => Promise<Hex>;
}): Promise<readonly ResolvedReference[]> {
  const action = actionFor(input.compiled, input.actionId),
    result: ResolvedReference[] = [],
    inputs = new Map<string, { ref: Reference; value: { handle: Hex; proof: Hex } }>();
  for (const ref of refs(action.operation)) {
    if (ref.kind !== "sdkInput") continue;
    const principal =
      (ref.amount as Reference | undefined)?.kind === "currentPrincipal"
        ? (ref.amount as Reference)
        : undefined;
    const contract = principal
      ? addr(principal.contract, "principal contract")
      : roleContract(input.compiled, ref);
    if (!contract) throw new Error("workload data: SDK input has no contract");
    const actor = principal
      ? addr(principal.account, "principal account")
      : addr(ref.actor, "SDK actor");
    const amount = principal
      ? await resolveCurrentPrincipal(input.sdk, principal, contract, input.readCurrentPrincipal)
      : decimal(ref.amount, "SDK amount", UINT64_MAX);
    const value = await resolveSdkInput({ sdk: input.sdk, contract, actor, amount });
    const scope = scopeFor(input.compiled, action, ref, contract, {
      producer: ref.producer,
      contractRole: ref.contractRole,
      actor,
      purpose: ref.purpose,
      ...(principal ? { currentPrincipal: principal } : {}),
      encryption: { contract, actor, type: "euint64" },
    });
    result.push(Object.freeze({ reference: ref, value: value.handle, scope }));
    inputs.set(String(ref.producer), { ref, value });
  }
  for (const ref of refs(action.operation))
    if (ref.kind === "sdkProof") {
      const paired = inputs.get(String(ref.producer));
      if (!paired) throw new Error("workload data: SDK proof has no input");
      result.push(
        Object.freeze({
          reference: ref,
          value: paired.value.proof,
          scope: scopeFor(input.compiled, action, ref, null, { inputReference: paired.ref }),
        }),
      );
    }
  return Object.freeze(result);
}

async function resolveCurrentPrincipal(
  sdk: Sdk,
  ref: Reference,
  pool: Address,
  reader?: (reference: Reference) => Promise<Hex>,
) {
  if (!reader) throw new Error("workload data: current principal reader unavailable");
  const handle = await reader(ref);
  return decryptOwnedUint64({ sdk, handle: h32(handle, "principal handle"), pool });
}

export type CanonicalReceipt = Readonly<{
  transactionHash: Hex;
  status: "success" | 1;
  blockNumber: bigint;
  blockHash: Hex;
  logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[];
}>;
/** Pure receipt parser: callers supply already verified canonical receipts; no provider is accepted. */
export function uniqueEvent(input: {
  receipt: CanonicalReceipt;
  transactionHash: Hex;
  emitter: string;
  abi: readonly unknown[];
  event: string;
  match?: (args: Record<string, unknown>) => boolean;
}): Record<string, unknown> {
  if (
    (input.receipt.status !== "success" && input.receipt.status !== 1) ||
    input.receipt.transactionHash.toLowerCase() !== input.transactionHash.toLowerCase()
  )
    throw new Error("workload data: noncanonical receipt");
  const emitter = addr(input.emitter, "event emitter");
  const matches: Record<string, unknown>[] = [];
  for (const log of input.receipt.logs) {
    if (addr(log.address, "log emitter") !== emitter) continue;
    try {
      const decoded = decodeEventLog({
        abi: input.abi as never,
        data: log.data,
        topics: [...log.topics] as [Hex, ...Hex[]],
      });
      const args = decoded.args as unknown as Record<string, unknown>;
      if (decoded.eventName === input.event && (!input.match || input.match(args)))
        matches.push(args);
    } catch {
      /* unrelated log */
    }
  }
  if (matches.length !== 1) throw new Error("workload data: event is not uniquely scoped");
  return matches[0];
}

export const poolEvents = confidentialPrizePoolAbi;
export const wrapperEvents = confidentialUsdcAbi;

export function positiveCreditCondition(input: {
  actionId: string;
  actor: string;
  pool: string;
  encryptedWinningsOf: (account: Address, block: bigint) => Promise<Hex>;
  decrypt: (handle: Hex, pool: Address) => Promise<string>;
  dependencyBlocks: readonly bigint[];
  readBlock: () => Promise<{ number: bigint; hash: Hex }>;
  expectedBlockHash: Hex;
}): Promise<{ kind: "positive-credit"; value: string } | { kind: "SKIPPED" }> {
  return condition(input);
}
async function condition(input: Parameters<typeof positiveCreditCondition>[0]) {
  if (!/^claim-(stage8|stage33)-eoa-[0-9]{2}$/.test(input.actionId))
    throw new Error("workload data: invalid conditional action");
  const pool = addr(input.pool, "condition pool"),
    actor = addr(input.actor, "condition actor"),
    block = await input.readBlock();
  if (
    block.number < Math.max(...input.dependencyBlocks.map(Number)) ||
    h32(block.hash, "condition block hash") !== h32(input.expectedBlockHash, "expected block hash")
  )
    throw new Error("workload data: conditional evidence unavailable");
  const handle = h32(await input.encryptedWinningsOf(actor, block.number), "winnings handle");
  if (handle === "0x" + "00".repeat(32)) return { kind: "SKIPPED" as const };
  const value = await input.decrypt(handle, pool);
  const reread = await input.readBlock();
  if (reread.hash.toLowerCase() !== block.hash.toLowerCase())
    throw new Error("workload data: conditional evidence reorged");
  return BigInt(decimal(value, "winnings", UINT64_MAX)) > 0n
    ? { kind: "positive-credit" as const, value }
    : { kind: "SKIPPED" as const };
}
