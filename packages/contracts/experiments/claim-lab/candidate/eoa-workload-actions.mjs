import { deepFreeze } from "./eoa-workload-graph-utils.mjs";
import {
  addFinal,
  addParticipantDeposit,
  addReserveStages,
  addSafeInitial,
} from "./eoa-workload-stages.mjs";
import {
  checkTemplate,
  discoveryRef,
  initialQueueArgs,
  prizeAllocation,
  prizeFundingData,
  resultRef,
  resolveTarget,
  safeDepositTemplate,
  sdkProofRef,
  sdkRef,
} from "./eoa-workload-templates.mjs";

export function buildActions(definition, manifest) {
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
