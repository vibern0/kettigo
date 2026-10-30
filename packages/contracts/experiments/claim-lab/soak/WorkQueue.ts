export function nextCycle(cycles: Record<string, { status: string }>, now: number, deadline: number,
  limit: number): { index: number; resume: boolean } | null {
  // Once funds have entered a cycle, the deadline stops new work, not recovery.
  for (let index = 0; index < limit; index++) {
    const cycle = cycles[`cycle-${index}`];
    if (cycle && cycle.status !== "completed") return { index, resume: true };
  }
  if (now >= deadline) return null;
  for (let index = 0; index < limit; index++) if (!cycles[`cycle-${index}`]) return { index, resume: false };
  return null;
}
