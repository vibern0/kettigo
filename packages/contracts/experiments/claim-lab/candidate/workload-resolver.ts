import {
  validateCompiledCandidateWorkload,
  workloadFingerprint,
} from "./eoa-workload-definition.mjs";
import {
  decryptPublic,
  decryptPublicMarker,
  resolveSdkReferences,
  type ResolvedReference,
} from "./workload-data.ts";
import {
  readAdmission,
  readBatchClosed,
  readDrawClosed,
  readDrawSnapshotClosed,
  readMorphoUnwrap,
  readWithdrawalBatchId,
  readWithdrawalUnwrap,
  type CanonicalReceiptEvidence,
} from "./canonical-event.ts";
import { resolveHistoricPrizeProof, type HistoricPrizeProofInput } from "./historic-prize-proof.ts";
import type { Address } from "viem";
import { addr, refs, scope } from "./workload-values.ts";

type Sdk = Parameters<typeof resolveSdkReferences>[0]["sdk"];
type Evidence = Readonly<Record<string, CanonicalReceiptEvidence>>;
type Compiled = {
  actions: { id: string; kind: string; actor: string; operation?: unknown }[];
  definition: { contracts: Record<string, string> };
};
type Historic = Pick<
  HistoricPrizeProofInput,
  "baseUrl" | "fetch" | "readSnapshot" | "readBlockHash"
>;

