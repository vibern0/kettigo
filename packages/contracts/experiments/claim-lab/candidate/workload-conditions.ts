import { type Address, type Hex } from "viem";
import {
  validateCompiledCandidateWorkload,
  workloadFingerprint,
} from "./eoa-workload-definition.mjs";
import {
  FIXED_ENTRY_POINT_07,
  ZERO_HANDLE,
  type CanonicalDependency,
  type ConditionalCreditEvidence,
  type DependencyCompletion,
  type PinnedRead,
  addr,
  decimal,
  h32,
  validateCanonicalDependency,
} from "./workload-completion.ts";
import { canonical } from "./journal-values.mjs";

type Action = {
  id: string;
  kind: string;
  actor?: string;
  target?: string;
  dependencies?: readonly string[];
  operation?: { signature?: string; args?: unknown[] };
  refs?: { condition?: unknown };
};
type Authority = Readonly<{
  readEncryptedWinningsAt(pool: Address, account: Address, blockNumber: bigint): Promise<Hex>;
  decryptOwnedUint64?(pool: Address, account: Address, handle: Hex): Promise<bigint>;
  decryptSafeOwnedUint64?(pool: Address, safe: Address, handle: Hex): Promise<bigint>;
  blockAt(blockNumber: bigint): Promise<PinnedRead>;
  completionFor(actionId: string): Promise<DependencyCompletion | undefined>;
}>;
export type ConditionalCreditResolution =
  | Readonly<{ kind: "SKIPPED"; evidence: ConditionalCreditEvidence }>
  | Readonly<{ kind: "claim-eligible"; clearCredit: string }>;
