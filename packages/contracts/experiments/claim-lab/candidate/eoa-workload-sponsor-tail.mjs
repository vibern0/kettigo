export function addSponsorTail(actions) {
  const ordered = topologicalActions(actions).filter((action) => action.actorRole === "sponsor");
  for (let index = 1; index < ordered.length; index += 1)
    appendDependency(ordered[index], ordered[index - 1].id);
}

function topologicalActions(actions) {
  const byId = new Map(actions.map((action) => [action.id, action]));
  const pending = new Set(actions.map((action) => action.id));
  const ordered = [];
  while (pending.size) {
    const ready = [...pending].filter((id) => dependenciesReady(byId.get(id), pending)).sort();
    if (!ready.length) throw new Error("candidate workload definition: sponsor dependency cycle");
    ready.forEach((id) => {
      pending.delete(id);
      ordered.push(byId.get(id));
    });
  }
  return ordered;
}

function dependenciesReady(action, pending) {
  return action.dependencies.every((dependency) => !pending.has(dependency));
}

function appendDependency(action, dependency) {
  if (!action.dependencies.includes(dependency)) action.dependencies.push(dependency);
}