/** Resolves the graph's closed, data-only EOA dependencies for the approved encoder. */
export async function resolveCandidateAction(input: {
  compiled: Parameters<typeof validateCompiledCandidateWorkload>[0];
  actionId: string;
  sdk: Sdk;
  evidence?: Evidence;
  historic?: Historic;
  pinnedCurrentPrincipal?: Parameters<typeof resolveSdkReferences>[0]["pinnedCurrentPrincipal"];
}): Promise<readonly ResolvedReference[]> {
  const { compiled, action } = candidateAction(input.compiled, input.actionId);
  const result = await sdkRecords(compiled, action.id, input.sdk, input.pinnedCurrentPrincipal);
  await addRuntimeRecords({
    compiled,
    action,
    sdk: input.sdk,
    evidence: input.evidence,
    historic: input.historic,
    result,
  });
  return Object.freeze(result);
}
function candidateAction(
  input: Parameters<typeof validateCompiledCandidateWorkload>[0],
  actionId: string,
) {
  const compiled = validateCompiledCandidateWorkload(input) as Compiled,
    action = compiled.actions.find((entry) => entry.id === actionId);
  if (!action || action.kind !== "eoa")
    throw new Error("workload data: action is not an EOA action");
  if (!("target" in action) || (action as { target?: unknown }).target === null)
    throw new Error("workload data: creation actions cannot be resolved");
  return { compiled, action };
}
async function sdkRecords(
  compiled: Compiled,
  actionId: string,
  sdk: Sdk,
  pinnedCurrentPrincipal: Parameters<typeof resolveSdkReferences>[0]["pinnedCurrentPrincipal"],
) {
  return [
    ...(await resolveSdkReferences({
      compiled: compiled as Parameters<typeof resolveSdkReferences>[0]["compiled"],
      actionId,
      sdk,
      ...(pinnedCurrentPrincipal ? { pinnedCurrentPrincipal } : {}),
    })),
  ];
}
async function addRuntimeRecords(input: {
  compiled: Compiled;
  action: Compiled["actions"][number];
  sdk: Sdk;
  evidence?: Evidence;
  historic?: Historic;
  result: ResolvedReference[];
}): Promise<void> {
  const families = new Map<string, ReturnType<typeof historicBundle>>();
  const eventFamilies = new Map<string, ReturnType<typeof eventBundle>>(),
    batchIds = new Map<string, string>();
  for (const ref of refs(input.action.operation)) {
    if (ref.kind === "delegateData") {
      if (ref.abiType !== "bytes")
        throw new Error("workload data: invalid delegate data descriptor");
      input.result.push(resolved(input.compiled, input.action.id, ref, "0x"));
    }
    if (ref.kind === "receiptEvent" || ref.kind === "publicDecrypt") {
      await addEventRecord(input, ref, eventFamilies, batchIds);
    }
    if (ref.kind === "historicalProof") {
      await addHistoricRecord(input, ref, families);
    }
  }
}
async function addEventRecord(
  input: Parameters<typeof addRuntimeRecords>[0],
  ref: Record<string, unknown>,
  families: Map<string, ReturnType<typeof eventBundle>>,
  batchIds: Map<string, string>,
) {
  const key = `${text(ref.producer, "canonical producer")}:${text(ref.event, "canonical event")}`;
  let family = families.get(key);
  if (!family) {
    family = eventBundle(ref, input.compiled, evidence(input.evidence), input.sdk, batchIds);
    families.set(key, family);
  }
  const values = await family,
    field = text(ref.field, "canonical event field");
  if (!Object.hasOwn(values, field)) throw new Error("workload data: invalid closed event field");
  input.result.push(
    resolved(input.compiled, input.action.id, ref, values[field] as ResolvedReference["value"]),
  );
}
async function addHistoricRecord(
  input: Parameters<typeof addRuntimeRecords>[0],
  ref: Record<string, unknown>,
  families: Map<string, ReturnType<typeof historicBundle>>,
) {
  const producer = text(ref.producer, "historic proof producer"),
    key = `${producer}:${text(ref.beneficiary, "historic proof beneficiary")}`;
  let bundle = families.get(key);
  if (!bundle) {
    bundle = historicBundle(
      ref,
      input.compiled,
      evidence(input.evidence),
      requiredHistoric(input.historic),
    );
    families.set(key, bundle);
  }
  const value = await bundle,
    field = text(ref.field, "historic proof field");
  if (!(field in value)) throw new Error("workload data: invalid historic proof field");
  input.result.push(
    resolved(input.compiled, input.action.id, ref, value[field as keyof Awaited<typeof value>], {
      producer,
      contractRole: text(ref.contractRole, "historic proof contract role"),
      beneficiary: text(ref.beneficiary, "historic proof beneficiary"),
      depth: 32,
      bundleId: value.bundleId,
    }),
  );
}
function resolved(
  compiled: Compiled,
  actionId: string,
  reference: Record<string, unknown>,
  value: unknown,
  extra: Record<string, unknown> = {},
): ResolvedReference {
  const contract = reference.contractRole
    ? addr(compiled.definition.contracts[String(reference.contractRole)], "reference contract")
    : null;
  return Object.freeze({
    reference,
    value: value as ResolvedReference["value"],
    scope: scope(workloadFingerprint(compiled), actionId, reference, contract, extra),
  });
}
async function eventBundle(
  ref: Record<string, unknown>,
  compiled: Compiled,
  evidence: Evidence,
  sdk: Sdk,
  batchIds: Map<string, string>,
): Promise<Record<string, ResolvedReference["value"]>> {
  const source = producerEvidence(compiled, text(ref.producer, "canonical producer"), evidence);
  return eventValues({
    ref,
    compiled,
    source,
    evidence,
    sdk,
    batchIds,
    pool: addr(compiled.definition.contracts.candidatePool, "candidate pool"),
    wrapper: addr(compiled.definition.contracts.wrapper, "wrapper"),
    adapter: addr(compiled.definition.contracts.adapter, "adapter"),
    account: eventAccount(ref, source),
  });
}
function eventAccount(ref: Record<string, unknown>, source: CanonicalReceiptEvidence) {
  if (ref.beneficiary) return addr(ref.beneficiary, "beneficiary");
  if (ref.receiver) return addr(ref.receiver, "receiver");
  return source.producer.kind === "eoa"
    ? addr(source.producer.actor, "actor")
    : addr(source.producer.safe, "Safe");
}
async function eventValues(input: {
  ref: Record<string, unknown>;
  compiled: Compiled;
  source: CanonicalReceiptEvidence;
  evidence: Evidence;
  sdk: Sdk;
  batchIds: Map<string, string>;
  pool: Address;
  wrapper: Address;
  adapter: Address;
  account: Address;
}): Promise<Record<string, ResolvedReference["value"]>> {
  const { ref } = input;
  if (ref.event === "AdmissionRequested") {
    const event = readAdmission({
      evidence: input.source,
      pool: input.pool,
      account: input.account,
    });
    const marker = await decryptPublicMarker({ sdk: input.sdk, handle: event.marker });
    if (marker.value !== true) throw new Error("workload data: admission marker is not true");
    return { nonce: event.nonce, marker: marker.proof };
  }
  if (ref.event === "WithdrawalRequested") {
    const batchId = readWithdrawalBatchId({
      evidence: input.source,
      pool: input.pool,
      account: input.account,
    }).batchId;
    input.batchIds.set(text(ref.producer, "withdrawal producer"), batchId);
    return { batchId };
  }
  if (ref.event === "DrawClosed")
    return { drawId: readDrawClosed({ evidence: input.source, pool: input.pool }).drawId };
  if (ref.event === "WithdrawalBatchClosed") {
    return batchClosedValues(input);
  }
  return unwrapValues(input);
}
async function batchClosedValues(input: Parameters<typeof eventValues>[0]) {
  const event = readBatchClosed({
    evidence: input.source,
    pool: input.pool,
    batchId: batchIdFor(
      input.compiled,
      text(input.ref.producer, "batch close producer"),
      input.evidence,
      input.batchIds,
    ),
  });
  const clear = await decryptPublic({
    sdk: input.sdk,
    handles: [event.total, event.morphoRestoreTotal],
  });
  return {
    clearTotal: clear.values[0],
    clearMorphoRestore: clear.values[1],
    settlementProof: clear.proof,
  };
}
async function unwrapValues(input: Parameters<typeof eventValues>[0]) {
  const { ref } = input;
  const unwrap =
    ref.event === "WithdrawalClaimedToUsdc" ||
    (ref.event === "UnwrapRequested" && ref.receiver !== input.adapter)
      ? readWithdrawalUnwrap({
          evidence: input.source,
          pool: input.pool,
          wrapper: input.wrapper,
          account: input.account,
          batchId: batchIdFor(
            input.compiled,
            text(ref.producer, "withdrawal producer"),
            input.evidence,
            input.batchIds,
          ),
        })
      : ref.event === "MorphoPrincipalUnwrapRequested" ||
          (ref.event === "UnwrapRequested" && ref.receiver === input.adapter)
        ? readMorphoUnwrap({
            evidence: input.source,
            pool: input.pool,
            wrapper: input.wrapper,
            adapter: input.adapter,
          })
        : undefined;
  if (!unwrap) throw new Error("workload data: unsupported closed event reference");
  const clear = await decryptPublic({ sdk: input.sdk, handles: [unwrap.amount] });
  return {
    unwrapRequestId: unwrap.unwrapRequestId,
    clearAmount: clear.values[0],
    proof: clear.proof,
  };
}

