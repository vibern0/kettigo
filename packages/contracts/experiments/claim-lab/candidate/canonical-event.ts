import { decodeEventLog, getAddress, type Address, type Hex } from "viem";
import { entryPoint07Abi } from "viem/account-abstraction";
import { confidentialPrizePoolAbi, confidentialUsdcAbi } from "../../../../protocol/src/index.ts";
import { FIXED_ENTRY_POINT_07, type CanonicalDependency } from "./workload-completion.ts";

type RawLog = Readonly<{
  address: Address;
  topics: readonly Hex[];
  data: Hex;
  transactionHash: Hex;
  blockHash: Hex;
  blockNumber: bigint;
  logIndex: number;
}>;
type Producer =
  | Readonly<{
      kind: "eoa";
      actionId: string;
      actor: Address;
      canonicalRecovery: CanonicalDependency;
    }>
  | Readonly<{
      kind: "safe";
      actionId: string;
      safe: Address;
      canonicalRecovery: CanonicalDependency;
    }>;
export type CanonicalReceiptEvidence = Readonly<{
  producer: Producer;
  receipt: {
    transactionHash: Hex;
    status: "success" | 1;
    blockNumber: bigint;
    blockHash: Hex;
    logs: readonly RawLog[];
  };
  header: { number: bigint; hash: Hex };
}>;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const address = (value: string) => getAddress(value as Address);
function validateReceiptIdentity(evidence: CanonicalReceiptEvidence): void {
  const { receipt, header } = evidence;
  if (
    (receipt.status !== "success" && receipt.status !== 1) ||
    receipt.blockNumber !== header.number ||
    !same(receipt.blockHash, header.hash)
  )
    throw new Error("workload data: invalid canonical receipt");
  for (const log of receipt.logs)
    if (
      !same(log.transactionHash, receipt.transactionHash) ||
      !same(log.blockHash, receipt.blockHash) ||
      log.blockNumber !== receipt.blockNumber ||
      !Number.isSafeInteger(log.logIndex) ||
      log.logIndex < 0
    )
      throw new Error("workload data: invalid canonical log identity");
}
function validateEoaProducer(
  evidence: CanonicalReceiptEvidence,
  saved: Extract<CanonicalDependency, { kind: "eoa" }>,
): void {
  const { producer, receipt } = evidence;
  if (
    saved.actionId !== producer.actionId ||
    !same(receipt.transactionHash, saved.transactionHash) ||
    receipt.blockNumber !== BigInt(saved.blockNumber) ||
    !same(receipt.blockHash, saved.blockHash)
  )
    throw new Error("workload data: invalid canonical producer");
}
function safeOperation(log: RawLog) {
  if (!same(log.address, FIXED_ENTRY_POINT_07)) return null;
  try {
    const event = decodeEventLog({
      abi: entryPoint07Abi,
      data: log.data,
      topics: [...log.topics] as [Hex, ...Hex[]],
    }) as unknown as { eventName: string; args: Record<string, unknown> };
    return event.eventName === "UserOperationEvent" || event.eventName === "BeforeExecution"
      ? event
      : null;
  } catch {
    return null;
  }
}
function safeOperationScope(
  evidence: CanonicalReceiptEvidence,
  saved: Extract<CanonicalDependency, { kind: "safe" }>,
) {
  const { producer, receipt } = evidence;
  if (producer.kind !== "safe") throw new Error("workload data: invalid canonical Safe producer");
  if (
    saved.actionId !== producer.actionId ||
    !same(saved.entryPoint, FIXED_ENTRY_POINT_07) ||
    !same(saved.sender, producer.safe) ||
    !same(receipt.transactionHash, saved.outerTransactionHash) ||
    receipt.blockNumber !== BigInt(saved.blockNumber) ||
    !same(receipt.blockHash, saved.blockHash)
  )
    throw new Error("workload data: invalid canonical Safe producer");
  const ordered = [...receipt.logs].sort((left, right) => left.logIndex - right.logIndex);
  if (new Set(ordered.map((log) => log.logIndex)).size !== ordered.length)
    throw new Error("workload data: ambiguous canonical log order");
  const own = ordered.filter((log) => {
    const event = safeOperation(log);
    return (
      event?.eventName === "UserOperationEvent" &&
      same(String(event.args.userOpHash), saved.userOperationHash) &&
      same(String(event.args.sender), saved.sender) &&
      event.args.success === true
    );
  });
  if (own.length !== 1) throw new Error("workload data: invalid Safe own user operation");
  const ownIndex = ordered.indexOf(own[0]);
  let boundary = -1;
  for (const log of ordered.slice(0, ownIndex).reverse()) {
    const event = safeOperation(log);
    if (event?.eventName === "UserOperationEvent" || event?.eventName === "BeforeExecution") {
      boundary = ordered.indexOf(log);
      break;
    }
  }
  if (boundary < 0) throw new Error("workload data: missing Safe execution boundary");
  return ordered.slice(boundary + 1, ownIndex);
}
function receipt(evidence: CanonicalReceiptEvidence) {
  validateReceiptIdentity(evidence);
  const { producer } = evidence;
  if (producer.kind === "eoa") {
    if (producer.canonicalRecovery.kind !== "eoa")
      throw new Error("workload data: invalid canonical producer");
    validateEoaProducer(evidence, producer.canonicalRecovery);
    return evidence.receipt.logs;
  }
  if (producer.canonicalRecovery.kind !== "safe")
    throw new Error("workload data: invalid canonical Safe producer");
  return safeOperationScope(evidence, producer.canonicalRecovery);
}
function exactly<T>(values: readonly T[]) {
  if (values.length !== 1) throw new Error("workload data: expected exactly one canonical event");
  return values[0];
}
function decoded(
  logs: readonly RawLog[],
  emitter: Address,
  abi: readonly unknown[],
  eventName: string,
) {
  return logs.flatMap((log) => {
    if (!same(log.address, emitter)) return [];
    try {
      const event = decodeEventLog({
        abi: abi as never,
        data: log.data,
        topics: [...log.topics] as [Hex, ...Hex[]],
      }) as unknown as { eventName: string; args: Record<string, unknown> };
      return event.eventName === eventName ? [{ log, args: event.args }] : [];
    } catch {
      return [];
    }
  });
}
const hex32 = (value: unknown) => {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new Error("workload data: invalid event handle");
  return value.toLowerCase() as Hex;
};

