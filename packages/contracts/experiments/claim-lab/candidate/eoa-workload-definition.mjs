import { createHash } from "node:crypto";
import { getAddress } from "ethers";

import { validateStaticRunDefinition } from "./static-run-definition.mjs";
import { canonical } from "./journal-values.mjs";

const PHASES = Object.freeze(["setup", "deposit", "draw", "queue", "final"]);
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
const digest = (value) => `0x${createHash("sha256").update(canonical(value)).digest("hex")}`;

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
  return deepFreeze({
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

/** Reject a caller-supplied graph unless it is the exact graph derived from its
 * closed StaticA definition and creation manifest.  This is deliberately not a
 * general graph validator: C must never bless substituted instructions by
 * merely recomputing a hash. */
export function validateCompiledCandidateWorkload(workload) {
  if (!plain(workload) || !plain(workload.definition) || !plain(workload.definition.manifest))
    fail("invalid compiled workload");
  const { manifest, policy, ...definition } = workload.definition;
  const expected = compileCandidateWorkload({ version: 1, ...definition }, manifest);
  if (canonical(workload) !== canonical(expected))
    fail("compiled workload differs from definition");
  return expected;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach((entry) => deepFreeze(entry, seen));
  return Object.freeze(value);
}

function buildActions(definition, manifest) {
  const actions = [];
  const principal = (index) => (index === 0 ? "3000000" : index === 1 ? "1000000" : "2000000");
  const participant = (index) => definition.actors.eoaParticipants[index];
  const add = (id, phase, actorRole, targetRole, operation, dependencies = [], extra = {}) => {
    const actor =
      actorRole === "participant" ? participant(extra.actorIndex) : definition.actors[actorRole];
    const target = resolveTarget(definition, targetRole, extra.actorIndex);
    actions.push(
      deepFreeze({
        id,
        phase,
        kind: actorRole === "safeParticipant" ? "externalSafe" : "eoa",
        status: actorRole === "safeParticipant" ? "PENDING" : "planned",
        actorRole,
        actor,
        actorIndex: actorRole === "participant" ? extra.actorIndex : null,
        targetRole,
        target,
        operation,
        dependencies: [...dependencies],
        concurrencyGroup: extra.concurrencyGroup || "serial",
        allocation: extra.allocation || { id: null, usdcMicro: "0", valueWei: "0" },
        refs: extra.refs || {},
        provenance: extra.provenance || null,
      }),
    );
  };
  const call = (signature, args, value = "0") => ({ signature, args, value });
  const transfer = (recipient, amount) => call("transfer(address,uint256)", [recipient, amount]);
  add(
    "bootstrap-eth",
    "setup",
    "bootstrapOperator",
    "sponsor",
    call("nativeTransfer()", [], "1000000000000000"),
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
        allocation: {
          id: "bootstrap-eth",
          usdcMicro: "0",
          valueWei: "20000000000000",
          provenance: "bootstrap-eth",
        },
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
        allocation: {
          id: "bootstrap-usdc-78",
          usdcMicro: "0",
          valueWei: "0",
          provenance: "bootstrap-usdc-78/principal",
        },
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
    {
      allocation: {
        id: "bootstrap-usdc-78",
        usdcMicro: "0",
        valueWei: "0",
        provenance: "bootstrap-usdc-78/safe",
      },
    },
  );
  addSafeInitial(add, call, definition);
  add(
    "prize-fund-A",
    "draw",
    "sponsor",
    "wrapper",
    call("confidentialTransferAndCall(address,bytes32,bytes,bytes)", [
      definition.contracts.candidatePool,
      sdkRef("prize-fund-A", "wrapper", definition.actors.sponsor, "5000000", "prize"),
      sdkProofRef("prize-fund-A"),
      prizeFundingData("5000000"),
    ]),
    ["safe-initial-admission", "reserve-wrap"],
    prizeAllocation("A", "5000000"),
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
      sdkRef("prize-fund-B", "wrapper", definition.actors.sponsor, "5000000", "prize"),
      sdkProofRef("prize-fund-B"),
      prizeFundingData("5000000"),
    ]),
    ["safe-wallet-claim", "reserve-wrap"],
    prizeAllocation("B", "5000000"),
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
          ? [
              resultRef("morpho-request-initial", "unwrapRequestId", "bytes32"),
              discoveryRef(
                "morpho-request-initial",
                definition.actors.safeParticipant,
                "clearAmount",
                "uint64",
              ),
              discoveryRef(
                "morpho-request-initial",
                definition.actors.safeParticipant,
                "proof",
                "bytes",
              ),
            ]
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
        initialQueueArgs(index, definition),
      ),
      [
        [
          "safe-exit-membership",
          "initial-batch-close",
          "initial-batch-settle",
          "initial-batch-process-safe",
        ][index],
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
          : [
              "close-draw-8",
              "safe-stage-8-check",
              ...Array.from(
                { length: 7 },
                (_, member) => `check-stage8-eoa-${String(member).padStart(2, "0")}`,
              ),
            ],
      index === 0 ? "slot-0" : index < 7 ? "stage-8" : "stage-33",
    );
  add(
    "safe-rejoin-deposit",
    "deposit",
    "safeParticipant",
    "wrapper",
    safeDepositTemplate(definition, "safe-rejoin-deposit", "2000000"),
    ["eoa-00-admit", "initial-batch-finalize-safe"],
  );
  add(
    "safe-rejoin-admission",
    "deposit",
    "safeParticipant",
    "candidatePool",
    call("finalizeAdmission(address,uint256,bool,bytes)", [
      definition.actors.safeParticipant,
      resultRef("safe-rejoin-deposit", "admissionNonce", "uint256"),
      true,
      resultRef("safe-rejoin-deposit", "publicProof", "bytes"),
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
function resolveTarget(definition, role, participantIndex) {
  if (role === "creation") return null;
  if (role === "participant") {
    if (!Number.isInteger(participantIndex) || participantIndex < 0 || participantIndex > 31)
      fail("invalid participant target");
    return definition.actors.eoaParticipants[participantIndex];
  }
  if (role === "sponsor") return definition.actors.sponsor;
  if (!Object.hasOwn(definition.contracts, role)) fail("unknown target role");
  return definition.contracts[role];
}
function resultRef(producer, field, abiType) {
  return { kind: "result", producer, field, abiType, constraints: ["producer-complete"] };
}
function discoveryRef(producer, beneficiary, field, abiType) {
  return {
    kind: "discovery",
    producer,
    beneficiary,
    field,
    abiType,
    constraints: ["immutable-read"],
  };
}
function proofRef(draw, beneficiary, field) {
  return {
    kind: "historicalProof",
    producer: draw,
    beneficiary,
    field,
    abiType: "bytes32[]",
    constraints: ["depth-32", "immutable-draw"],
  };
}
function sdkRef(producer, contractRole, actor, amount, purpose) {
  return {
    kind: "sdkInput",
    producer,
    contractRole,
    actor,
    amount,
    purpose,
    abiType: "bytes32",
    constraints: ["checksummed-contract", "checksummed-actor", "uint64"],
  };
}
function sdkProofRef(producer) {
  return {
    kind: "sdkProof",
    producer,
    field: "inputProof",
    abiType: "bytes",
    constraints: ["same-sdk-input"],
  };
}
function prizeFundingData(amount) {
  return {
    kind: "abiBytes",
    tag: "0x5052495a455f46554e44494e475f44415441",
    encoded: { abiType: "uint64", value: amount },
  };
}
function prizeAllocation(stage, amount) {
  return {
    id: "bootstrap-usdc-78",
    usdcMicro: "0",
    valueWei: "0",
    provenance: `bootstrap-usdc-78/prize-${stage}`,
    suballocationMicro: amount,
  };
}
function depositTemplate(definition, producer, actor, amount) {
  return {
    signature: "multicall(bytes[])",
    args: [
      [
        { signature: "wrap(address,uint256)", args: [actor, amount] },
        {
          signature: "confidentialTransferAndCall(address,bytes32,bytes,bytes)",
          args: [
            definition.contracts.candidatePool,
            sdkRef(producer, "wrapper", actor, amount, "deposit"),
            sdkProofRef(producer),
            { kind: "delegateData", abiType: "bytes" },
          ],
        },
      ],
    ],
    value: "0",
  };
}
function safeDepositTemplate(definition, producer, amount) {
  const actor = definition.actors.safeParticipant;
  return {
    signature: "safeBatch(bytes[])",
    args: [
      [
        {
          target: definition.contracts.underlying,
          signature: "approve(address,uint256)",
          args: [definition.contracts.wrapper, amount],
        },
        {
          target: definition.contracts.wrapper,
          ...depositTemplate(definition, producer, actor, amount),
        },
      ],
    ],
    value: "0",
  };
}
function initialQueueArgs(index, definition) {
  const batch = resultRef("safe-exit-membership", "initialBatchId", "uint256");
  if (index === 0) return [batch];
  if (index === 1)
    return [
      batch,
      discoveryRef(
        "initial-batch-close",
        definition.actors.safeParticipant,
        "clearTotal",
        "uint64",
      ),
      discoveryRef(
        "initial-batch-close",
        definition.actors.safeParticipant,
        "clearMorphoRestore",
        "uint64",
      ),
      discoveryRef(
        "initial-batch-close",
        definition.actors.safeParticipant,
        "settlementProof",
        "bytes",
      ),
    ];
  if (index === 2) return [batch, definition.actors.safeParticipant];
  return [
    resultRef("initial-batch-process-safe", "unwrapRequestId", "bytes32"),
    discoveryRef(
      "initial-batch-process-safe",
      definition.actors.safeParticipant,
      "clearAmount",
      "uint64",
    ),
    discoveryRef("initial-batch-process-safe", definition.actors.safeParticipant, "proof", "bytes"),
  ];
}
function checkTemplate(draw, actor) {
  return {
    signature: "checkPrize(uint256,address,uint256,uint64,bytes32,bytes32[],bytes32[],bytes32[])",
    args: Object.freeze([
      resultRef(draw, "drawId", "uint256"),
      actor,
      discoveryRef(draw, actor, "slotIndex", "uint256"),
      discoveryRef(draw, actor, "slotGeneration", "uint64"),
      discoveryRef(draw, actor, "balanceHandle", "bytes32"),
      proofRef(draw, actor, "siblingHashes"),
      proofRef(draw, actor, "siblingSums"),
      proofRef(draw, actor, "parentSums"),
    ]),
  };
}
function addSafeInitial(add, call, definition) {
  add(
    "safe-initial-deposit",
    "deposit",
    "safeParticipant",
    "wrapper",
    safeDepositTemplate(definition, "safe-initial-deposit", "2000000"),
    ["fund-usdc-safe"],
  );
  add(
    "safe-initial-admission",
    "deposit",
    "safeParticipant",
    "candidatePool",
    call("finalizeAdmission(address,uint256,bool,bytes)", [
      definition.actors.safeParticipant,
      resultRef("safe-initial-deposit", "admissionNonce", "uint256"),
      true,
      resultRef("safe-initial-deposit", "publicProof", "bytes"),
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
    depositTemplate(definition, `eoa-${id}-deposit`, actor, amount),
    [`eoa-${id}-approve`],
    {
      actorIndex: index,
      concurrencyGroup: group,
      refs: { encryptedInput: sdkRef(`eoa-${id}-deposit`, "wrapper", actor, amount, "deposit") },
    },
  );
  add(
    `eoa-${id}-admit`,
    "deposit",
    "participant",
    "candidatePool",
    call("finalizeAdmission(address,uint256,bool,bytes)", [
      actor,
      resultRef(`eoa-${id}-deposit`, "admissionNonce", "uint256"),
      true,
      resultRef(`eoa-${id}-deposit`, "publicProof", "bytes"),
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
    ["safe-initial-admission"],
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
        sdkRef(`prize-fund-${stage}`, "wrapper", definition.actors.sponsor, amount, "prize"),
        sdkProofRef(`prize-fund-${stage}`),
        prizeFundingData(amount),
      ]),
      [
        "reserve-wrap",
        before,
        ...(stage === "8"
          ? ["safe-reinvest"]
          : [
              "safe-stage-8-check",
              ...Array.from(
                { length: 7 },
                (_, member) => `check-stage8-eoa-${String(member).padStart(2, "0")}`,
              ),
            ]),
      ],
      prizeAllocation(stage, amount),
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
      [
        "close-draw-8",
        ...(index >= 1 && index < 5 ? ["check-stage8-eoa-00"] : []),
        ...(index >= 5
          ? [
              "check-stage8-eoa-01",
              "check-stage8-eoa-02",
              "check-stage8-eoa-03",
              "check-stage8-eoa-04",
            ]
          : []),
      ],
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
      [
        "close-draw-33",
        ...Array.from(
          { length: Math.floor(index / 8) * 8 },
          (_, member) => `check-stage33-eoa-${String(member).padStart(2, "0")}`,
        ),
      ],
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
        sdkRef(
          `final-request-eoa-${id}`,
          "candidatePool",
          definition.actors.eoaParticipants[index],
          index === 0 ? "3000000" : index === 1 ? "1000000" : "2000000",
          "withdrawal",
        ),
        sdkProofRef(`final-request-eoa-${id}`),
      ]),
      [
        "safe-conditional-wallet-claim",
        ...Array.from(
          { length: 7 },
          (_, member) => `check-stage8-eoa-${String(member).padStart(2, "0")}`,
        ),
        ...Array.from(
          { length: 7 },
          (_, member) => `claim-stage8-eoa-${String(member).padStart(2, "0")}`,
        ),
        ...Array.from(
          { length: 32 },
          (_, member) => `check-stage33-eoa-${String(member).padStart(2, "0")}`,
        ),
        ...Array.from(
          { length: 32 },
          (_, member) => `claim-stage33-eoa-${String(member).padStart(2, "0")}`,
        ),
      ],
      { actorIndex: index, concurrencyGroup: "final-requests" },
    );
  }
  add(
    "safe-withdrawal-request",
    "final",
    "safeParticipant",
    "candidatePool",
    call("requestWithdrawal(bytes32,bytes)", [
      sdkRef(
        "safe-withdrawal-request",
        "candidatePool",
        definition.actors.safeParticipant,
        "2000000",
        "withdrawal",
      ),
      sdkProofRef("safe-withdrawal-request"),
    ]),
    [
      "safe-conditional-wallet-claim",
      ...Array.from(
        { length: 7 },
        (_, member) => `check-stage8-eoa-${String(member).padStart(2, "0")}`,
      ),
      ...Array.from(
        { length: 32 },
        (_, member) => `check-stage33-eoa-${String(member).padStart(2, "0")}`,
      ),
    ],
  );
  add(
    "final-batch-close",
    "final",
    "sponsor",
    "candidatePool",
    call("closeWithdrawalBatch(uint256)", [
      resultRef("safe-withdrawal-request", "batchId", "uint256"),
    ]),
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
      resultRef("final-batch-close", "batchId", "uint256"),
      discoveryRef("final-batch-close", definition.actors.sponsor, "clearTotal", "uint64"),
      discoveryRef("final-batch-close", definition.actors.sponsor, "clearMorphoRestore", "uint64"),
      discoveryRef("final-batch-close", definition.actors.sponsor, "settlementProof", "bytes"),
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
      call("processWithdrawal(uint256,address)", [
        resultRef("final-batch-close", "batchId", "uint256"),
        account,
      ]),
      ["final-batch-settle"],
      { concurrencyGroup: "final-process" },
    );
    add(
      `final-finalize-${id}`,
      "final",
      "sponsor",
      "wrapper",
      call("finalizeUnwrap(bytes32,uint64,bytes)", [
        resultRef(`final-process-${id}`, "unwrapRequestId", "bytes32"),
        discoveryRef(`final-process-${id}`, account, "clearAmount", "uint64"),
        discoveryRef(`final-process-${id}`, account, "proof", "bytes"),
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
  const expectedPhases = { setup: 71, deposit: 96, draw: 88, queue: 7, final: 100 };
  for (const [phase, count] of Object.entries(expectedPhases))
    if (actions.filter((entry) => entry.kind === "eoa" && entry.phase === phase).length !== count)
      fail("invalid phase composition");
  for (const entry of actions) {
    if (!PHASES.includes(entry.phase) || typeof entry.operation.signature !== "string")
      fail("invalid action template");
    for (const ref of findRefs(entry.operation)) {
      if (
        ![
          "result",
          "discovery",
          "historicalProof",
          "sdkInput",
          "sdkProof",
          "delegateData",
          "abiBytes",
        ].includes(ref.kind)
      )
        fail("untyped reference");
      if (["sdkInput", "sdkProof", "delegateData", "abiBytes"].includes(ref.kind)) continue;
      if (
        !byId.has(ref.producer) ||
        ref.producer === entry.id ||
        !dependsOn(entry.id, ref.producer, byId)
      )
        fail(`unscoped reference producer ${entry.id}:${ref.producer}`);
    }
  }
}
function findRefs(value, found = []) {
  if (Array.isArray(value)) value.forEach((entry) => findRefs(entry, found));
  else if (plain(value)) {
    if (typeof value.kind === "string" && value.abiType) found.push(value);
    else Object.values(value).forEach((entry) => findRefs(entry, found));
  }
  return found;
}
function dependsOn(id, producer, byId) {
  const pending = [...byId.get(id).dependencies];
  const seen = new Set();
  while (pending.length) {
    const dependency = pending.pop();
    if (dependency === producer) return true;
    if (!seen.has(dependency)) {
      seen.add(dependency);
      pending.push(...byId.get(dependency).dependencies);
    }
  }
  return false;
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
