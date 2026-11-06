import { checkTemplate } from "./eoa-workload-templates.mjs";

export function addStage33Checks(add, call, definition) {
  for (let index = 0; index < 32; index += 1) addStage33Member(add, call, definition, index);
  addSafeStage33(add, call, definition);
}

function addStage33Member(add, call, definition, index) {
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
    {
      actorIndex: index,
      concurrencyGroup: `stage33-${Math.floor(index / 8)}`,
      concurrency: { id: `stage33-${Math.floor(index / 8)}`, width: 8 },
    },
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

function addSafeStage33(add, call, definition) {
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
