import {
  checkTemplate,
  discoveryRef,
  initialQueueArgs,
  prizeAllocation,
  prizeFundingData,
  resultRef,
  safeDepositTemplate,
  sdkProofRef,
  sdkRef,
} from "./eoa-workload-templates.mjs";
import { addSafeInitial } from "./eoa-workload-stages.mjs";

const principal = (index) => (index === 0 ? "3000000" : index === 1 ? "1000000" : "2000000");

export function addSetup(add, call, transfer, definition, manifest) {
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
}

export function addParticipantFunding(add, call, transfer, definition) {
  addEthFunding(add, call, definition);
  addUsdcFunding(add, transfer, definition);
  addSafeFunding(add, call, transfer, definition);
}

function addEthFunding(add, call, definition) {
  const participant = (index) => definition.actors.eoaParticipants[index];
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
}

function addUsdcFunding(add, transfer, definition) {
  const participant = (index) => definition.actors.eoaParticipants[index];
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
}

function addSafeFunding(add, call, transfer, definition) {
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
}

export function addInitialDraws(add, call, definition) {
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
}

export function addInitialMorpho(add, call, definition) {
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
}

export function addInitialBatch(add, call, definition) {
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
}

export function addSafeRejoin(add, call, definition) {
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
}
