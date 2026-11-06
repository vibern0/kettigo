import { decodeEventLog, encodeAbiParameters, getAddress, type Address, type Hex } from "viem";

import { confidentialPrizePoolAbi, confidentialUsdcAbi } from "../../../../protocol/src/index.ts";
import {
  validateCompiledCandidateWorkload,
  workloadFingerprint,
} from "./eoa-workload-definition.mjs";
import {
  resolvePinnedCurrentPrincipal,
  type PinnedCurrentPrincipalInput,
} from "./workload-principal.ts";

export type {
  CanonicalDecimalString,
  CanonicalDependency,
  ConditionalCreditEvidence,
  DependencyCompletion,
  PinnedRead,
} from "./workload-completion.ts";
export { FIXED_ENTRY_POINT_07 } from "./workload-completion.ts";
export { resolvePinnedCurrentPrincipal } from "./workload-principal.ts";

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
type Action = {
  id: string;
  kind: string;
  phase?: string;
  actor?: string;
  target?: string;
  dependencies?: readonly string[];
  operation?: unknown;
};
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
const nonzeroH32 = (value: unknown, label: string): Hex => {
  const result = h32(value, label);
  if (result === `0x${"00".repeat(32)}`) throw new Error(`workload data: invalid ${label}`);
  return result;
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
  if (bytes(encrypted.inputProof, "input proof") === "0x")
    throw new Error("workload data: empty input proof");
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
  const proof = proofBytes(result.decryptionProof);
  const encoded = encodeAbiParameters(
    handles.map(() => ({ type: "uint64" as const })),
    values.map((value) => BigInt(value)),
  );
  if (bytes(result.abiEncodedClearValues, "ABI clear values") !== encoded)
    throw new Error("workload data: public clear values do not match ABI encoding");
  return { values, proof };
}

export async function decryptPublicMarker(input: {
  sdk: Pick<Sdk, "decryption">;
  handle: Hex;
}): Promise<{ value: boolean; proof: Hex }> {
  if (!input.sdk.decryption) throw new Error("workload data: public decryption unavailable");
  const handle = h32(input.handle, "marker handle");
  const result = await input.sdk.decryption.decryptPublicValues([handle]);
  if (!Object.hasOwn(result.clearValues, handle) || typeof result.clearValues[handle] !== "boolean")
    throw new Error("workload data: invalid marker clear value");
  const value = result.clearValues[handle] as boolean;
  if (
    bytes(result.abiEncodedClearValues, "marker ABI clear value") !==
    encodeAbiParameters([{ type: "bool" }], [value])
  )
    throw new Error("workload data: marker ABI clear value mismatch");
  return { value, proof: proofBytes(result.decryptionProof) };
}

function proofBytes(value: unknown): Hex {
  const proof = bytes(value, "decryption proof");
  if (proof === "0x") throw new Error("workload data: empty decryption proof");
  return proof;
}

/** Resolves only the graph's encryption inputs and matching proofs. Receipt and proof evidence stays injected. */
export async function resolveSdkReferences(input: {
  compiled: { actions: Action[]; definition: { contracts: Record<string, string> } };
  actionId: string;
  sdk: Sdk;
  pinnedCurrentPrincipal?: Omit<PinnedCurrentPrincipalInput, "compiled" | "actionId">;
}): Promise<readonly ResolvedReference[]> {
  const compiled = validateCompiledCandidateWorkload(input.compiled),
    action = actionFor(compiled, input.actionId);
  if (
    refs(action.operation).some(
      (ref) => (ref.amount as Reference | undefined)?.kind === "currentPrincipal",
    )
  ) {
    if (!input.pinnedCurrentPrincipal)
      throw new Error("workload data: current principal requires pinned evidence");
    return resolvePinnedCurrentPrincipal({
      compiled,
      actionId: input.actionId,
      ...input.pinnedCurrentPrincipal,
    });
  }
  return staticSdkReferences(compiled, action, input.sdk);
}

