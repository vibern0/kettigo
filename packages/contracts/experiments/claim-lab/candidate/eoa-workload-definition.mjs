import { createHash } from "node:crypto";

import { validateStaticRunDefinition } from "./static-run-definition.mjs";
import { canonical } from "./journal-values.mjs";
import { buildActions } from "./eoa-workload-actions.mjs";
import { deepFreeze, plain, fail } from "./eoa-workload-graph-utils.mjs";
import { normalizedDefinition, validateManifest } from "./eoa-workload-manifest.mjs";
import { validateActions } from "./eoa-workload-graph-validation.mjs";

const PHASES = Object.freeze(["setup", "deposit", "draw", "queue", "final"]);
const digest = (value) => `0x${createHash("sha256").update(canonical(value)).digest("hex")}`;

export function compileCandidateWorkload(definition, manifest) {
  const staticDefinition = validateStaticRunDefinition(definition);
  const normalizedManifest = validateManifest(staticDefinition, manifest);
  const actions = buildActions(staticDefinition, normalizedManifest);
  validateActions(actions);
  const template = Object.freeze({
    version: 1,
    phaseIds: PHASES,
    definition: normalizedDefinition(staticDefinition, normalizedManifest),
    actions,
  });
  return deepFreeze({
    ...template,
    counts: actionCounts(actions),
    totals: actionTotals(actions),
    fingerprint: digest(template),
  });
}

export function workloadFingerprint(workload) {
  return digest({
    version: workload.version,
    phaseIds: workload.phaseIds,
    definition: workload.definition,
    actions: workload.actions,
  });
}

export function validateCompiledCandidateWorkload(workload) {
  if (!plain(workload) || !plain(workload.definition) || !plain(workload.definition.manifest))
    fail("invalid compiled workload");
  const { manifest, policy, ...definition } = workload.definition;
  const expected = compileCandidateWorkload({ version: 1, ...definition }, manifest);
  if (canonical(workload) !== canonical(expected))
    fail("compiled workload differs from definition");
  return expected;
}

function actionCounts(actions) {
  return Object.freeze({
    eoa: actions.filter((action) => action.kind === "eoa").length,
    safe: actions.filter((action) => action.kind === "externalSafe").length,
  });
}

function actionTotals(actions) {
  return Object.freeze({
    usdcMicro: actions
      .reduce((total, action) => total + BigInt(action.allocation.usdcMicro), 0n)
      .toString(),
    grossFundingWei: actions
      .reduce((total, action) => total + BigInt(action.allocation.valueWei), 0n)
      .toString(),
  });
}
