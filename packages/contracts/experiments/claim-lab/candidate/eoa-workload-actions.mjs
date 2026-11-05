import { deepFreeze } from "./eoa-workload-graph-utils.mjs";
import { addFinal, addReserveStages } from "./eoa-workload-stages.mjs";
import {
  addInitialBatch,
  addInitialDraws,
  addInitialMorpho,
  addParticipantFunding,
  addSafeRejoin,
  addSetup,
} from "./eoa-workload-lifecycle.mjs";
import { addParticipantLifecycle } from "./eoa-workload-participant-lifecycle.mjs";
import { resolveTarget } from "./eoa-workload-templates.mjs";

export function buildActions(definition, manifest) {
  const actions = [];
  const add = createActionAdder(actions, definition);
  const call = (signature, args, value = "0") => ({ signature, args, value });
  const transfer = (recipient, amount) => call("transfer(address,uint256)", [recipient, amount]);
  addSetup(add, call, transfer, definition, manifest);
  addParticipantFunding(add, call, transfer, definition);
  addInitialDraws(add, call, definition);
  addInitialMorpho(add, call, definition);
  addInitialBatch(add, call, definition);
  addParticipantLifecycle(add, call, definition);
  addSafeRejoin(add, call, definition);
  addReserveStages(add, call, definition);
  addFinal(add, call, definition);
  return Object.freeze(actions);
}

function createActionAdder(actions, definition) {
  return (id, phase, actorRole, targetRole, operation, dependencies = [], extra = {}) => {
    const actor =
      actorRole === "participant"
        ? definition.actors.eoaParticipants[extra.actorIndex]
        : definition.actors[actorRole];
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
        target: resolveTarget(definition, targetRole, extra.actorIndex),
        operation,
        dependencies: [...dependencies],
        concurrencyGroup: extra.concurrencyGroup || "serial",
        allocation: extra.allocation || { id: null, usdcMicro: "0", valueWei: "0" },
        refs: extra.refs || {},
        provenance: extra.provenance || null,
      }),
    );
  };
}
