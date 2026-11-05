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
export function discoveryRef(producer, contractRole, event, beneficiary, field, abiType) {
  return {
    kind: "receiptEvent",
    producer,
    contractRole,
    event,
    ...(beneficiary ? { beneficiary } : {}),
    field,
    abiType,
    constraints: ["confirmed-receipt", ...(beneficiary ? ["indexed-beneficiary"] : [])],
  };
}
export function publicDecryptRef(
  producer,
  contractRole,
  event,
  beneficiary,
  field,
  abiType,
  scope = {},
) {
  return {
    kind: "publicDecrypt",
    producer,
    contractRole,
    event,
    ...(beneficiary ? { beneficiary } : {}),
    field,
    abiType,
    ...scope,
    constraints: [
      "confirmed-receipt",
      ...(beneficiary ? ["indexed-beneficiary"] : []),
      ...(scope.receiver ? ["receiver-match", "same-unwrap-request"] : []),
      "public-handle",
      "decryption-proof",
    ],
  };
}
export function proofRef(draw, beneficiary, field, abiType = "bytes32[]") {
  return {
    kind: "historicalProof",
    producer: draw,
    contractRole: "candidatePool",
    event: "DrawSnapshotClosed",
    beneficiary,
    field,
    abiType,
    constraints: ["depth-32", "immutable-draw", "same-draw-beneficiary-proof"],
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
  const encodedAmount = BigInt(amount).toString(16).padStart(64, "0");
  return {
    kind: "abiBytes",
    tag: "0x506aab00",
    encoded: { abiType: "uint64", value: amount, bytes: 32 },
    data: `0x506aab00${encodedAmount}`,
    length: 36,
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
  const batch = discoveryRef(
    "safe-exit-membership",
    "candidatePool",
    "WithdrawalRequested",
    definition.actors.safeParticipant,
    "batchId",
    "uint256",
  );
  if (index === 0) return [batch];
  if (index === 1) return initialSettlementArgs(batch, definition);
  if (index === 2) return [batch, definition.actors.safeParticipant];
  return initialFinalizeArgs(definition);
}

function initialSettlementArgs(batch, definition) {
  const decrypt = (field, abiType) =>
    publicDecryptRef(
      "initial-batch-close",
      "candidatePool",
      "WithdrawalBatchClosed",
      undefined,
      field,
      abiType,
    );
  return [
    batch,
    decrypt("clearTotal", "uint64"),
    decrypt("clearMorphoRestore", "uint64"),
    decrypt("settlementProof", "bytes"),
  ];
}

function initialFinalizeArgs(definition) {
  return [
    discoveryRef(
      "initial-batch-process-safe",
      "candidatePool",
      "WithdrawalClaimedToUsdc",
      definition.actors.safeParticipant,
      "unwrapRequestId",
      "bytes32",
    ),
    publicDecryptRef(
      "initial-batch-process-safe",
      "wrapper",
      "UnwrapRequested",
      undefined,
      "clearAmount",
      "uint64",
      {
        receiver: definition.actors.safeParticipant,
        unwrapRequestProducer: "initial-batch-process-safe",
      },
    ),
    publicDecryptRef(
      "initial-batch-process-safe",
      "wrapper",
      "UnwrapRequested",
      undefined,
      "proof",
      "bytes",
      {
        receiver: definition.actors.safeParticipant,
        unwrapRequestProducer: "initial-batch-process-safe",
      },
    ),
  ];
}
export function checkTemplate(draw, actor) {
  return {
    signature: "checkPrize(uint256,address,uint256,uint64,bytes32,bytes32[],bytes32[],bytes32[])",
    args: Object.freeze([
      discoveryRef(draw, "candidatePool", "DrawClosed", undefined, "drawId", "uint256"),
      actor,
      proofRef(draw, actor, "index", "uint256"),
      proofRef(draw, actor, "generation", "uint64"),
      proofRef(draw, actor, "balanceHandle", "bytes32"),
      proofRef(draw, actor, "siblingHashes"),
      proofRef(draw, actor, "siblingSums"),
      proofRef(draw, actor, "parentSums"),
    ]),
  };
}
