import { plain } from "./eoa-workload-graph-utils.mjs";
import { fail } from "./eoa-workload-templates.mjs";

const PHASES = Object.freeze(["setup", "deposit", "draw", "queue", "final"]);

export function validateActions(actions) {
  if (
    actions.length !== 375 ||
    new Set(actions.map((entry) => entry.id)).size !== 375 ||
    actions.filter((entry) => entry.kind === "externalSafe").length !== 13
  )
    fail("invalid finite action graph");
  const byId = new Map(actions.map((entry) => [entry.id, entry]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) fail("cyclic dependency");
    if (visited.has(id)) return;
    const entry = byId.get(id);
    if (!entry) fail("unknown dependency producer");
    visiting.add(id);
    entry.dependencies.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  actions.forEach((entry) => visit(entry.id));
  const expectedPhases = { setup: 71, deposit: 96, draw: 88, queue: 7, final: 100 };
  for (const [phase, count] of Object.entries(expectedPhases))
    if (actions.filter((entry) => entry.kind === "eoa" && entry.phase === phase).length !== count)
      fail("invalid phase composition");
  for (const entry of actions) {
    if (!PHASES.includes(entry.phase) || typeof entry.operation.signature !== "string")
      fail("invalid action template");
    findRefs(entry.operation).forEach((ref) => validateRef(ref, entry, byId));
  }
}
function validateRef(ref, entry, byId) {
  const staticKinds = ["sdkInput", "sdkProof", "delegateData", "abiBytes"];
  const kinds = ["result", "receiptEvent", "publicDecrypt", "historicalProof", ...staticKinds];
  if (!kinds.includes(ref.kind)) fail("untyped reference");
  if (staticKinds.includes(ref.kind)) return;
  if (
    !byId.has(ref.producer) ||
    ref.producer === entry.id ||
    !dependsOn(entry.id, ref.producer, byId)
  )
    fail(`unscoped reference producer ${entry.id}:${ref.producer}`);
  if (
    ["receiptEvent", "publicDecrypt", "historicalProof"].includes(ref.kind) &&
    (!ref.contractRole || !ref.event || !ref.beneficiary)
  )
    fail(`incomplete scoped reference ${entry.id}:${ref.producer}`);
}
function findRefs(value, found = []) {
  if (Array.isArray(value)) value.forEach((entry) => findRefs(entry, found));
  else if (plain(value)) {
    if (typeof value.kind === "string" && value.abiType) found.push(value);
    else Object.values(value).forEach((entry) => findRefs(entry, found));
  }
  return found;
}
function dependsOn(id, producer, byId) {
  const pending = [...byId.get(id).dependencies];
  const seen = new Set();
  while (pending.length) {
    const dependency = pending.pop();
    if (dependency === producer) return true;
    if (!seen.has(dependency)) {
      seen.add(dependency);
      pending.push(...byId.get(dependency).dependencies);
    }
  }
  return false;
}
