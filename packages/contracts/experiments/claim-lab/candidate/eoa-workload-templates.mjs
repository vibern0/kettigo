export const fail = (message) => {
  throw new Error(`candidate workload definition: ${message}`);
};

export function resolveTarget(definition, role, participantIndex) {
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
export function resultRef(producer, field, abiType) {
  return { kind: "result", producer, field, abiType, constraints: ["producer-complete"] };
}
export function discoveryRef(producer, beneficiary, field, abiType) {
  return {
    kind: "discovery",
    producer,
    beneficiary,
    field,
    abiType,
    constraints: ["immutable-read"],
  };
}
export function proofRef(draw, beneficiary, field) {
  return {
    kind: "historicalProof",
    producer: draw,
    beneficiary,
    field,
    abiType: "bytes32[]",
    constraints: ["depth-32", "immutable-draw"],
  };
}
export function sdkRef(producer, contractRole, actor, amount, purpose) {
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
export function sdkProofRef(producer) {
  return {
    kind: "sdkProof",
    producer,
    field: "inputProof",
    abiType: "bytes",
    constraints: ["same-sdk-input"],
  };
}
export function prizeFundingData(amount) {
  return {
    kind: "abiBytes",
    tag: "0x5052495a455f46554e44494e475f44415441",
    encoded: { abiType: "uint64", value: amount },
  };
}
export function prizeAllocation(stage, amount) {
  return {
    id: "bootstrap-usdc-78",
    usdcMicro: "0",
    valueWei: "0",
    provenance: `bootstrap-usdc-78/prize-${stage}`,
    suballocationMicro: amount,
  };
}
export function depositTemplate(definition, producer, actor, amount) {
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
export function safeDepositTemplate(definition, producer, amount) {
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
export function initialQueueArgs(index, definition) {
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
export function checkTemplate(draw, actor) {
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
