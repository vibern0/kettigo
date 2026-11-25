# Candidate Deployment Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce complete, reviewable readiness evidence for the Merkle/FHE candidate without deploying, funding, signing, or starting the bounded Sepolia run.

**Architecture:** Keep the release manifest as a checked-in, address-free candidate template until deployments exist. Independently prove that the contracts, proof Worker, and web application build from pinned dependencies; then reconcile their required runtime configuration against the manifest template and existing run envelope.

**Spec:** `docs/releases/2026-11-06-merkle-fhe-integration-progress.md`, `docs/releases/merkle-fhe-v2-run-envelope.md`, `docs/BOUNTY_SCOPE.md`

## Constraints

- Ethereum Sepolia only; no mainnet configuration.
- Do not deploy, fund wallets, request financial signatures, or start the run.
- Preserve the existing legacy addresses and retention canary.
- Candidate address fields stay unset until bytecode is deployed and verified.
- Use checksum addresses in every SDK/relayer-facing configuration field.

## Parallel workstreams

### A. Release manifest and configuration contract

**Files:** Create `docs/releases/merkle-fhe-v2-candidate-manifest.json`; add a validation script and test under `packages/contracts/scripts/`.

- [ ] Write a failing test for missing candidate addresses, mismatched chain IDs, lowercase addresses, duplicate deployment roles, and forbidden legacy/canary pool addresses.
- [ ] Define the manifest schema: source commit, contract roles and runtime hashes, proof Worker URL/namespace, app URL, build artifact hashes, and run-envelope reference.
- [ ] Implement schema validation and a read-only CLI that reports unresolved fields without accepting deployment credentials.
- [ ] Run the focused test and contracts typecheck.

### B. Contracts reproducibility evidence

**Files:** Add a read-only candidate manifest generator under `packages/contracts/scripts/`; add focused tests if parsing or hashing logic is new.

- [ ] Write a failing test that rejects an artifact whose deployed bytecode or compiler settings differ from the candidate manifest input.
- [ ] Build the contracts with the pinned package-manager version and generate source/runtime hash evidence for `ConfidentialUSDC`, `ConfidentialPrizePool`, and `MorphoYieldAdapter`.
- [ ] Run the full contracts tests, TypeScript check, and the deployment scripts’ dry-run-safe validation path.

### C. Proof-service readiness evidence

**Files:** Modify only `packages/proof-service/` readiness documentation or scripts as needed.

- [ ] Verify the committed Worker configuration references the dedicated D1 namespace and does not contain candidate contract addresses before the manifest is populated.
- [ ] Run clean frozen install, typecheck, Worker tests, retained restore/backfill tests, build, and Wrangler dry run.
- [ ] Record the resulting artifact/version and required runtime secrets as unresolved manifest fields; never print secret values.

### D. Web readiness evidence

**Files:** Modify only `packages/web/` readiness documentation or scripts as needed.

- [ ] Write a failing configuration test showing that legacy pool addresses cannot be selected when a candidate manifest is active, while an incomplete manifest blocks candidate routing.
- [ ] Implement manifest-derived candidate environment validation with checksum normalization and bigint-safe typed-data handling preserved.
- [ ] Run clean frozen install, typecheck, unit/rendered tests, production build, and Wrangler dry run.

### E. Run authorization packet

**Files:** Create `docs/releases/merkle-fhe-v2-candidate-go-no-go.md`.

- [ ] Reconcile the existing envelope against the manifest, including 600-transaction, 0.003 ETH fee, 0.005 ETH funding, 100 USDC, and two-hour ceilings.
- [ ] List the exact preconditions for a later live-run authorization: verified contract addresses, Worker URL, app URL, smoke-test credentials, and fee quote below the envelope cap.
- [ ] State that no authorization, signing, or spend occurs through this packet.

## Integration sequence

1. Complete A–D in parallel; each produces independent evidence and an unresolved-fields list.
2. Complete E after A–D outputs exist, without changing the envelope.
3. Run the manifest validator against all generated evidence and update the progress report.
4. Only after a separate go-ahead may the deployment and live-run tasks begin.

## Review focus

- Candidate configuration must never silently reuse a legacy or canary pool address.
- Missing deployment evidence must fail closed rather than selecting a fallback address.
- Every hash must identify the compiler/build source it came from.
- Worker and web dry runs must not write remote state.
- The readiness packet must not be interpreted as approval to spend or deploy.
