# Kettigo Agent Notes

Read [docs/BOUNTY_SCOPE.md](docs/BOUNTY_SCOPE.md) and
[docs/ROADMAP.md](docs/ROADMAP.md) before making architecture, contract,
deployment, or network decisions.

## Non-negotiable project scope

- This project targets the Zama Developer Program Mainnet Season 4 bounty:
  **Build the Confidential PoolTogether App**.
- "PoolTogether" describes the no-loss prize-savings mechanic. The bounty does
  not require integrating or deploying the official PoolTogether protocol.
- Build and deploy the complete demo on Ethereum Sepolia, where the Zama
  Protocol testnet is available.
- Use Zama FHE for encrypted deposits/balances, deposit-weighted onchain winner
  selection with FHE randomness, confidential winnings, and EIP-712 user
  decryption.
- Always pass checksum `0x...` addresses into Zama SDK/relayer calls. Normalize
  with `viem.getAddress()` or equivalent. Do not lowercase addresses for
  `createEncryptedInput`, `createEIP712`, `userDecrypt`, handle/contract pairs,
  or frontend env-derived contract addresses.
- A test ERC-20 and documented mock yield source/admin-funded prize reserve are
  explicitly acceptable.
- Do not switch to Base, Optimism, or another PoolTogether deployment network
  merely to use official PoolTogether contracts.
- Mainnet deployment is not a bounty submission requirement. "Mainnet Season
  4" is the program season name; the challenge requires a working Sepolia demo.

## Current implementation status

The existing `MockUSDC`, ERC-4626 `Vault`, and plaintext `PrizePool` are an
early prototype. They do not yet satisfy the bounty's confidentiality or FHE
randomness requirements. Treat them as replaceable scaffolding, not the target
architecture.

## Zama SDK implementation notes

- The Phase 1 browser spike failed with `User address is not a valid address`
  until wallet and contract addresses were normalized to checksum form. Keep
  this invariant throughout the app.
- The EIP-712 object returned by Zama can contain `bigint` values. Serialize
  typed data with a replacer that converts `bigint` to string before calling
  `eth_signTypedData_v4`; plain `JSON.stringify(eip712)` can throw
  `Do not know how to serialize a BigInt`.

## Product copy rules

- Write user-facing product copy for everyday people and assume Kettigo is a
  finished product, not a demo.
- Do not mention implementation/privacy words like "encrypted", "confidential",
  "public", "private", "decrypted", "mock", "mocked", "testnet", "Sepolia",
  "prototype", "faucet", or "leakage" in user-facing UI, marketing, or demo
  copy.
- When explaining prizes, describe eligibility at the end of each draw. Do not
  imply a user has guaranteed winnings before they check or claim a prize.

## Pull request quality gate

Before opening a pull request, run Codacy's local PR analysis and inspect the
Codacy Cloud PR report. Fix every Critical, High, and Medium finding, or record
an explicit false-positive reason in Codacy when the finding cannot apply to
the project's technology. Re-run the analysis after pushing, then resolve the
corresponding GitHub inline review threads. For any Cloudflare deployment
affected by the change, use the pinned package-manager version, run a clean
frozen install, run its real build, and run Wrangler `deploy --dry-run`; if
deployment credentials are available, deploy and smoke-test the target before
calling the PR ready. Use the `codacy-pr-review` skill for the detailed review
workflow.

## Shared-work safeguards

- Never force-push. Do not rewrite or overwrite branches that another agent may
  be using.
- Before merging a pull request, fetch the latest `origin/main`, merge it into
  the pull-request branch, and resolve conflicts by preserving the intent and
  completed work from both sides. Do not discard another agent's changes to
  make a conflict disappear.
- After resolving conflicts, rerun the relevant tests and quality gates, then
  push with a normal (non-force) push.
- Verify that expected commits and merged pull requests remain reachable from
  the updated branch before merging. If work appears missing, stop and recover
  it instead of proceeding with the merge.
