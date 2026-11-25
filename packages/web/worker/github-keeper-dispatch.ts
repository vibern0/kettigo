const KEEPER_WORKFLOW_URL =
  "https://api.github.com/repos/vibern0/kettigo/actions/workflows/keepers.yml/dispatches";

function buildKeeperWorkflowRequestInit(token: string, ref: string): RequestInit {
  return {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "kettigo-cloudflare-keeper-dispatcher",
      "X-GitHub-Api-Version": "2026-03-10",
    },
    body: JSON.stringify({ ref }),
  };
}

export function buildKeeperWorkflowRequest(token: string, ref = "main"): Request {
  return new Request(KEEPER_WORKFLOW_URL, buildKeeperWorkflowRequestInit(token, ref));
}

export async function dispatchKeeperWorkflow(
  token: string,
  ref = "main",
): Promise<number> {
  const response = await fetch(KEEPER_WORKFLOW_URL, buildKeeperWorkflowRequestInit(token, ref));

  if (!response.ok) {
    throw new Error(`GitHub workflow dispatch failed with status ${response.status}`);
  }

  return response.status;
}
