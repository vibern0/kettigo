import { type Address, type Hex } from "viem";
import { entryPoint07Address } from "viem/account-abstraction";
import { canonical } from "./journal-values.mjs";
import { addr, decimal, h32 } from "./workload-values.ts";

export type CanonicalDecimalString = string;
export type CanonicalDependency =
  | Readonly<{
      kind: "eoa";
      actionId: string;
      transactionHash: Hex;
      blockNumber: CanonicalDecimalString;
      blockHash: Hex;
    }>
  | Readonly<{
      kind: "safe";
      actionId: string;
      userOperationHash: Hex;
      entryPoint: Address;
      sender: Address;
      outerTransactionHash: Hex;
      blockNumber: CanonicalDecimalString;
      blockHash: Hex;
    }>;
export type ConditionalCreditEvidence = Readonly<{
  actionId: string;
  workloadFingerprint: Hex;
  condition: "positive-credit-or-SKIPPED";
  pool: Address;
  account: Address;
  getter: "encryptedWinningsOf(address)";
  readBlock: Readonly<{ number: CanonicalDecimalString; hash: Hex; recheckedHash: Hex }>;
  dependencies: readonly CanonicalDependency[];
  handle: Hex;
  clearCredit: "0";
  resolution: "user-decrypt" | "uninitialized-zero-handle";
}>;
export type DependencyCompletion =
  | Readonly<{ kind: "canonical-success"; actionId: string; evidence: CanonicalDependency }>
  | Readonly<{
      kind: "conditional-SKIPPED";
      actionId: string;
      evidence: ConditionalCreditEvidence;
    }>;
export type PinnedRead = Readonly<{ number: CanonicalDecimalString; hash: Hex }>;
export type CompletionAction = Readonly<{
  id: string;
  kind: string;
  actor?: string;
  dependencies?: readonly string[];
}>;

export const FIXED_ENTRY_POINT_07 = getAddress(entryPoint07Address);
export const ZERO_HANDLE = `0x${"00".repeat(32)}` as Hex;

export { addr, decimal, h32 } from "./workload-values.ts";
export const pin = (value: unknown, label: string) => {
  const record = value as PinnedRead;
  return { number: BigInt(decimal(record?.number, label)), hash: h32(record?.hash, label) };
};

const conditionalId = (id: string) =>
  /^claim-stage(?:8|33)-eoa-[0-9]{2}$/.test(id) || id === "safe-conditional-wallet-claim";

export function validateCanonicalDependency(
  evidence: CanonicalDependency,
  action: CompletionAction,
  maximum: bigint,
): void {
  if (
    !evidence ||
    evidence.actionId !== action.id ||
    BigInt(decimal(evidence.blockNumber, "dependency block")) > maximum
  )
    throw new Error("workload data: invalid dependency evidence");
  h32(evidence.blockHash, "dependency block hash");
  if (action.kind === "externalSafe") {
    if (
      evidence.kind !== "safe" ||
      addr(evidence.entryPoint, "Safe entry point") !== FIXED_ENTRY_POINT_07 ||
      addr(evidence.sender, "Safe sender") !== addr(action.actor, "Safe actor")
    )
      throw new Error("workload data: invalid Safe dependency identity");
    h32(evidence.userOperationHash, "Safe user operation hash");
    h32(evidence.outerTransactionHash, "Safe outer transaction hash");
  } else if (evidence.kind !== "eoa")
    throw new Error("workload data: invalid EOA dependency identity");
  else h32(evidence.transactionHash, "EOA transaction hash");
}

export async function validateCompletion(input: {
  observed: DependencyCompletion;
  action: CompletionAction;
  actions: ReadonlyMap<string, CompletionAction>;
  compiled: unknown;
  pool: Address;
  principalPin: { number: bigint; hash: Hex };
  completionFor(actionId: string): Promise<DependencyCompletion | undefined>;
  blockAt(number: bigint): Promise<PinnedRead>;
}): Promise<void> {
  const { observed, action, actions, compiled, pool, principalPin } = input;
  const saved = await input.completionFor(action.id);
  if (!saved || canonical(observed) !== canonical(saved) || observed.actionId !== action.id)
    throw new Error("workload data: untrusted dependency completion");
  if (observed.kind === "canonical-success")
    return validateCanonicalDependency(observed.evidence, action, principalPin.number);
  const evidence = observed.evidence;
  if (
    observed.kind !== "conditional-SKIPPED" ||
    !["user-decrypt", "uninitialized-zero-handle"].includes(evidence.resolution) ||
    !conditionalId(action.id) ||
    evidence.actionId !== action.id ||
    h32(evidence.workloadFingerprint, "conditional fingerprint") !==
      (compiled as { fingerprint: Hex }).fingerprint ||
    evidence.condition !== "positive-credit-or-SKIPPED" ||
    addr(evidence.pool, "conditional pool") !== pool ||
    addr(evidence.account, "conditional account") !== addr(action.actor, "conditional actor") ||
    evidence.getter !== "encryptedWinningsOf(address)" ||
    evidence.clearCredit !== "0"
  )
    throw new Error("workload data: unresolved current principal dependency");
  const own = pin(evidence.readBlock, "conditional read block");
  if (
    own.number > principalPin.number ||
    own.hash !== h32(evidence.readBlock.recheckedHash, "conditional rechecked hash")
  )
    throw new Error("workload data: invalid conditional pin");
  const rechecked = pin(await input.blockAt(own.number), "conditional block recheck");
  if (rechecked.number !== own.number || rechecked.hash !== own.hash)
    throw new Error("workload data: conditional block changed");
  if (
    (evidence.resolution === "user-decrypt" &&
      h32(evidence.handle, "conditional handle") === ZERO_HANDLE) ||
    (evidence.resolution === "uninitialized-zero-handle" &&
      h32(evidence.handle, "conditional handle") !== ZERO_HANDLE)
  )
    throw new Error("workload data: invalid conditional handle resolution");
  const dependencies = action.dependencies ?? [];
  if (evidence.dependencies.length !== dependencies.length)
    throw new Error("workload data: incomplete conditional dependencies");
  for (let index = 0; index < dependencies.length; index += 1) {
    const child = actions.get(dependencies[index]);
    if (!child) throw new Error("workload data: missing conditional dependency");
    validateCanonicalDependency(evidence.dependencies[index], child, own.number);
  }
}
