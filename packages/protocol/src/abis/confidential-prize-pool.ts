function getter<Name extends string, OutputType extends string>(
  name: Name,
  outputType: OutputType,
) {
  return { type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type: outputType }] } as const;
}

function batchGetter<Name extends string, OutputType extends string>(
  name: Name,
  outputType: OutputType,
) {
  return {
    type: "function",
    name,
    stateMutability: "view",
    inputs: [{ name: "batchId", type: "uint256" }],
    outputs: [{ type: outputType }],
  } as const;
}

export const confidentialPrizePoolAbi = [
  getter("PRIZE_FUNDING_DATA", "bytes4"),
  getter("token", "address"),
  getter("morphoYieldAdapter", "address"),
  getter("drawId", "uint256"),
  getter("drawInterval", "uint256"),
  getter("nextDrawAt", "uint256"),
  getter("participantCount", "uint256"),
  getter("publicPrizeReserve", "uint64"),
  getter("MAX_USER_PRINCIPAL", "uint64"),
  getter("morphoAvailablePrincipalAssets", "uint256"),
  getter("morphoAccruedYieldAssets", "uint256"),
  getter("morphoPendingDepositCount", "uint256"),
  getter("lastMorphoUnwrapAt", "uint256"),
  getter("morphoUnwrapInterval", "uint256"),
  getter("encryptedTotalPrincipal", "bytes32"),
  getter("encryptedPrizeReserve", "bytes32"),
  getter("encryptedPendingMorphoPrincipal", "bytes32"),
  getter("membershipTreeDepth", "uint8"),
  getter("membershipZero", "bytes32"),
  {
    type: "function", name: "emptyHash", stateMutability: "view",
    inputs: [{ name: "level", type: "uint256" }], outputs: [{ type: "bytes32" }],
  },
  {
    type: "function", name: "membershipNode", stateMutability: "view",
    inputs: [{ name: "level", type: "uint256" }, { name: "index", type: "uint256" }],
    outputs: [{ name: "hash", type: "bytes32" }, { name: "sum", type: "bytes32" }],
  },
  {
    type: "function", name: "checked", stateMutability: "view",
    inputs: [{ name: "drawId", type: "uint256" }, { name: "beneficiary", type: "address" }],
    outputs: [{ name: "wasChecked", type: "bool" }],
  },
  {
    type: "function", name: "checkPrize", stateMutability: "nonpayable",
    inputs: [
      { name: "drawId_", type: "uint256" }, { name: "beneficiary", type: "address" },
      { name: "index", type: "uint256" }, { name: "generation", type: "uint64" },
      { name: "balanceHandle", type: "bytes32" }, { name: "siblingHashes", type: "bytes32[]" },
      { name: "siblingSums", type: "bytes32[]" }, { name: "parentSums", type: "bytes32[]" },
    ], outputs: [],
  },
  {
    type: "function", name: "pendingAdmissionOf", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "pending", type: "tuple", components: [
      { name: "balance", type: "bytes32" }, { name: "nonce", type: "uint256" },
      { name: "marker", type: "bytes32" }, { name: "requested", type: "bool" },
    ] }],
  },
  {
    type: "function", name: "finalizeAdmission", stateMutability: "nonpayable",
    inputs: [{ name: "account", type: "address" }, { name: "nonce", type: "uint256" }, { name: "positive", type: "bool" }, { name: "proof", type: "bytes" }], outputs: [],
  },
  { type: "function", name: "membershipIndexOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "encryptedAwardOf", stateMutability: "view", inputs: [{ name: "drawId_", type: "uint256" }, { name: "beneficiary", type: "address" }], outputs: [{ type: "bytes32" }] },
  {
    type: "function", name: "draws", stateMutability: "view",
    inputs: [{ name: "drawId", type: "uint256" }],
    outputs: [
      { name: "rootHash", type: "bytes32" }, { name: "rootSum", type: "bytes32" }, { name: "ticket", type: "bytes32" },
      { name: "prize", type: "bytes32" }, { name: "remaining", type: "bytes32" }, { name: "upperBound", type: "uint64" }, { name: "closeBlockNumber", type: "uint256" },
    ],
  },
  getter("currentWithdrawalBatchId", "uint256"),
  batchGetter("withdrawalAccounts", "address[]"),
  batchGetter("withdrawalBatchStatus", "uint8"),
  batchGetter("withdrawalBatchClosesAt", "uint256"),
  batchGetter("withdrawalBatchFunded", "bool"),
  batchGetter("withdrawalBatchRestoredAmount", "uint64"),
  batchGetter("withdrawalBatchRequestCount", "uint256"),
  batchGetter("withdrawalBatchClaimantCount", "uint256"),
  batchGetter("encryptedWithdrawalBatchTotal", "bytes32"),
  batchGetter("encryptedWithdrawalBatchMorphoRestore", "bytes32"),
  {
    type: "function", name: "encryptedPrincipalOf", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }], outputs: [{ type: "bytes32" }],
  },
  {
    type: "function", name: "encryptedWinningsOf", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }], outputs: [{ type: "bytes32" }],
  },
  {
    type: "function", name: "withdrawalUnwrapRequest", stateMutability: "view",
    inputs: [{ name: "batchId", type: "uint256" }, { name: "account", type: "address" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function", name: "hasWithdrawalClaim", stateMutability: "view",
    inputs: [{ name: "batchId", type: "uint256" }, { name: "account", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  { type: "function", name: "closeDraw", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "claimPrize", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "claimPrizeToSavings", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "bytes32" }] },
  {
    type: "function", name: "requestWithdrawal", stateMutability: "nonpayable",
    inputs: [{ name: "encryptedAmount", type: "bytes32" }, { name: "inputProof", type: "bytes" }],
    outputs: [{ name: "batchId", type: "uint256" }],
  },
  {
    type: "function", name: "claimWithdrawalToUsdc", stateMutability: "nonpayable",
    inputs: [{ name: "batchId", type: "uint256" }, { name: "to", type: "address" }],
    outputs: [{ name: "unwrapRequestId", type: "bytes32" }],
  },
  {
    type: "function", name: "closeWithdrawalBatch", stateMutability: "nonpayable",
    inputs: [{ name: "batchId", type: "uint256" }], outputs: [],
  },
  {
    type: "function", name: "settleWithdrawalBatch", stateMutability: "nonpayable",
    inputs: [
      { name: "batchId", type: "uint256" }, { name: "cleartextTotal", type: "uint64" },
      { name: "cleartextMorphoRestore", type: "uint64" }, { name: "decryptionProof", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function", name: "processWithdrawal", stateMutability: "nonpayable",
    inputs: [{ name: "batchId", type: "uint256" }, { name: "account", type: "address" }],
    outputs: [{ name: "unwrapRequestId", type: "bytes32" }],
  },
  {
    type: "function", name: "supplyAvailableMorphoPrincipal", stateMutability: "nonpayable", inputs: [],
    outputs: [{ name: "assetsSupplied", type: "uint256" }, { name: "sharesSupplied", type: "uint256" }],
  },
  {
    type: "function", name: "requestMorphoPrincipalUnwrap", stateMutability: "nonpayable", inputs: [],
    outputs: [{ name: "unwrapRequestId", type: "bytes32" }],
  },
  {
    type: "event", name: "WithdrawalRequested",
    inputs: [
      { indexed: true, name: "account", type: "address" }, { indexed: true, name: "batchId", type: "uint256" },
      { indexed: true, name: "amount", type: "bytes32" },
    ],
  },
  {
    type: "event", name: "DrawSnapshotClosed",
    inputs: [
      { indexed: true, name: "drawId", type: "uint256" }, { indexed: false, name: "rootHash", type: "bytes32" },
      { indexed: false, name: "rootSum", type: "bytes32" }, { indexed: false, name: "ticket", type: "bytes32" },
      { indexed: false, name: "prize", type: "bytes32" }, { indexed: false, name: "remaining", type: "bytes32" },
      { indexed: false, name: "upperBound", type: "uint64" }, { indexed: false, name: "closeBlockNumber", type: "uint256" },
    ],
  },
  {
    type: "event", name: "NodeUpdated",
    inputs: [
      { indexed: true, name: "level", type: "uint256" }, { indexed: true, name: "index", type: "uint256" },
      { indexed: false, name: "hash", type: "bytes32" }, { indexed: false, name: "sum", type: "bytes32" },
    ],
  },
  {
    type: "event", name: "SlotAssigned",
    inputs: [
      { indexed: true, name: "account", type: "address" }, { indexed: true, name: "index", type: "uint256" },
      { indexed: false, name: "generation", type: "uint64" },
    ],
  },
  {
    type: "event", name: "SlotReleased",
    inputs: [
      { indexed: true, name: "account", type: "address" }, { indexed: true, name: "index", type: "uint256" },
      { indexed: false, name: "generation", type: "uint64" },
    ],
  },
  {
    type: "event", name: "WithdrawalClaimedToUsdc",
    inputs: [
      { indexed: true, name: "account", type: "address" }, { indexed: true, name: "batchId", type: "uint256" },
      { indexed: true, name: "to", type: "address" }, { indexed: false, name: "amount", type: "bytes32" },
      { indexed: false, name: "unwrapRequestId", type: "bytes32" },
    ],
  },
] as const;