function batchIdFor(
  compiled: Compiled,
  producer: string,
  all: Evidence,
  known: Map<string, string>,
): string {
  const knownBatch = known.get(producer);
  if (knownBatch) return knownBatch;
  const action = compiled.actions.find((entry) => entry.id === producer);
  const ref =
    action &&
    refs(action.operation).find(
      (entry) => entry.kind === "receiptEvent" && entry.event === "WithdrawalRequested",
    );
  if (!ref) throw new Error("workload data: producer has no graph-bound withdrawal batch");
  const source = producerEvidence(compiled, text(ref.producer, "withdrawal producer"), all);
  const pool = addr(compiled.definition.contracts.candidatePool, "candidate pool");
  const account = addr(ref.beneficiary, "withdrawal beneficiary");
  const batchId = readWithdrawalBatchId({ evidence: source, pool, account }).batchId;
  known.set(producer, batchId);
  return batchId;
}

const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value) throw new Error(`workload data: invalid ${label}`);
  return value;
};
const evidence = (value: Evidence | undefined): Evidence => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("workload data: canonical evidence is required");
  return value;
};
const requiredHistoric = (value: Historic | undefined): Historic => {
  if (!value) throw new Error("workload data: historic proof evidence is required");
  return value;
};
async function historicBundle(
  ref: Record<string, unknown>,
  compiled: Compiled,
  all: Evidence,
  historic: Historic,
) {
  if (ref.event !== "DrawSnapshotClosed" || ref.contractRole !== "candidatePool")
    throw new Error("workload data: invalid historic proof descriptor");
  const source = producerEvidence(compiled, text(ref.producer, "historic proof producer"), all);
  const pool = addr(compiled.definition.contracts.candidatePool, "candidate pool"),
    closed = readDrawClosed({ evidence: source, pool }),
    snapshot = readDrawSnapshotClosed({ evidence: source, pool, drawId: closed.drawId });
  return resolveHistoricPrizeProof({
    pool,
    account: addr(ref.beneficiary, "historic proof beneficiary"),
    drawId: closed.drawId,
    closedDraw: {
      drawId: closed.drawId,
      transactionHash: closed.transactionHash,
      blockNumber: closed.blockNumber.toString(),
      blockHash: closed.blockHash,
    },
    snapshotClosed: {
      drawId: snapshot.drawId,
      transactionHash: snapshot.transactionHash,
      blockNumber: snapshot.blockNumber.toString(),
      blockHash: snapshot.blockHash,
      logIndex: snapshot.logIndex,
    },
    baseUrl: historic.baseUrl,
    fetch: historic.fetch,
    readSnapshot: historic.readSnapshot,
    readBlockHash: historic.readBlockHash,
  });
}
function producerEvidence(compiled: Compiled, producerId: string, all: Evidence) {
  const expected = compiled.actions.find((action) => action.id === producerId);
  const source = all[producerId];
  const expectedKind =
    expected?.kind === "eoa" ? "eoa" : expected?.kind === "externalSafe" ? "safe" : null;
  if (!expected || !source || !expectedKind || source.producer.actionId !== expected.id)
    throw new Error("workload data: invalid canonical producer evidence");
  const actualActor = source.producer.kind === "eoa" ? source.producer.actor : source.producer.safe;
  if (
    source.producer.kind !== expectedKind ||
    addr(actualActor, "producer actor") !== addr(expected.actor, "producer actor")
  )
    throw new Error("workload data: invalid canonical producer evidence");
  return source;
}
