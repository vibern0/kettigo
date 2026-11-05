import {
  checkTemplate,
  depositTemplate,
  discoveryRef,
  publicDecryptRef,
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
    { allocation: routeAllocation("safe-initial", "2000000") },
  );
  add(
    "safe-initial-admission",
    "deposit",
    "safeParticipant",
    "candidatePool",
    call("finalizeAdmission(address,uint256,bool,bytes)", [
      definition.actors.safeParticipant,
      discoveryRef(
        "safe-initial-deposit",
        "candidatePool",
        "AdmissionRequested",
        definition.actors.safeParticipant,
        "nonce",
        "uint256",
      ),
      true,
      publicDecryptRef(
        "safe-initial-deposit",
        "candidatePool",
        "AdmissionRequested",
        definition.actors.safeParticipant,
        "marker",
        "bytes",
      ),
    ]),
    ["safe-initial-deposit"],
  );
}
export function addParticipantDeposit(add, call, definition, index, amount, dependencies, group) {
  const id = String(index).padStart(2, "0");
  const actor = definition.actors.eoaParticipants[index];
  const extra = {
    actorIndex: index,
    concurrencyGroup: group,
    allocation: routeAllocation(`principal-eoa-${id}`, amount),
  };
  addParticipantApprove(add, call, definition, id, amount, dependencies, extra);
  addParticipantWrappedDeposit(add, definition, id, actor, amount, extra);
  addParticipantAdmission(add, call, id, actor, extra);
}

function addParticipantApprove(add, call, definition, id, amount, dependencies, extra) {
  add(
    `eoa-${id}-approve`,
    "deposit",
    "participant",
    "underlying",
    call("approve(address,uint256)", [definition.contracts.wrapper, amount]),
    [`fund-usdc-eoa-${id}`, ...dependencies],
    extra,
  );
}

function addParticipantWrappedDeposit(add, definition, id, actor, amount, extra) {
  add(
    `eoa-${id}-deposit`,
    "deposit",
    "participant",
    "wrapper",
    depositTemplate(definition, `eoa-${id}-deposit`, actor, amount),
    [`eoa-${id}-approve`],
    {
      ...extra,
      refs: { encryptedInput: sdkRef(`eoa-${id}-deposit`, "wrapper", actor, amount, "deposit") },
    },
  );
}

function addParticipantAdmission(add, call, id, actor, extra) {
  add(
    `eoa-${id}-admit`,
    "deposit",
    "participant",
    "candidatePool",
    call("finalizeAdmission(address,uint256,bool,bytes)", [
      actor,
      discoveryRef(
        `eoa-${id}-deposit`,
        "candidatePool",
        "AdmissionRequested",
        actor,
        "nonce",
        "uint256",
      ),
      true,
      publicDecryptRef(
        `eoa-${id}-deposit`,
        "candidatePool",
        "AdmissionRequested",
        actor,
        "marker",
        "bytes",
      ),
    ]),
    [`eoa-${id}-deposit`],
    extra,
  );
}

function routeAllocation(route, amount) {
  return {
    id: "bootstrap-usdc-78",
    usdcMicro: "0",
    valueWei: "0",
    provenance: `bootstrap-usdc-78/${route}`,
    suballocationMicro: amount,
  };
}
export function addReserveStages(add, call, definition) {
  add(
    "reserve-approve",
    "draw",
    "sponsor",
    "underlying",
    call("approve(address,uint256)", [definition.contracts.wrapper, "12000000"]),
    ["safe-initial-admission"],
    { allocation: prizeAllocation("reserve", "12000000") },
  );
  add(
    "reserve-wrap",
    "draw",
    "sponsor",
    "wrapper",
    call("wrap(address,uint256)", [definition.actors.sponsor, "12000000"]),
    ["reserve-approve"],
    { allocation: prizeAllocation("reserve", "12000000") },
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
  const batch = finalBatchRef(definition);
  add(
    "final-batch-close",
    "final",
    "sponsor",
    "candidatePool",
    call("closeWithdrawalBatch(uint256)", [batch]),
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
    call(
      "settleWithdrawalBatch(uint256,uint64,uint64,bytes)",
      finalSettlementArgs(batch, definition),
    ),
    ["final-batch-close"],
  );
}

function finalBatchRef(definition) {
  return discoveryRef(
    "final-request-eoa-00",
    "candidatePool",
    "WithdrawalRequested",
    definition.actors.eoaParticipants[0],
    "batchId",
    "uint256",
  );
}

function finalSettlementArgs(batch, definition) {
  const decrypt = (field, abiType) =>
    publicDecryptRef(
      "final-batch-close",
      "candidatePool",
      "WithdrawalBatchClosed",
      definition.actors.sponsor,
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

function addFinalProcesses(add, call, definition) {
  for (let index = 0; index < 33; index += 1) {
    const account =
      index === 32 ? definition.actors.safeParticipant : definition.actors.eoaParticipants[index];
    const id = index === 32 ? "safe" : `eoa-${String(index).padStart(2, "0")}`;
    addFinalProcess(add, call, definition, id, account);
    addFinalFinalize(add, call, id, account);
  }
}

function addFinalProcess(add, call, definition, id, account) {
  add(
    `final-process-${id}`,
    "final",
    "sponsor",
    "candidatePool",
    call("processWithdrawal(uint256,address)", [finalBatchRef(definition), account]),
    ["final-batch-settle"],
    { concurrencyGroup: "final-process" },
  );
}

function addFinalFinalize(add, call, id, account) {
  add(
    `final-finalize-${id}`,
    "final",
    "sponsor",
    "wrapper",
    call("finalizeUnwrap(bytes32,uint64,bytes)", [
      resultRef(`final-process-${id}`, "unwrapRequestId", "bytes32"),
      publicDecryptRef(
        `final-process-${id}`,
        "wrapper",
        "UnwrapRequested",
        account,
        "clearAmount",
        "uint64",
      ),
      publicDecryptRef(
        `final-process-${id}`,
        "wrapper",
        "UnwrapRequested",
        account,
        "proof",
        "bytes",
      ),
    ]),
    [`final-process-${id}`],
    { concurrencyGroup: "final-finalize" },
  );
}
