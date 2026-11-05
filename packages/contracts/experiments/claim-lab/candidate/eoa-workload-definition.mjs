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
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (plain(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
};
const digest = (value) =>
  `0x${createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")}`;

export function compileCandidateWorkload(definition, manifest) {
  const staticDefinition = validateStaticRunDefinition(definition);
  const normalizedManifest = validateManifest(staticDefinition, manifest);
  const actions = buildActions(staticDefinition, normalizedManifest);
  validateActions(actions);
  const template = Object.freeze({
    version: 1,
    phaseIds: PHASES,
    definition: normalizedDefinition(staticDefinition, normalizedManifest),
    actions,
  });
  return Object.freeze({
    ...template,
    counts: actionCounts(actions),
    totals: actionTotals(actions),
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

function buildActions(definition, manifest) {
  const actions = [];
  const principal = (index) => (index === 0 ? "3000000" : index === 1 ? "1000000" : "2000000");
  const participant = (index) => definition.actors.eoaParticipants[index];
  const add = (id, phase, actorRole, targetRole, operation, dependencies = [], extra = {}) => {
    const actor =
      actorRole === "participant" ? participant(extra.actorIndex) : definition.actors[actorRole];
    const target = targetRole === "creation" ? null : definition.contracts[targetRole] || actor;
    actions.push(
      Object.freeze({
        id,
        phase,
        kind: actorRole === "safeParticipant" ? "externalSafe" : "eoa",
        status: actorRole === "safeParticipant" ? "PENDING" : "planned",
        actorRole,
        actor,
        actorIndex: actorRole === "participant" ? extra.actorIndex : null,
        targetRole,
        target,
        operation: Object.freeze(operation),
        dependencies: Object.freeze([...dependencies]),
        concurrencyGroup: extra.concurrencyGroup || "serial",
        allocation: Object.freeze(extra.allocation || { id: null, usdcMicro: "0", valueWei: "0" }),
        refs: Object.freeze(extra.refs || {}),
        provenance: Object.freeze(extra.provenance || null),
      }),
    );
  };
  const call = (signature, args) => ({ signature, args: Object.freeze(args) });
  const transfer = (recipient, amount) => call("transfer(address,uint256)", [recipient, amount]);
  add(
    "bootstrap-eth",
    "setup",
    "bootstrapOperator",
    "sponsor",
    call("transfer(address,uint256)", [definition.actors.sponsor, "1000000000000000"]),
    [],
    { allocation: { id: "bootstrap-eth", usdcMicro: "0", valueWei: "1000000000000000" } },
  );
  add(
    "bootstrap-usdc",
    "setup",
    "bootstrapOperator",
    "underlying",
    transfer(definition.actors.sponsor, "78000000"),
    ["bootstrap-eth"],
    { allocation: { id: "bootstrap-usdc-78", usdcMicro: "78000000", valueWei: "0" } },
  );
  ["wrapper", "pool", "adapter"].forEach((role, index) =>
    add(
      `deploy-${role}`,
      "setup",
      "sponsor",
      "creation",
      call(
        manifest.creations[index].constructor.signature,
        manifest.creations[index].constructor.args,
      ),
      [index ? `deploy-${["wrapper", "pool", "adapter"][index - 1]}` : "bootstrap-usdc"],
      {
        provenance: manifest.creations[index],
        refs: { expectedAddress: definition.contracts[role === "pool" ? "candidatePool" : role] },
      },
    ),
  );
  add(
    "configure-morpho",
    "setup",
    "sponsor",
    "candidatePool",
    call("setMorphoYieldAdapter(address,uint256)", [definition.contracts.adapter, "1"]),
    ["deploy-adapter"],
  );
  for (let index = 0; index < 32; index += 1)
    add(
      `fund-eth-eoa-${String(index).padStart(2, "0")}`,
      "setup",
      "sponsor",
      "participant",
      call("transfer(address,uint256)", [participant(index), "20000000000000"]),
      ["configure-morpho"],
      {
        actorIndex: index,
        allocation: { id: `eth-eoa-${index}`, usdcMicro: "0", valueWei: "20000000000000" },
      },
    );
  for (let index = 0; index < 32; index += 1)
    add(
      `fund-usdc-eoa-${String(index).padStart(2, "0")}`,
      "setup",
      "sponsor",
      "underlying",
      transfer(participant(index), principal(index)),
      [`fund-eth-eoa-${String(index).padStart(2, "0")}`],
      {
        allocation: { id: "bootstrap-usdc-78", usdcMicro: "0", valueWei: "0" },
        refs: { recipient: participant(index), principal: principal(index) },
      },
    );
  add(
    "fund-usdc-safe",
    "setup",
    "sponsor",
    "underlying",
    transfer(definition.actors.safeParticipant, "2000000"),
    ["fund-usdc-eoa-31"],
    { allocation: { id: "bootstrap-usdc-78", usdcMicro: "0", valueWei: "0" } },
  );
  addSafeInitial(add, call, definition);
  add(
    "prize-fund-A",
    "draw",
    "sponsor",
    "wrapper",
    call("confidentialTransferAndCall(address,bytes32,bytes,bytes)", [
      definition.contracts.candidatePool,
      { ref: "enc-reserve-A" },
      { ref: "proof-reserve-A" },
      "PRIZE_FUNDING_DATA:5000000",
    ]),
    ["safe-initial-admission"],
    { allocation: { id: "prize-A", usdcMicro: "0", valueWei: "0" } },
  );
  add("close-draw-A", "draw", "sponsor", "candidatePool", call("closeDraw()", []), [
    "prize-fund-A",
  ]);
  add(
    "safe-check-a",
    "draw",
    "safeParticipant",
    "candidatePool",
    checkTemplate("close-draw-A", definition.actors.safeParticipant),
    ["close-draw-A"],
  );
  add("safe-wallet-claim", "draw", "safeParticipant", "candidatePool", call("claimPrize()", []), [
    "safe-check-a",
  ]);
  add(
    "prize-fund-B",
    "draw",
    "sponsor",
    "wrapper",
    call("confidentialTransferAndCall(address,bytes32,bytes,bytes)", [
      definition.contracts.candidatePool,
      { ref: "enc-reserve-B" },
      { ref: "proof-reserve-B" },
      "PRIZE_FUNDING_DATA:5000000",
    ]),
    ["safe-wallet-claim"],
  );
  add("close-draw-B", "draw", "sponsor", "candidatePool", call("closeDraw()", []), [
    "prize-fund-B",
  ]);
  [
    "requestMorphoPrincipalUnwrap()",
    "finalizeUnwrap(bytes32,uint64,bytes)",
    "supplyAvailableMorphoPrincipal()",
  ].forEach((signature, index) =>
    add(
      ["morpho-request-initial", "morpho-finalize-initial", "morpho-supply-initial"][index],
      "queue",
      "sponsor",
      index === 1 ? "wrapper" : "candidatePool",
      call(
        signature,
        index === 1
          ? [{ ref: "morpho-request-initial.requestId" }, { ref: "decrypt" }, { ref: "proof" }]
          : [],
      ),
      [index ? ["morpho-request-initial", "morpho-finalize-initial"][index - 1] : "close-draw-B"],
    ),
  );
  add(
    "safe-exit-membership",
    "queue",
    "safeParticipant",
    "candidatePool",
    call("exitMembership()", []),
    ["morpho-supply-initial", "close-draw-B"],
  );
  [
    "initial-batch-close",
    "initial-batch-settle",
    "initial-batch-process-safe",
    "initial-batch-finalize-safe",
  ].forEach((id, index) =>
    add(
      id,
      "queue",
      "sponsor",
      index === 3 ? "wrapper" : "candidatePool",
      call(
        [
          "closeWithdrawalBatch(uint256)",
          "settleWithdrawalBatch(uint256,uint64,uint64,bytes)",
          "processWithdrawal(uint256,address)",
          "finalizeUnwrap(bytes32,uint64,bytes)",
        ][index],
        [{ ref: "initial-batch" }],
      ),
      [
        index
          ? [
              "safe-exit-membership",
              "initial-batch-close",
              "initial-batch-settle",
              "initial-batch-process-safe",
            ][index - 1]
          : "safe-exit-membership",
      ],
    ),
  );
  for (let index = 0; index < 32; index += 1)
    addParticipantDeposit(
      add,
      call,
      definition,
      index,
      principal(index),
      index === 0
        ? ["initial-batch-finalize-safe", "safe-exit-membership"]
        : index < 7
          ? ["safe-rejoin-admission"]
          : ["close-draw-8"],
      index === 0 ? "slot-0" : index < 7 ? "stage-8" : "stage-33",
    );
  add(
    "safe-rejoin-deposit",
    "deposit",
    "safeParticipant",
    "wrapper",
    call("multicall(bytes[])", [{ ref: "safe-rejoin-wrap-and-deposit" }]),
    ["eoa-00-admit", "initial-batch-finalize-safe"],
  );
  add(
    "safe-rejoin-admission",
    "deposit",
    "safeParticipant",
    "candidatePool",
    call("finalizeAdmission(address,uint256,bool,bytes)", [
      definition.actors.safeParticipant,
      { ref: "nonce" },
      true,
      { ref: "proof" },
    ]),
    ["safe-rejoin-deposit"],
  );
  add(
    "safe-delayed-check-b",
    "draw",
    "safeParticipant",
    "candidatePool",
    checkTemplate("close-draw-B", definition.actors.safeParticipant),
    ["safe-rejoin-admission"],
  );
  add(
    "safe-reinvest",
    "draw",
    "safeParticipant",
    "candidatePool",
    call("claimPrizeToSavings()", []),
    ["safe-delayed-check-b"],
  );
  addReserveStages(add, call, definition);
  addFinal(add, call, definition);
  return Object.freeze(actions);
}
function checkTemplate(draw, actor) {
  return {
    signature: "checkPrize(uint256,address,uint256,uint64,bytes32,bytes32[],bytes32[],bytes32[])",
    args: Object.freeze([
      { ref: `${draw}.drawId` },
      actor,
      { ref: "slot.index" },
      { ref: "slot.generation" },
      { ref: "balance.handle" },
      { ref: `proof32:${draw}:hashes` },
      { ref: `proof32:${draw}:sums` },
      { ref: `proof32:${draw}:parents` },
    ]),
  };
}
function addSafeInitial(add, call, definition) {
  add(
    "safe-initial-deposit",
    "deposit",
    "safeParticipant",
    "wrapper",
    call("multicall(bytes[])", [{ ref: "safe-initial-wrap-and-deposit" }]),
    ["fund-usdc-safe"],
  );
  add(
    "safe-initial-admission",
    "deposit",
    "safeParticipant",
    "candidatePool",
    call("finalizeAdmission(address,uint256,bool,bytes)", [
      definition.actors.safeParticipant,
      { ref: "nonce" },
      true,
      { ref: "proof" },
    ]),
    ["safe-initial-deposit"],
  );
}
function addParticipantDeposit(add, call, definition, index, amount, dependencies, group) {
  const id = String(index).padStart(2, "0");
  const actor = definition.actors.eoaParticipants[index];
  add(
    `eoa-${id}-approve`,
    "deposit",
    "participant",
    "underlying",
    call("approve(address,uint256)", [definition.contracts.wrapper, amount]),
    [`fund-usdc-eoa-${id}`, ...dependencies],
    { actorIndex: index, concurrencyGroup: group },
  );
  add(
    `eoa-${id}-deposit`,
    "deposit",
    "participant",
    "wrapper",
    call("multicall(bytes[])", [{ ref: `wrap-and-deposit:${id}:${amount}` }]),
    [`eoa-${id}-approve`],
    {
      actorIndex: index,
      concurrencyGroup: group,
      refs: { encryptedInput: { producer: `eoa-${id}-deposit`, type: "externalEuint64" } },
    },
  );
  add(
    `eoa-${id}-admit`,
    "deposit",
    "participant",
    "candidatePool",
    call("finalizeAdmission(address,uint256,bool,bytes)", [
      actor,
      { ref: `eoa-${id}-deposit.nonce` },
      true,
      { ref: `eoa-${id}-deposit.publicProof` },
    ]),
    [`eoa-${id}-deposit`],
    { actorIndex: index, concurrencyGroup: group },
  );
}
function addReserveStages(add, call, definition) {
  add(
    "reserve-approve",
    "draw",
    "sponsor",
    "underlying",
    call("approve(address,uint256)", [definition.contracts.wrapper, "12000000"]),
    ["safe-reinvest"],
  );
  add(
    "reserve-wrap",
    "draw",
    "sponsor",
    "wrapper",
    call("wrap(address,uint256)", [definition.actors.sponsor, "12000000"]),
    ["reserve-approve"],
  );
  for (const [stage, amount, before] of [
    ["8", "1000000", "eoa-06-admit"],
    ["33", "1000000", "eoa-31-admit"],
  ]) {
    add(
      `prize-fund-${stage}`,
      "draw",
      "sponsor",
      "wrapper",
      call("confidentialTransferAndCall(address,bytes32,bytes,bytes)", [
        definition.contracts.candidatePool,
        { ref: `enc-${stage}` },
        { ref: `proof-${stage}` },
        `PRIZE_FUNDING_DATA:${amount}`,
      ]),
      ["reserve-wrap", before],
    );
    add(`close-draw-${stage}`, "draw", "sponsor", "candidatePool", call("closeDraw()", []), [
      `prize-fund-${stage}`,
    ]);
  }
  for (let index = 0; index < 7; index += 1) {
    const id = String(index).padStart(2, "0");
    add(
      `check-stage8-eoa-${id}`,
      "draw",
      "participant",
      "candidatePool",
      checkTemplate("close-draw-8", definition.actors.eoaParticipants[index]),
      ["close-draw-8"],
      {
        actorIndex: index,
        concurrencyGroup: index === 0 ? "stage8-1" : index < 5 ? "stage8-4" : "stage8-2",
      },
    );
    add(
      `claim-stage8-eoa-${id}`,
      "draw",
      "participant",
      "candidatePool",
      call("claimPrize()", []),
      [`check-stage8-eoa-${id}`],
      {
        actorIndex: index,
        concurrencyGroup: "conditional",
        refs: { condition: "positive-credit-or-SKIPPED" },
      },
    );
  }
  add(
    "safe-stage-8-check",
    "draw",
    "safeParticipant",
    "candidatePool",
    checkTemplate("close-draw-8", definition.actors.safeParticipant),
    ["close-draw-8"],
  );
  for (let index = 0; index < 32; index += 1) {
    const id = String(index).padStart(2, "0");
    add(
      `check-stage33-eoa-${id}`,
      "draw",
      "participant",
      "candidatePool",
      checkTemplate("close-draw-33", definition.actors.eoaParticipants[index]),
      ["close-draw-33"],
      { actorIndex: index, concurrencyGroup: `stage33-${Math.floor(index / 8)}` },
    );
    add(
      `claim-stage33-eoa-${id}`,
      "draw",
      "participant",
      "candidatePool",
      call("claimPrize()", []),
      [`check-stage33-eoa-${id}`],
      {
        actorIndex: index,
        concurrencyGroup: "conditional",
        refs: { condition: "positive-credit-or-SKIPPED" },
      },
    );
  }
  add(
    "safe-stage-33-check",
    "draw",
    "safeParticipant",
    "candidatePool",
    checkTemplate("close-draw-33", definition.actors.safeParticipant),
    ["close-draw-33"],
  );
  add(
    "safe-conditional-wallet-claim",
    "draw",
    "safeParticipant",
    "candidatePool",
    call("claimPrize()", []),
    ["safe-stage-8-check", "safe-stage-33-check"],
    { refs: { condition: "positive-credit-or-SKIPPED" } },
  );
}
function addFinal(add, call, definition) {
  for (let index = 0; index < 32; index += 1) {
    const id = String(index).padStart(2, "0");
    add(
      `final-request-eoa-${id}`,
      "final",
      "participant",
      "candidatePool",
      call("requestWithdrawal(bytes32,bytes)", [
        { ref: `enc-full-principal-${id}` },
        { ref: `proof-full-principal-${id}` },
      ]),
      [`claim-stage33-eoa-${id}`],
      { actorIndex: index, concurrencyGroup: "final-requests" },
    );
  }
  add(
    "safe-withdrawal-request",
    "final",
    "safeParticipant",
    "candidatePool",
    call("requestWithdrawal(bytes32,bytes)", [
      { ref: "enc-safe-principal" },
      { ref: "proof-safe-principal" },
    ]),
    ["safe-conditional-wallet-claim"],
  );
  add(
    "final-batch-close",
    "final",
    "sponsor",
    "candidatePool",
    call("closeWithdrawalBatch(uint256)", [{ ref: "final-batch" }]),
    [
      "safe-withdrawal-request",
      ...Array.from(
        { length: 32 },
        (_, index) => `final-request-eoa-${String(index).padStart(2, "0")}`,
      ),
    ],
  );
  add(
    "final-batch-settle",
    "final",
    "sponsor",
    "candidatePool",
    call("settleWithdrawalBatch(uint256,uint64,uint64,bytes)", [
      { ref: "final-batch" },
      { ref: "clear-total" },
      { ref: "clear-morpho" },
      { ref: "proof" },
    ]),
    ["final-batch-close"],
  );
  for (let index = 0; index < 33; index += 1) {
    const account =
      index === 32 ? definition.actors.safeParticipant : definition.actors.eoaParticipants[index];
    const id = index === 32 ? "safe" : `eoa-${String(index).padStart(2, "0")}`;
    add(
      `final-process-${id}`,
      "final",
      "sponsor",
      "candidatePool",
      call("processWithdrawal(uint256,address)", [{ ref: "final-batch" }, account]),
      ["final-batch-settle"],
      { concurrencyGroup: "final-process" },
    );
    add(
      `final-finalize-${id}`,
      "final",
      "sponsor",
      "wrapper",
      call("finalizeUnwrap(bytes32,uint64,bytes)", [
        { ref: `final-process-${id}.requestId` },
        { ref: `decrypt-${id}` },
        { ref: `proof-${id}` },
      ]),
      [`final-process-${id}`],
      { concurrencyGroup: "final-finalize" },
    );
  }
}
function actionCounts(actions) {
  return Object.freeze({
    eoa: actions.filter((action) => action.kind === "eoa").length,
    safe: actions.filter((action) => action.kind === "externalSafe").length,
  });
}
function actionTotals(actions) {
  return Object.freeze({
    usdcMicro: actions
      .reduce((total, action) => total + BigInt(action.allocation.usdcMicro), 0n)
      .toString(),
    grossFundingWei: actions
      .reduce((total, action) => total + BigInt(action.allocation.valueWei), 0n)
      .toString(),
  });
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
    actions.filter((entry) => entry.kind === "externalSafe").length !== 13
  )
    fail("invalid finite action graph");
  const byId = new Map(actions.map((entry) => [entry.id, entry]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) fail("cyclic dependency");
    if (visited.has(id)) return;
    const entry = byId.get(id);
    if (!entry) fail("unknown dependency producer");
    visiting.add(id);
    entry.dependencies.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  actions.forEach((entry) => visit(entry.id));
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
