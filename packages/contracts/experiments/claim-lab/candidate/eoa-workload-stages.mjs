import {
  checkTemplate,
  depositTemplate,
  discoveryRef,
  prizeAllocation,
  prizeFundingData,
  resultRef,
  safeDepositTemplate,
  sdkProofRef,
  sdkRef,
} from "./eoa-workload-templates.mjs";
import { addStage8Checks } from "./eoa-workload-draw-stage8.mjs";
import { addStage33Checks } from "./eoa-workload-draw-stage33.mjs";

export function addSafeInitial(add, call, definition) {
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
export function addParticipantDeposit(add, call, definition, index, amount, dependencies, group) {
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
export function addReserveStages(add, call, definition) {
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
  addPrizeStages(add, call, definition);
  addStage8Checks(add, call, definition);
  addStage33Checks(add, call, definition);
}

function addPrizeStages(add, call, definition) {
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
}

export function addFinal(add, call, definition) {
  addEoaFinalRequests(add, call, definition);
  addSafeFinalRequest(add, call, definition);
  addFinalBatch(add, call, definition);
  addFinalProcesses(add, call, definition);
}

function addEoaFinalRequests(add, call, definition) {
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
}

function addSafeFinalRequest(add, call, definition) {
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
}

function addFinalBatch(add, call, definition) {
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
}

function addFinalProcesses(add, call, definition) {
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