export function readAdmission(input: {
  evidence: CanonicalReceiptEvidence;
  pool: Address;
  account: Address;
}) {
  const account = address(input.account),
    matches = decoded(
      receipt(input.evidence),
      address(input.pool),
      confidentialPrizePoolAbi,
      "AdmissionRequested",
    ).filter(({ args }) => same(String(args.account), account));
  const { args } = exactly(matches);
  if (typeof args.nonce !== "bigint" || args.nonce < 0n)
    throw new Error("workload data: invalid admission nonce");
  return Object.freeze({ nonce: args.nonce.toString(), marker: hex32(args.marker) });
}

export function readWithdrawalUnwrap(input: {
  evidence: CanonicalReceiptEvidence;
  pool: Address;
  wrapper: Address;
  account: Address;
  batchId: string;
}) {
  if (!/^(0|[1-9][0-9]*)$/.test(input.batchId)) throw new Error("workload data: invalid batch ID");
  const account = address(input.account),
    logs = receipt(input.evidence),
    poolMatch = exactly(
      decoded(
        logs,
        address(input.pool),
        confidentialPrizePoolAbi,
        "WithdrawalClaimedToUsdc",
      ).filter(
        ({ args }) =>
          same(String(args.account), account) &&
          same(String(args.to), account) &&
          args.batchId === BigInt(input.batchId),
      ),
    );
  const request = hex32(poolMatch.args.unwrapRequestId),
    wrapperMatch = exactly(
      decoded(logs, address(input.wrapper), confidentialUsdcAbi, "UnwrapRequested").filter(
        ({ args }) =>
          same(String(args.receiver), account) && same(String(args.unwrapRequestId), request),
      ),
    );
  return Object.freeze({ unwrapRequestId: request, amount: hex32(wrapperMatch.args.amount) });
}

