import { createHash } from "node:crypto";
import { getAddress } from "ethers";

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

export function compileCandidateWorkload(definition) {
  validateDefinition(definition);
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
  for (let index = 0; index < 3; index += 1)
    add(
      `deploy-${index}`,
      "deploy",
      "sponsor",
      "creation",
      [index ? `deploy-${index - 1}` : "bootstrap-usdc"],
      `creation-${index}`,
    );
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
    definition: normalizedDefinition(definition),
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

function validateDefinition(definition) {
  if (
    !definition?.actors ||
    !definition?.contracts ||
    definition.actors.eoaParticipants?.length !== 32 ||
    definition.workloadIds?.length > 32
  )
    fail("invalid static definition");
  for (const value of [
    ...definition.actors.eoaParticipants,
    definition.actors.safeParticipant,
    definition.actors.sponsor,
    definition.actors.bootstrapOperator,
    ...Object.values(definition.contracts),
    ...definition.allowedEoaTargets,
  ])
    getAddress(value);
  for (const key of ["creationInputDigests", "deploymentCreationHashes"])
    if (
      !Array.isArray(definition[key]) ||
      definition[key].some((value) => !/^0x[0-9a-fA-F]{64}$/.test(value))
    )
      fail(`invalid ${key}`);
}
function normalizedDefinition(definition) {
  return Object.freeze({
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
    phaseIds: Object.freeze([...definition.workloadIds]),
  });
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