async function staticSdkReferences(
  compiled: { actions: Action[]; definition: { contracts: Record<string, string> } },
  action: Action,
  sdk: Sdk,
): Promise<readonly ResolvedReference[]> {
  const result: ResolvedReference[] = [],
    inputs = new Map<string, { ref: Reference; value: { handle: Hex; proof: Hex } }>();
  for (const ref of refs(action.operation)) {
    if (ref.kind !== "sdkInput") continue;
    const principal =
      (ref.amount as Reference | undefined)?.kind === "currentPrincipal"
        ? (ref.amount as Reference)
        : undefined;
    const contract = roleContract(compiled, ref);
    if (!contract) throw new Error("workload data: SDK input has no contract");
    const actor = addr(ref.actor, "SDK actor");
    const amount = decimal(ref.amount, "SDK amount", UINT64_MAX);
    const value = await resolveSdkInput({ sdk, contract, actor, amount });
    const scope = scopeFor(compiled, action, ref, contract, {
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
          scope: scopeFor(compiled, action, ref, null, { inputReference: paired.ref }),
        }),
      );
    }
  return Object.freeze(result);
}

/* Retired in favor of the closed completion/principal modules. Kept in history, not runtime. */
/* export type PinnedCurrentPrincipalInput = Readonly<{
  compiled: { actions: Action[]; definition: { contracts: Record<string, string> } };
  actionId: string;
  pinnedRead: PinnedRead;
  dependencyCompletions: readonly DependencyCompletion[];
  authority: CurrentPrincipalReadAuthority;
}>;

// Resolves only the graph's fixed-block current-principal withdrawal input.
export async function resolvePinnedCurrentPrincipal(
  input: PinnedCurrentPrincipalInput,
): Promise<readonly ResolvedReference[]> {
  const compiled = validateCompiledCandidateWorkload(input.compiled);
  const action = actionFor(compiled, input.actionId) as Action;
  if (!/^final-request-eoa-[0-9]{2}$/.test(action.id) || action.phase !== "final")
    throw new Error("workload data: action is not a final EOA withdrawal");
  const pool = addr(action.target, "current principal pool");
  const account = addr(action.actor, "current principal account");
  const references = refs(action.operation);
  const sdkInputs = references.filter((ref) => ref.kind === "sdkInput");
  const sdkProofs = references.filter((ref) => ref.kind === "sdkProof");
  if (sdkInputs.length !== 1 || sdkProofs.length !== 1)
    throw new Error("workload data: invalid current principal references");
  const sdkInput = sdkInputs[0],
    sdkProof = sdkProofs[0];
  const principal = sdkInput.amount as Reference;
  if (
    !principal ||
    principal.kind !== "currentPrincipal" ||
    principal.contractRole !== "candidatePool" ||
    addr(principal.contract, "current principal contract") !== pool ||
    addr(principal.account, "current principal account") !== account ||
    principal.getter !== "encryptedPrincipalOf(address)" ||
    principal.handleType !== "euint64" ||
    principal.clearType !== "uint64" ||
    principal.abiType !== "uint64" ||
    JSON.stringify(principal.constraints) !==
      JSON.stringify(["checksummed-contract", "checksummed-account", "dependency-complete"]) ||
    sdkInput.producer !== action.id ||
    sdkInput.contractRole !== "candidatePool" ||
    addr(sdkInput.actor, "current principal SDK actor") !== account ||
    sdkInput.purpose !== "withdrawal" ||
    sdkProof.producer !== action.id ||
    sdkProof.field !== "inputProof"
  )
    throw new Error("workload data: invalid current principal descriptor");
  const pin = pinned(input.pinnedRead, "pinned read");
  const dependencies = action.dependencies ?? [];
  if (input.dependencyCompletions.length !== dependencies.length)
    throw new Error("workload data: incomplete current principal dependencies");
  const actions = new Map(compiled.actions.map((entry) => [entry.id, entry]));
  input.dependencyCompletions.forEach((completion, index) => {
    const dependency = dependencies[index];
    if (!completion || completion.actionId !== dependency)
      throw new Error("workload data: unordered current principal dependencies");
    const dependencyAction = actions.get(dependency);
    if (!dependencyAction) throw new Error("workload data: foreign current principal dependency");
    if (completion.kind === "canonical-success") {
      canonicalDependency(completion.evidence, dependencyAction, pin.number);
      return;
    }
    if (
      completion.kind !== "conditional-SKIPPED" ||
      !conditionalDependency(completion.evidence, dependencyAction, compiled, pool, pin)
    )
      throw new Error("workload data: unresolved current principal dependency");
  });
  const initial = pinned(await input.authority.blockAt(pin.number), "initial pinned header");
  if (initial.number !== pin.number || initial.hash !== pin.hash)
    throw new Error("workload data: unresolved pinned header");
  const source = nonzeroH32(
    await input.authority.readEncryptedPrincipalAt(pool, account, pin.number),
    "current principal handle",
  );
  const clear = await input.authority.decryptOwnedUint64(pool, account, source);
  const amount = BigInt(clearUint(clear, "current principal clear value"));
  const encrypted = await input.authority.encryptEuint64(pool, account, amount);
  if (!Array.isArray(encrypted.encryptedValues) || encrypted.encryptedValues.length !== 1)
    throw new Error("workload data: expected one current principal encrypted value");
  const handle = h32(encrypted.encryptedValues[0], "current principal encrypted value");
  if (handle === source) throw new Error("workload data: current principal source handle reuse");
  const proof = bytes(encrypted.inputProof, "current principal input proof");
  if (proof === "0x") throw new Error("workload data: empty current principal input proof");
  const rechecked = pinned(await input.authority.blockAt(pin.number), "rechecked pinned header");
  if (rechecked.number !== pin.number || rechecked.hash !== pin.hash)
    throw new Error("workload data: pinned header changed");
  const scope = scopeFor(compiled, action, sdkInput, pool, {
    producer: sdkInput.producer,
    contractRole: sdkInput.contractRole,
    actor: account,
    purpose: sdkInput.purpose,
    currentPrincipal: principal,
    encryption: { contract: pool, actor: account, type: "euint64" },
  });
  return Object.freeze([
    Object.freeze({ reference: sdkInput, value: handle, scope }),
    Object.freeze({
      reference: sdkProof,
      value: proof,
      scope: scopeFor(compiled, action, sdkProof, null, { inputReference: sdkInput }),
    }),
  ]);
}

function pinned(value: unknown, label: string): { number: bigint; hash: Hex } {
  const record = value as PinnedRead;
  return { number: BigInt(decimal(record?.number, label)), hash: h32(record?.hash, label) };
}

function canonicalDependency(evidence: CanonicalDependency, action: Action, pin: bigint): void {
  if (!evidence || evidence.actionId !== action.id)
    throw new Error("workload data: invalid dependency evidence");
  const block = BigInt(decimal(evidence.blockNumber, "dependency block"));
  if (block > pin) throw new Error("workload data: dependency after pinned read");
  h32(evidence.blockHash, "dependency block hash");
  if (action.kind === "externalSafe") {
    if (evidence.kind !== "safe")
      throw new Error("workload data: missing Safe dependency identity");
    h32(evidence.userOperationHash, "Safe user operation hash");
    addr(evidence.entryPoint, "Safe entry point");
    addr(evidence.sender, "Safe sender");
    h32(evidence.outerTransactionHash, "Safe outer transaction hash");
  } else {
    if (evidence.kind !== "eoa") throw new Error("workload data: invalid EOA dependency identity");
    h32(evidence.transactionHash, "EOA transaction hash");
  }
}

function conditionalDependency(
  evidence: ConditionalCreditEvidence,
  action: Action,
  compiled: unknown,
  pool: Address,
  pin: { number: bigint; hash: Hex },
): boolean {
  if (
    !/^claim-stage(?:8|33)-eoa-[0-9]{2}$/.test(action.id) &&
    action.id !== "safe-conditional-wallet-claim"
  )
    return false;
  try {
    if (
      evidence.actionId !== action.id ||
      h32(evidence.workloadFingerprint, "conditional fingerprint") !==
        workloadFingerprint(compiled) ||
      evidence.condition !== "positive-credit-or-SKIPPED" ||
      addr(evidence.pool, "conditional pool") !== pool ||
      addr(evidence.account, "conditional account") !== addr(action.actor, "conditional actor") ||
      evidence.getter !== "encryptedWinningsOf(address)" ||
      evidence.clearCredit !== "0" ||
      !["user-decrypt", "uninitialized-zero-handle"].includes(evidence.resolution) ||
      BigInt(decimal(evidence.readBlock.number, "conditional read block")) !== pin.number ||
      h32(evidence.readBlock.hash, "conditional read hash") !== pin.hash ||
      h32(evidence.readBlock.recheckedHash, "conditional rechecked hash") !== pin.hash ||
      evidence.dependencies.length !== (action.dependencies ?? []).length
    )
      return false;
    nonzeroH32(evidence.handle, "conditional handle");
    evidence.dependencies.forEach((dependency, index) => {
      const child = (compiled as { actions: Action[] }).actions.find(
        (entry) => entry.id === (action.dependencies ?? [])[index],
      );
      if (!child) throw new Error("missing conditional dependency");
      canonicalDependency(dependency, child, pin.number);
    });
    return true;
  } catch {
    return false;
  }
} */

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
