import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const hash = (value) => `0x${createHash("sha256").update(value).digest("hex")}`;
const bytecode = (value, label) => {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(value))
    throw new Error(`candidate artifact evidence: invalid ${label} bytecode`);
  return value.toLowerCase();
};

/** Produces read-only build evidence; it never reads credentials or contacts a network. */
export function candidateArtifactEvidence(artifact, compilerMetadata = artifact?.metadata) {
  if (!artifact || typeof artifact.contractName !== "string" || typeof artifact.sourceName !== "string")
    throw new Error("candidate artifact evidence: invalid artifact identity");
  let metadata;
  try {
    metadata =
      typeof compilerMetadata === "string" ? JSON.parse(compilerMetadata) : compilerMetadata;
  } catch {
    throw new Error("candidate artifact evidence: invalid compiler metadata");
  }
  const compiler = metadata?.compiler;
  const settings = metadata?.settings;
  if (typeof compiler?.version !== "string" || !settings || typeof settings !== "object")
    throw new Error("candidate artifact evidence: missing compiler metadata");
  return Object.freeze({
    contractName: artifact.contractName,
    sourceName: artifact.sourceName,
    creationBytecodeHash: hash(bytecode(artifact.bytecode, "creation")),
    runtimeBytecodeHash: hash(bytecode(artifact.deployedBytecode, "runtime")),
    compiler: Object.freeze({ version: compiler.version, settings }),
  });
}

export async function readCandidateArtifactEvidence(path) {
  const artifact = JSON.parse(await readFile(path, "utf8"));
  const buildInfo = join(dirname(dirname(dirname(path))), "build-info");
  for (const name of await readdir(buildInfo)) {
    const candidate = JSON.parse(await readFile(join(buildInfo, name), "utf8"));
    const contract = candidate?.output?.contracts?.[artifact.sourceName]?.[artifact.contractName];
    if (contract?.metadata) return candidateArtifactEvidence(artifact, contract.metadata);
  }
  throw new Error("candidate artifact evidence: matching build info unavailable");
}
