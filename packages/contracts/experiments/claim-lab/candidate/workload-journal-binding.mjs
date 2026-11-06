import { validateCompiledCandidateWorkload } from "./eoa-workload-definition.mjs";

export function validateWorkloadJournalBinding(workload) {
  return validateCompiledCandidateWorkload(workload);
}