export function readWithdrawalBatchId(input: {
  evidence: CanonicalReceiptEvidence;
  pool: Address;
  account: Address;
}) {
  const account = address(input.account),
    match = exactly(
      decoded(
        receipt(input.evidence),
        address(input.pool),
        confidentialPrizePoolAbi,
        "WithdrawalRequested",
      ).filter(({ args }) => same(String(args.account), account)),
    );
  if (typeof match.args.batchId !== "bigint" || match.args.batchId < 0n)
    throw new Error("workload data: invalid withdrawal batch ID");
  return Object.freeze({ batchId: match.args.batchId.toString() });
}

export function readBatchClosed(input: {
  evidence: CanonicalReceiptEvidence;
  pool: Address;
  batchId: string;
}) {
  if (!/^(0|[1-9][0-9]*)$/.test(input.batchId)) throw new Error("workload data: invalid batch ID");
  const match = exactly(
    decoded(
      receipt(input.evidence),
      address(input.pool),
      confidentialPrizePoolAbi,
      "WithdrawalBatchClosed",
    ).filter(({ args }) => args.batchId === BigInt(input.batchId)),
  );
  return Object.freeze({
    total: hex32(match.args.total),
    morphoRestoreTotal: hex32(match.args.morphoRestoreTotal),
  });
}

export function readDrawClosed(input: { evidence: CanonicalReceiptEvidence; pool: Address }) {
  const match = exactly(
    decoded(receipt(input.evidence), address(input.pool), confidentialPrizePoolAbi, "DrawClosed"),
  );
  if (typeof match.args.drawId !== "bigint" || match.args.drawId < 0n)
    throw new Error("workload data: invalid draw ID");
  return Object.freeze({
    drawId: match.args.drawId.toString(),
    transactionHash: match.log.transactionHash,
    blockNumber: match.log.blockNumber,
    blockHash: match.log.blockHash,
    logIndex: match.log.logIndex,
  });
}

export function readDrawSnapshotClosed(input: {
  evidence: CanonicalReceiptEvidence;
  pool: Address;
  drawId: string;
}) {
  if (!/^(0|[1-9][0-9]*)$/.test(input.drawId)) throw new Error("workload data: invalid draw ID");
  const match = exactly(
    decoded(
      receipt(input.evidence),
      address(input.pool),
      confidentialPrizePoolAbi,
      "DrawSnapshotClosed",
    ).filter(({ args }) => args.drawId === BigInt(input.drawId)),
  );
  return Object.freeze({
    drawId: input.drawId,
    transactionHash: match.log.transactionHash,
    blockNumber: match.log.blockNumber,
    blockHash: match.log.blockHash,
    logIndex: match.log.logIndex,
    rootHash: hex32(match.args.rootHash),
    rootSum: hex32(match.args.rootSum),
    ticket: hex32(match.args.ticket),
    upperBound:
      typeof match.args.upperBound === "bigint"
        ? match.args.upperBound.toString()
        : (() => {
            throw new Error("workload data: invalid draw upper bound");
          })(),
    closeBlockNumber:
      typeof match.args.closeBlockNumber === "bigint"
        ? match.args.closeBlockNumber.toString()
        : (() => {
            throw new Error("workload data: invalid draw close block");
          })(),
  });
}

export function readMorphoUnwrap(input: {
  evidence: CanonicalReceiptEvidence;
  pool: Address;
  wrapper: Address;
  adapter: Address;
}) {
  const logs = receipt(input.evidence),
    poolMatch = exactly(
      decoded(
        logs,
        address(input.pool),
        confidentialPrizePoolAbi,
        "MorphoPrincipalUnwrapRequested",
      ),
    ),
    request = hex32(poolMatch.args.unwrapRequestId),
    wrapperMatch = exactly(
      decoded(logs, address(input.wrapper), confidentialUsdcAbi, "UnwrapRequested").filter(
        ({ args }) =>
          same(String(args.receiver), address(input.adapter)) &&
          same(String(args.unwrapRequestId), request),
      ),
    );
  return Object.freeze({ unwrapRequestId: request, amount: hex32(wrapperMatch.args.amount) });
}
