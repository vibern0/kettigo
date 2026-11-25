import { getAddress } from "ethers";

import { exact, fail } from "./eoa-workload-graph-utils.mjs";

export function normalizedDefinition(definition, manifest) {
  return Object.freeze({
    chainId: definition.chainId,
    envelopeIdentity: definition.envelopeIdentity,
    policy: definition.policy,
    actors: Object.freeze({
      ...definition.actors,
      eoaParticipants: Object.freeze(definition.actors.eoaParticipants.map(getAddress)),
      safeParticipant: getAddress(definition.actors.safeParticipant),
      sponsor: getAddress(definition.actors.sponsor),
      bootstrapOperator: getAddress(definition.actors.bootstrapOperator),
    }),
    contracts: Object.freeze(
      Object.fromEntries(
        Object.entries(definition.contracts).map(([key, value]) => [key, getAddress(value)]),
      ),
    ),
    allowedEoaTargets: Object.freeze(definition.allowedEoaTargets.map(getAddress)),
    creationInputDigests: Object.freeze(
      [...definition.creationInputDigests].map((value) => value.toLowerCase()),
    ),
    deploymentCreationHashes: Object.freeze(
      [...definition.deploymentCreationHashes].map((value) => value.toLowerCase()),
    ),
    workloadIds: Object.freeze([...definition.workloadIds]),
    initialFundingWorkloadIds: Object.freeze([...definition.initialFundingWorkloadIds]),
    manifest: Object.freeze({
      chainId: manifest.chainId,
      compiler: manifest.compiler,
      creations: manifest.creations,
    }),
  });
}
export function validateManifest(definition, manifest) {
  if (
    !exact(manifest, ["chainId", "compiler", "creations"]) ||
    manifest.chainId !== 11155111 ||
    !validCompiler(manifest.compiler) ||
    !Array.isArray(manifest.creations) ||
    manifest.creations.length !== 3
  )
    fail("invalid creation manifest");
  const roles = ["wrapper", "pool", "adapter"];
  const sourceIds = [
    "contracts/ConfidentialUSDC.sol:ConfidentialUSDC",
    "contracts/ConfidentialPrizePool.sol:ConfidentialPrizePool",
    "contracts/MorphoYieldAdapter.sol:MorphoYieldAdapter",
  ];
  const creations = manifest.creations.map((creation, index) => {
    if (
      !exact(creation, [
        "role",
        "sourceId",
        "artifactProvenance",
        "compilerBuildHash",
        "creationBytecodeHash",
        "inputDigest",
        "constructor",
      ]) ||
      creation.role !== roles[index] ||
      creation.sourceId !== sourceIds[index] ||
      !validProvenance(creation.artifactProvenance, creation.sourceId) ||
      !/^0x[0-9a-fA-F]{64}$/.test(creation.compilerBuildHash) ||
      !/^0x[0-9a-fA-F]{64}$/.test(creation.creationBytecodeHash) ||
      typeof creation.inputDigest !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(creation.inputDigest) ||
      creation.inputDigest.toLowerCase() !== definition.creationInputDigests[index] ||
      creation.creationBytecodeHash.toLowerCase() !== definition.deploymentCreationHashes[index]
    )
      fail("invalid creation manifest");
    return normalizeCreation(creation, index, definition.contracts);
  });
  return Object.freeze({
    chainId: 11155111,
    compiler: Object.freeze({ ...manifest.compiler }),
    creations: Object.freeze(creations),
  });
}
function validCompiler(value) {
  return (
    exact(value, ["version", "optimizerRuns", "viaIR", "evmVersion"]) &&
    value.version === "0.8.28" &&
    value.optimizerRuns === 200 &&
    value.viaIR === true &&
    value.evmVersion === "cancun"
  );
}
function validProvenance(value, sourceId) {
  const contractName = sourceId.slice(sourceId.lastIndexOf(":") + 1);
  return (
    exact(value, ["sourceId", "contractName"]) &&
    value.sourceId === sourceId &&
    value.contractName === contractName
  );
}
function normalizedAddress(value, label) {
  if (typeof value !== "string") fail(`invalid ${label}`);
  try {
    return getAddress(value);
  } catch {
    fail(`invalid ${label}`);
  }
}
function uint(value, label) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) >= 2n ** 256n)
    fail(`invalid ${label}`);
  return value;
}
function normalizeCreation(creation, index, contracts) {
  const constructor = creation.constructor;
  if (!exact(constructor, ["signature", "args"]) || !Array.isArray(constructor.args))
    fail("invalid creation constructor");
  const signatures = [
    "wrapper(address)",
    "pool(address,uint256,uint256)",
    "adapter(address,address,address,address,(address,address,address,address,uint256))",
  ];
  if (constructor.signature !== signatures[index] || constructor.args.length !== [1, 3, 5][index])
    fail("invalid creation constructor");
  const args = normalizeConstructorArgs(constructor.args, index, contracts);
  return Object.freeze({
    role: creation.role,
    sourceId: creation.sourceId,
    artifactProvenance: Object.freeze({ ...creation.artifactProvenance }),
    compilerBuildHash: creation.compilerBuildHash.toLowerCase(),
    creationBytecodeHash: creation.creationBytecodeHash.toLowerCase(),
    inputDigest: creation.inputDigest.toLowerCase(),
    constructor: Object.freeze({ signature: constructor.signature, args }),
  });
}
function normalizeConstructorArgs(args, index, contracts) {
  if (index === 0) {
    if (normalizedAddress(args[0], "wrapper underlying") !== contracts.underlying)
      fail("wrong wrapper underlying");
    return Object.freeze([contracts.underlying]);
  }
  if (index === 1) {
    if (normalizedAddress(args[0], "pool wrapper") !== contracts.wrapper)
      fail("wrong pool wrapper");
    return Object.freeze([
      contracts.wrapper,
      uint(args[1], "pool interval"),
      uint(args[2], "pool interval"),
    ]);
  }
  if (
    normalizedAddress(args[0], "adapter underlying") !== contracts.underlying ||
    normalizedAddress(args[1], "adapter wrapper") !== contracts.wrapper ||
    normalizedAddress(args[2], "adapter pool") !== contracts.candidatePool
  )
    fail("wrong adapter role");
  const market = args[4];
  if (!exact(market, ["loanToken", "collateralToken", "oracle", "irm", "lltv"]))
    fail("invalid market parameters");
  if (normalizedAddress(market.loanToken, "market loan token") !== contracts.underlying)
    fail("wrong market loan token");
  return Object.freeze([
    contracts.underlying,
    contracts.wrapper,
    contracts.candidatePool,
    normalizedAddress(args[3], "Morpho address"),
    Object.freeze({
      loanToken: contracts.underlying,
      collateralToken: normalizedAddress(market.collateralToken, "market collateral token"),
      oracle: normalizedAddress(market.oracle, "market oracle"),
      irm: normalizedAddress(market.irm, "market irm"),
      lltv: uint(market.lltv, "market lltv"),
    }),
  ]);
}
