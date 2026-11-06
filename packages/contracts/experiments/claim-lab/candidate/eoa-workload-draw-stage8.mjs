import { checkTemplate } from "./eoa-workload-templates.mjs";

export function addStage8Checks(add, call, definition) {
  for (let index = 0; index < 7; index += 1) addStage8Member(add, call, definition, index);
  add(
    "safe-stage-8-check",
    "draw",
    "safeParticipant",
    "candidatePool",
    checkTemplate("close-draw-8", definition.actors.safeParticipant),
    ["close-draw-8"],
  );
}

function addStage8Member(add, call, definition, index) {
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
      concurrency: {
        id: index === 0 ? "stage8-1" : index < 5 ? "stage8-4" : "stage8-2",
        width: index === 0 ? 1 : index < 5 ? 4 : 2,
      },
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