const pin = (value: PinnedRead) => ({
  number: BigInt(decimal(value.number, "conditional read block")),
  hash: h32(value.hash, "conditional read block"),
});
function conditionalAction(
  compiled: { actions: Action[]; definition: { contracts: Record<string, string> } },
  actionId: string,
) {
  const action = compiled.actions.find((entry) => entry.id === actionId);
  if (
    !action ||
    (![
      "claim-stage8-eoa-00",
      "claim-stage8-eoa-01",
      "claim-stage8-eoa-02",
      "claim-stage8-eoa-03",
      "claim-stage8-eoa-04",
      "claim-stage8-eoa-05",
      "claim-stage8-eoa-06",
      "safe-conditional-wallet-claim",
    ].includes(action.id) &&
      !/^claim-stage33-eoa-(?:[0-2][0-9]|3[01])$/.test(action.id)) ||
    action.refs?.condition !== "positive-credit-or-SKIPPED" ||
    action.operation?.signature !== "claimPrize()" ||
    !Array.isArray(action.operation.args) ||
    action.operation.args.length
  )
    throw new Error("workload data: action is not a conditional claim");
  const pool = addr(compiled.definition.contracts.candidatePool, "conditional pool"),
    account = addr(action.actor, "conditional actor");
  if (addr(action.target, "conditional target") !== pool)
    throw new Error("workload data: invalid conditional target");
  return { action, pool, account };
}
async function dependencies(input: {
  action: Action;
  actions: Map<string, Action>;
  evidence: readonly DependencyCompletion[];
  authority: Authority;
  maximum: bigint;
}) {
  const ids = input.action.dependencies ?? [];
  if (ids.length !== input.evidence.length)
    throw new Error("workload data: incomplete conditional dependencies");
  const result: CanonicalDependency[] = [];
  const completions = input.evidence.values();
  for (const id of ids) {
    const completion = completions.next().value,
      action = input.actions.get(id),
      saved = await input.authority.completionFor(id);
    if (
      !action ||
      !completion ||
      completion.kind !== "canonical-success" ||
      completion.actionId !== id ||
      !saved ||
      canonical(saved) !== canonical(completion)
    )
      throw new Error("workload data: untrusted conditional dependency");
    validateCanonicalDependency(completion.evidence, action, input.maximum);
    result.push(completion.evidence);
  }
  return result;
}
async function requirePinnedBlock(
  authority: Authority,
  own: ReturnType<typeof pin>,
  message: string,
) {
  const checked = pin(await authority.blockAt(own.number));
  if (checked.number !== own.number || checked.hash !== own.hash)
    throw new Error(`workload data: ${message}`);
  return checked;
}
async function ownedConditionalCredit(input: {
  authority: Authority;
  action: Action;
  pool: Address;
  account: Address;
  blockNumber: bigint;
}) {
  const handle = h32(
    await input.authority.readEncryptedWinningsAt(input.pool, input.account, input.blockNumber),
    "conditional winnings handle",
  );
  if (handle === ZERO_HANDLE)
    return { handle, clear: 0n, resolution: "uninitialized-zero-handle" as const };
  const decrypt =
    input.action.kind === "externalSafe"
      ? input.authority.decryptSafeOwnedUint64
      : input.authority.decryptOwnedUint64;
  if (!decrypt)
    throw new Error(
      input.action.kind === "externalSafe"
        ? "workload data: Safe owned read authority required"
        : "workload data: owned read authority required",
    );
  const clear = await decrypt.call(input.authority, input.pool, input.account, handle);
  if (typeof clear !== "bigint" || clear < 0n || clear > (1n << 64n) - 1n)
    throw new Error("workload data: invalid conditional clear credit");
  return { handle, clear, resolution: "user-decrypt" as const };
}
function conditionalResult(input: {
  action: Action;
  compiled: { fingerprint: Hex };
  pool: Address;
  account: Address;
  own: ReturnType<typeof pin>;
  rechecked: ReturnType<typeof pin>;
  dependencies: readonly CanonicalDependency[];
  credit: Awaited<ReturnType<typeof ownedConditionalCredit>>;
}): ConditionalCreditResolution {
  if (input.credit.clear !== 0n)
    return Object.freeze({ kind: "claim-eligible", clearCredit: input.credit.clear.toString() });
  return Object.freeze({
    kind: "SKIPPED",
    evidence: Object.freeze({
      actionId: input.action.id,
      workloadFingerprint: workloadFingerprint(input.compiled) as Hex,
      condition: "positive-credit-or-SKIPPED",
      pool: input.pool,
      account: input.account,
      getter: "encryptedWinningsOf(address)",
      readBlock: {
        number: input.own.number.toString(),
        hash: input.own.hash,
        recheckedHash: input.rechecked.hash,
      },
      dependencies: Object.freeze(input.dependencies),
      handle: input.credit.handle,
      clearCredit: "0",
      resolution: input.credit.resolution,
    }),
  });
}
export async function resolveConditionalCredit(input: {
  compiled: {
    actions: Action[];
    definition: { contracts: Record<string, string> };
    fingerprint?: Hex;
  };
  actionId: string;
  readBlock: PinnedRead;
  dependencyCompletions: readonly DependencyCompletion[];
  authority: Authority;
}): Promise<ConditionalCreditResolution> {
  const compiled = validateCompiledCandidateWorkload(input.compiled) as typeof input.compiled & {
      fingerprint: Hex;
    },
    { action, pool, account } = conditionalAction(compiled, input.actionId),
    own = pin(input.readBlock),
    actions = new Map(compiled.actions.map((entry) => [entry.id, entry]));
  await requirePinnedBlock(input.authority, own, "unresolved conditional header");
  const deps = await dependencies({
    action,
    actions,
    evidence: input.dependencyCompletions,
    authority: input.authority,
    maximum: own.number,
  });
  const credit = await ownedConditionalCredit({
    authority: input.authority,
    action,
    pool,
    account,
    blockNumber: own.number,
  });
  const rechecked = await requirePinnedBlock(input.authority, own, "conditional block changed");
  return conditionalResult({
    action,
    compiled,
    pool,
    account,
    own,
    rechecked,
    dependencies: deps,
    credit,
  });
}
