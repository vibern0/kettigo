import { constants } from "node:fs";
import { open } from "node:fs/promises";
import process from "node:process";
import { Buffer } from "node:buffer";
import { getAddress, isAddress } from "ethers";

import { ORIGINAL_ENVELOPE } from "./journal.mjs";
import { envelopeIdentity } from "./journal-values.mjs";

const MAX_BYTES = 65_536;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const FORBIDDEN = new Set(
  [
    "0xe65D6459a7Ce01315FbB0998C37233c6FeE3aB8b",
    "0x9c23E5f7143612dc1232FC643A57300291e0d719",
    "0xAdB8F835E565aC7e71d2DF6cFBd0FC003fa22C27",
  ].map(getAddress),
);
const fail = (message) => {
  throw new Error(`candidate definition: ${message}`);
};
const plain = (value) =>
  Boolean(value) &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) =>
  plain(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
function address(value, label) {
  if (typeof value !== "string" || !isAddress(value)) fail(`invalid ${label}`);
  const normalized = getAddress(value);
  if (FORBIDDEN.has(normalized)) fail("forbidden target");
  return normalized;
}
function hash(value, label) {
  if (typeof value !== "string" || !HASH.test(value)) fail(`invalid ${label}`);
  return value.toLowerCase();
}
function ids(value, label, { min = 1, max = 32 } = {}) {
  if (
    !Array.isArray(value) ||
    value.length < min ||
    value.length > max ||
    value.some((entry) => typeof entry !== "string" || !entry || entry.length > 128) ||
    new Set(value).size !== value.length
  )
    fail(`invalid ${label}`);
  return Object.freeze([...value]);
}
function addresses(value, label, { min = 1, max = 32 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(`invalid ${label}`);
  const result = value.map((entry) => address(entry, label));
  if (new Set(result).size !== result.length) fail(`duplicate ${label}`);
  return Object.freeze(result);
}

function registry(value) {
  if (!exact(value, ["eoaParticipants", "safeParticipant", "sponsor", "bootstrapOperator"]))
    fail("invalid actor registry");
  const eoaParticipants = addresses(value.eoaParticipants, "EOA participants", {
    min: 32,
    max: 32,
  });
  const safeParticipant = address(value.safeParticipant, "Safe participant");
  const sponsor = address(value.sponsor, "sponsor");
  const bootstrapOperator = address(value.bootstrapOperator, "bootstrap operator");
  const all = [...eoaParticipants, safeParticipant, sponsor, bootstrapOperator];
  if (new Set(all).size !== all.length) fail("actor cross-role conflict");
  return Object.freeze({ eoaParticipants, safeParticipant, sponsor, bootstrapOperator });
}
function contracts(value) {
  const keys = [
    "candidatePool",
    "wrapper",
    "adapter",
    "underlying",
    "safe4337Module",
    "entryPoint",
    "multiSend",
    "factory",
    "setup",
  ];
  if (!exact(value, keys)) fail("invalid contract registry");
  const result = Object.fromEntries(keys.map((key) => [key, address(value[key], key)]));
  if (new Set(Object.values(result)).size !== keys.length) fail("contract cross-role conflict");
  return Object.freeze(result);
}
function validate(value) {
  const keys = [
    "version",
    "chainId",
    "envelopeIdentity",
    "actors",
    "contracts",
    "allowedEoaTargets",
    "creationInputDigests",
    "deploymentCreationHashes",
    "workloadIds",
    "initialFundingWorkloadIds",
  ];
  if (!exact(value, keys) || value.version !== 1 || value.chainId !== 11155111)
    fail("invalid definition identity");
  if (value.envelopeIdentity !== envelopeIdentity(ORIGINAL_ENVELOPE))
    fail("wrong original envelope");
  const normalized = validateWorkload(value);
  return Object.freeze({
    chainId: 11155111,
    envelopeIdentity: value.envelopeIdentity,
    policy: "original",
    ...normalized,
  });
}
function validateWorkload(value) {
  const actors = registry(value.actors);
  const contractRegistry = contracts(value.contracts);
  if (
    Object.values(actors)
      .flat()
      .some((actor) => Object.values(contractRegistry).includes(actor))
  )
    fail("actor contract cross-role conflict");
  const allowedEoaTargets = addresses(value.allowedEoaTargets, "allowed EOA targets", {
    min: 1,
    max: 16,
  });
  for (const target of allowedEoaTargets)
    if (!Object.values(contractRegistry).includes(target)) fail("unknown write target");
  const creationInputDigests = hashes(value.creationInputDigests, "creation input digests");
  const deploymentCreationHashes = hashes(
    value.deploymentCreationHashes,
    "deployment creation hashes",
  );
  const workloadIds = ids(value.workloadIds, "workload IDs");
  const initialFundingWorkloadIds = ids(
    value.initialFundingWorkloadIds,
    "initial funding workload IDs",
    { min: 2, max: 2 },
  );
  if (!initialFundingWorkloadIds.every((entry) => workloadIds.includes(entry)))
    fail("unknown initial funding workload");
  return {
    actors,
    contracts: contractRegistry,
    allowedEoaTargets,
    creationInputDigests,
    deploymentCreationHashes,
    workloadIds,
    initialFundingWorkloadIds,
  };
}
function hashes(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) fail(`invalid ${label}`);
  const result = value.map((entry) => hash(entry, label));
  if (new Set(result).size !== result.length) fail(`duplicate ${label}`);
  return Object.freeze(result);
}

export async function loadStaticRunDefinition(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const details = await handle.stat();
    if (
      !details.isFile() ||
      details.size > MAX_BYTES ||
      (details.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && details.uid !== process.getuid())
    )
      throw new Error();
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > MAX_BYTES) throw new Error();
    return validate(JSON.parse(buffer.toString("utf8", 0, bytesRead)));
  } catch (error) {
    if (error?.message?.startsWith("candidate definition:")) throw error;
    fail("definition unavailable or permissions invalid");
  } finally {
    await handle?.close();
  }
}
export function candidateActorRole(definition, actor) {
  const normalized = address(actor, "actor");
  if (definition.actors.eoaParticipants.includes(normalized)) return "participant";
  for (const role of ["safeParticipant", "sponsor", "bootstrapOperator"])
    if (definition.actors[role] === normalized) return role;
  fail("unknown actor");
}
