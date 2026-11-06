import { type Address, type Hex } from "viem";
import {
  validateCompiledCandidateWorkload,
  workloadFingerprint,
} from "./eoa-workload-definition.mjs";
import {
  pin,
  type DependencyCompletion,
  type PinnedRead,
  validateCompletion,
} from "./workload-completion.ts";
import { addr, bytes, h32, refs, scope, UINT64_MAX } from "./workload-values.ts";

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
export type ResolvedReference = Readonly<{
  reference: Reference;
  value: Hex;
  scope: Record<string, unknown>;
}>;
export type CurrentPrincipalReadAuthority = Readonly<{
  readEncryptedPrincipalAt(pool: Address, account: Address, blockNumber: bigint): Promise<Hex>;
  decryptOwnedUint64(pool: Address, account: Address, handle: Hex): Promise<bigint>;
  encryptEuint64(
    pool: Address,
    account: Address,
    value: bigint,
  ): Promise<{ encryptedValues: readonly Hex[]; inputProof: Hex }>;
  blockAt(number: bigint): Promise<PinnedRead>;
  completionFor(actionId: string): Promise<DependencyCompletion | undefined>;
}>;
export type PinnedCurrentPrincipalInput = Readonly<{
  compiled: { actions: Action[]; definition: { contracts: Record<string, string> } };
  actionId: string;
  pinnedRead: PinnedRead;
  dependencyCompletions: readonly DependencyCompletion[];
  authority: CurrentPrincipalReadAuthority;
}>;

const clear = (value: unknown) => {
  if (typeof value !== "bigint" || value < 0n || value > UINT64_MAX)
    throw new Error("workload data: invalid current principal clear value");
  return value;
};

function principalReferences(action: Action, pool: Address, account: Address) {
  const all = refs(action.operation),
    inputs = all.filter((ref) => ref.kind === "sdkInput"),
    proofs = all.filter((ref) => ref.kind === "sdkProof");
  if (inputs.length !== 1 || proofs.length !== 1)
    throw new Error("workload data: invalid current principal references");
  const [input] = inputs,
    [proof] = proofs,
    principal = input.amount as Reference;
  const valid =
    principal &&
    [
      principal.kind === "currentPrincipal",
      principal.contractRole === "candidatePool",
      addr(principal.contract, "current principal contract") === pool,
      addr(principal.account, "current principal account") === account,
      principal.getter === "encryptedPrincipalOf(address)",
      principal.handleType === "euint64",
      principal.clearType === "uint64",
      principal.abiType === "uint64",
      JSON.stringify(principal.constraints) ===
        JSON.stringify(["checksummed-contract", "checksummed-account", "dependency-complete"]),
      input.producer === action.id,
      input.contractRole === "candidatePool",
      addr(input.actor, "current principal SDK actor") === account,
      input.purpose === "withdrawal",
      proof.producer === action.id,
      proof.field === "inputProof",
    ].every(Boolean);
  if (!valid) throw new Error("workload data: invalid current principal descriptor");
  return { input, proof, principal };
}

function finalAction(compiled: { actions: Action[] }, actionId: string): Action {
  const action = compiled.actions.find((entry) => entry.id === actionId) as Action | undefined;
  if (
    !action ||
    ![
      action.kind === "eoa",
      /^final-request-eoa-[0-9]{2}$/.test(action.id),
      action.phase === "final",
    ].every(Boolean)
  )
    throw new Error("workload data: action is not a final EOA withdrawal");
  return action;
}
async function validateDependencies(
  input: PinnedCurrentPrincipalInput,
  compiled: unknown,
  action: Action,
  pool: Address,
  principalPin: { number: bigint; hash: Hex },
) {
  const dependencies = action.dependencies ?? [],
    actions = new Map(
      (compiled as { actions: Action[] }).actions.map((entry) => [entry.id, entry]),
    );
  if (input.dependencyCompletions.length !== dependencies.length)
    throw new Error("workload data: incomplete current principal dependencies");
  for (const [index, dependencyId] of dependencies.entries()) {
    const completion = input.dependencyCompletions[index],
      dependency = actions.get(dependencyId);
    if (!completion || !dependency || completion.actionId !== dependencyId)
      throw new Error("workload data: unordered current principal dependencies");
    await validateCompletion({
      observed: completion,
      action: dependency,
      actions,
      compiled,
      pool,
      principalPin,
      completionFor: (actionId) => input.authority.completionFor(actionId),
      blockAt: (number) => input.authority.blockAt(number),
    });
  }
}
async function freshValue(
  authority: CurrentPrincipalReadAuthority,
  pool: Address,
  account: Address,
  pinValue: { number: bigint; hash: Hex },
) {
  const initial = pin(await authority.blockAt(pinValue.number), "initial pinned header");
  if (initial.number !== pinValue.number || initial.hash !== pinValue.hash)
    throw new Error("workload data: unresolved pinned header");
  const source = h32(
    await authority.readEncryptedPrincipalAt(pool, account, pinValue.number),
    "current principal handle",
  );
  if (source === `0x${"00".repeat(32)}`)
    throw new Error("workload data: invalid current principal handle");
  const encrypted = await authority.encryptEuint64(
    pool,
    account,
    clear(await authority.decryptOwnedUint64(pool, account, source)),
  );
  if (!Array.isArray(encrypted.encryptedValues) || encrypted.encryptedValues.length !== 1)
    throw new Error("workload data: expected one current principal encrypted value");
  const handle = h32(encrypted.encryptedValues[0], "current principal encrypted value");
  if (handle === source) throw new Error("workload data: current principal source handle reuse");
  const proof = bytes(encrypted.inputProof, "current principal input proof");
  if (proof === "0x") throw new Error("workload data: empty current principal input proof");
  const rechecked = pin(await authority.blockAt(pinValue.number), "rechecked pinned header");
  if (rechecked.number !== pinValue.number || rechecked.hash !== pinValue.hash)
    throw new Error("workload data: pinned header changed");
  return { handle, proof };
}

export async function resolvePinnedCurrentPrincipal(
  input: PinnedCurrentPrincipalInput,
): Promise<readonly ResolvedReference[]> {
  const compiled = validateCompiledCandidateWorkload(input.compiled),
    action = finalAction(compiled, input.actionId);
  const pool = addr(action.target, "current principal pool"),
    account = addr(action.actor, "current principal account"),
    pinValue = pin(input.pinnedRead, "pinned read"),
    { input: sdkInput, proof: sdkProof, principal } = principalReferences(action, pool, account);
  await validateDependencies(input, compiled, action, pool, pinValue);
  const { handle, proof } = await freshValue(input.authority, pool, account, pinValue);
  const common = {
    producer: sdkInput.producer,
    contractRole: sdkInput.contractRole,
    actor: account,
    purpose: sdkInput.purpose,
    currentPrincipal: principal,
    encryption: { contract: pool, actor: account, type: "euint64" },
  };
  return Object.freeze([
    Object.freeze({
      reference: sdkInput,
      value: handle,
      scope: scope(workloadFingerprint(compiled), action.id, sdkInput, pool, common),
    }),
    Object.freeze({
      reference: sdkProof,
      value: proof,
      scope: scope(workloadFingerprint(compiled), action.id, sdkProof, null, {
        inputReference: sdkInput,
      }),
    }),
  ]);
}
