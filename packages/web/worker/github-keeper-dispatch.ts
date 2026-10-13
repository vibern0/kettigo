const KEEPER_WORKFLOW_URL =
  "https://api.github.com/repos/vibern0/kettigo/actions/workflows/keepers.yml/dispatches";

type WorkflowSender = () => Promise<Pick<Response, "ok" | "status">>;

export function buildKeeperWorkflowRequest(token: string): Request {
  return new Request(KEEPER_WORKFLOW_URL, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "kettigo-cloudflare-keeper-dispatcher",
      "X-GitHub-Api-Version": "2026-03-10",
    },
    body: JSON.stringify({ ref: "main" }),
  });
}

export async function dispatchKeeperWorkflow(
  token: string,
  send: WorkflowSender = () => fetch(buildKeeperWorkflowRequest(token)),
): Promise<number> {
  const response = await send();

  if (!response.ok) {
    throw new Error(`GitHub workflow dispatch failed with status ${response.status}`);
  }

  return response.status;
}
