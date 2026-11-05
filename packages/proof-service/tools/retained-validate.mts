/** Independent structural checks for a retained canonical export. */
import { hash32, validateNamespace, type Namespace } from "../src/domain.ts";
import {
  digest,
  json,
  sameNamespace,
  stable,
  VERSION,
  type Manifest,
  type Retained,
} from "./retained-support.mts";

const hasTrustedDigest = (exported: Retained, trusted: Manifest) =>
  exported.manifest.version === VERSION &&
  trusted.version === VERSION &&
  exported.manifest.sha256 === digest(json(exported.payload)) &&
  trusted.sha256 === exported.manifest.sha256;
const hasTrustedNamespace = (namespace: Namespace, exported: Retained, trusted: Manifest) =>
  sameNamespace(namespace, exported.payload.namespace) &&
  sameNamespace(namespace, exported.manifest.namespace) &&
  sameNamespace(namespace, trusted.namespace) &&
  stable(trusted) === stable(exported.manifest);
const hasExpectedCounts = (exported: Retained) =>
  exported.payload.headers.length > 0 &&
  exported.payload.headers.length === exported.manifest.headers &&
  exported.payload.logs.length === exported.manifest.logs;
const hasExpectedRange = (namespace: Namespace, exported: Retained) =>
  exported.manifest.firstBlock === namespace.deploymentBlock &&
  exported.manifest.lastBlock === exported.payload.headers.at(-1)!.number &&
  stable(exported.manifest.checkpoint) === stable(exported.payload.checkpoint);
function validateHeaders(namespace: Namespace, exported: Retained) {
  for (let index = 0; index < exported.payload.headers.length; index += 1) {
    const header = exported.payload.headers[index];
    const parent = index
      ? hash32(exported.payload.headers[index - 1].hash)
      : hash32(exported.payload.deploymentParentHash);
    if (header.number !== namespace.deploymentBlock + index || hash32(header.parentHash) !== parent)
      throw new Error("retained header continuity mismatch");
  }
}
function validateLogs(namespace: Namespace, exported: Retained) {
  let lastBlock = -1;
  let lastLog = -1;
  for (const log of exported.payload.logs) {
    const header = exported.payload.headers[log.blockNumber - namespace.deploymentBlock];
    if (
      !Number.isSafeInteger(log.logIndex) ||
      log.logIndex < 0 ||
      log.blockNumber < lastBlock ||
      (log.blockNumber === lastBlock && log.logIndex <= lastLog) ||
      header?.hash !== log.blockHash
    )
      throw new Error("retained log identity mismatch");
    lastBlock = log.blockNumber;
    lastLog = log.logIndex;
  }
}
export function validateRetained(exported: Retained, trusted: Manifest, supplied: Namespace) {
  const namespace = validateNamespace(supplied);
  if (!hasTrustedDigest(exported, trusted)) throw new Error("retained export digest mismatch");
  if (!hasTrustedNamespace(namespace, exported, trusted))
    throw new Error("trusted manifest or namespace mismatch");
  if (!hasExpectedCounts(exported)) throw new Error("retained export row count mismatch");
  if (!hasExpectedRange(namespace, exported)) throw new Error("retained export range mismatch");
  validateHeaders(namespace, exported);
  validateLogs(namespace, exported);
  const checkpoint = exported.payload.checkpoint as Record<string, unknown>;
  if (
    Number(checkpoint.nextBlock) !== exported.payload.headers.at(-1)!.number + 1 ||
    Number(checkpoint.lastFinalizedBlock) !== exported.payload.headers.at(-1)!.number ||
    String(checkpoint.lastFinalizedHash) !== hash32(exported.payload.headers.at(-1)!.hash)
  )
    throw new Error("retained checkpoint mismatch");
}
