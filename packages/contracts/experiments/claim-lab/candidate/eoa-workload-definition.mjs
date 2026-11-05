import { createHash } from "node:crypto";
import { getAddress } from "ethers";

import { validateStaticRunDefinition } from "./static-run-definition.mjs";

const PHASES = Object.freeze(["bootstrap", "deploy", "deposit", "draw", "exit", "final"]);
const SAFE_ACTIONS = Object.freeze([
  "safe-initial-deposit",
  "safe-initial-admission",
  "safe-check-a",
  "safe-wallet-claim",
  "safe-exit-membership",
  "safe-rejoin-deposit",
  "safe-rejoin-slot-1",
  "safe-delayed-check-b",
  "safe-reinvest",
  "safe-stage-8-check",
  "safe-stage-33-check",
  "safe-withdrawal-request",
  "safe-conditional-credited-claim",
]);
const fail = (message) => {
  throw new Error(`candidate workload definition: ${message}`);
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
const action = (id, phase, actorRole, targetRole, dependencies = [], allocationId = null) =>
  Object.freeze({
    id,
    phase,
    actorRole,
    kind: actorRole === "safeParticipant" ? "safe-barrier" : "eoa",
    targetRole,
    dependencies: Object.freeze([...dependencies]),
    allocationId,
  });
const digest = (value) => `0x${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

export function compileCandidateWorkload(definition, manifest) {
  const staticDefinition = validateStaticRunDefinition(definition);
  const normalizedManifest = validateManifest(staticDefinition, manifest);
  const actions = [];
  const add = (...args) => actions.push(action(...args));
  add("bootstrap-eth", "bootstrap", "bootstrapOperator", "sponsor", [], "bootstrap-eth");
  add(
    "bootstrap-usdc",
    "bootstrap",
    "bootstrapOperator",
    "sponsor",
    ["bootstrap-eth"],
    "bootstrap-usdc",
  );
  addDeployments(add);
  add("configure-morpho", "deploy", "sponsor", "candidatePool", ["deploy-2"]);
  for (let index = 0; index < 32; index += 1)
    add(
      `fund-eth-eoa${String(index).padStart(2, "0")}`,
      "bootstrap",
      "sponsor",
      "participant",
      ["configure-morpho"],
      `eth-eoa${String(index).padStart(2, "0")}`,
    );
  for (let index = 0; index < 33; index += 1)
    add(
      `fund-usdc-${index === 32 ? "safe" : `eoa${String(index).padStart(2, "0")}`}`,
      "bootstrap",
      "sponsor",
      "participant",
      ["configure-morpho"],
      `principal-${index}`,
    );
  for (const id of SAFE_ACTIONS.slice(0, 4))
    add(
      id,
      "draw",
      "safeParticipant",
      "candidatePool",
      id === "safe-exit-membership" ? ["safe-wallet-claim"] : [],
    );
  for (let index = 0; index < 7; index += 1)
    add(
      `morpho-initial-${index}`,
      "exit",
      "sponsor",
      index === 0 ? "wrapper" : "adapter",
      index === 0 ? [] : [`morpho-initial-${index - 1}`],
    );
  add("safe-exit-membership", "draw", "safeParticipant", "candidatePool", [
    "safe-wallet-claim",
    "morpho-initial-6",
  ]);
  add("approve-deposit-eoa00", "deposit", "participant", "wrapper", ["fund-usdc-eoa00"]);
  add(
    "eoa00-reuse-slot-0",
    "deposit",
    "participant",
    "candidatePool",
    ["approve-deposit-eoa00"],
    "principal-eoa00",
  );
  for (const id of SAFE_ACTIONS.slice(5, 9))
    add(
      id,
      "draw",
      "safeParticipant",
      "candidatePool",
      id === "safe-rejoin-slot-1" ? ["eoa00-reuse-slot-0"] : [],
    );
  addEoaDeposits(add, 1, 7);
  add("safe-stage-8-check", "draw", "safeParticipant", "candidatePool");
  addEoaDeposits(add, 7, 32);
  for (const id of SAFE_ACTIONS.slice(10))
    add(id, id.includes("withdrawal") ? "final" : "draw", "safeParticipant", "candidatePool");
  for (let index = 0; index < 39; index += 1)
    add(
      `check-eoa${String(index % 32).padStart(2, "0")}-${index}`,
      "draw",
      "participant",
      "candidatePool",
    );
  for (let index = 0; index < 39; index += 1)
    add(
      `claim-eoa${String(index % 32).padStart(2, "0")}-${index}`,
      "draw",
      "participant",
      "candidatePool",
    );
  for (let index = 0; index < 32; index += 1)
    add(
      `final-withdraw-eoa${String(index).padStart(2, "0")}`,
      "final",
      "participant",
      "candidatePool",
    );
  add("final-close-batch", "final", "sponsor", "candidatePool");
  add("final-settle-batch", "final", "sponsor", "candidatePool", ["final-close-batch"]);
  for (let index = 0; index < 33; index += 1)
    add(`final-process-${index}`, "final", "sponsor", "candidatePool", ["final-settle-batch"]);
  for (let index = 0; index < 33; index += 1)
    add(`final-finalize-${index}`, "final", "participant", "wrapper", [`final-process-${index}`]);
  while (actions.filter((entry) => entry.kind === "eoa").length < 362)
    add(`draw-reserve-or-claim-${actions.length}`, "draw", "sponsor", "candidatePool");
  validateActions(actions);
  const template = Object.freeze({
    version: 1,
    phaseIds: PHASES,
    definition: normalizedDefinition(staticDefinition, normalizedManifest),
    actions,
  });
  return Object.freeze({
    ...template,
    counts: Object.freeze({ eoa: 362, safe: 13 }),
    totals: Object.freeze({ usdcMicro: "78000000", grossFundingWei: "1640000000000000" }),
    fingerprint: digest(template),
  });
}

export function workloadFingerprint(workload) {
  return digest({
    version: workload.version,
    phaseIds: workload.phaseIds,
    definition: workload.definition,
    actions: workload.actions,
  });
}

function addDeployments(add) {
  for (let index = 0; index < 3; index += 1)
    add(
      `deploy-${index}`,
      "deploy",
      "sponsor",
      "creation",
      [index ? `deploy-${index - 1}` : "bootstrap-usdc"],
      `creation-${index}`,
    );
}
function normalizedDefinition(definition, manifest) {
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
function validateManifest(definition, manifest) {
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
function validateActions(actions) {
  if (
    actions.length !== 375 ||
    new Set(actions.map((entry) => entry.id)).size !== 375 ||
    actions.filter((entry) => entry.kind === "safe-barrier").length !== 13
  )
    fail("invalid finite action graph");
  const seen = new Set();
  for (const entry of actions) {
    if (entry.dependencies.some((dependency) => !seen.has(dependency)))
      fail("cyclic or forward dependency");
    seen.add(entry.id);
  }
}
function addEoaDeposits(add, start, end) {
  for (let index = start; index < end; index += 1) {
    const id = String(index).padStart(2, "0");
    add(`approve-deposit-eoa${id}`, "deposit", "participant", "wrapper", [`fund-usdc-eoa${id}`]);
    add(
      `admit-eoa${id}${index === 6 ? "-stage-8" : ""}`,
      "deposit",
      "participant",
      "candidatePool",
      [`approve-deposit-eoa${id}`],
      `principal-eoa${id}`,
    );
  }
}
