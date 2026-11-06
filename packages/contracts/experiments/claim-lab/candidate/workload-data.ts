import { encodeAbiParameters, type Address, type Hex } from "viem";

import {
  validateCompiledCandidateWorkload,
  workloadFingerprint,
} from "./eoa-workload-definition.mjs";
import {
  resolvePinnedCurrentPrincipal,
  type PinnedCurrentPrincipalInput,
} from "./workload-principal.ts";
import { addr, bytes, decimal, h32, refs, scope, UINT64_MAX } from "./workload-values.ts";
export {
  readAdmission,
  readWithdrawalUnwrap,
  type CanonicalReceiptEvidence,
} from "./canonical-event.ts";
export {
  resolveConditionalCredit,
  type ConditionalCreditResolution,
} from "./workload-conditions.ts";

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
    const { pinnedRead, dependencyCompletions, authority } = input.pinnedCurrentPrincipal;
    return resolvePinnedCurrentPrincipal({
      pinnedRead,
      dependencyCompletions,
      authority,
      compiled,
      actionId: input.actionId,
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
    const recordScope = scope(workloadFingerprint(compiled), action.id, ref, contract, {
      producer: ref.producer,
      contractRole: ref.contractRole,
      actor,
      purpose: ref.purpose,
      ...(principal ? { currentPrincipal: principal } : {}),
      encryption: { contract, actor, type: "euint64" },
    });
    result.push(Object.freeze({ reference: ref, value: value.handle, scope: recordScope }));
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
          scope: scope(workloadFingerprint(compiled), action.id, ref, null, {
            inputReference: paired.ref,
          }),
        }),
      );
    }
  return Object.freeze(result);
}
