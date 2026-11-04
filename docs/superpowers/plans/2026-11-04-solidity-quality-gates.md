# Solidity Quality Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce staged-file Solidity formatting and Solhint locally, and Aderyn analysis in GitHub Actions, with the existing contracts clean under both tools.

**Architecture:** Root-level Husky and lint-staged provide fast feedback before a commit while leaving non-Solidity files untouched. Solhint and formatter configuration are versioned at the repository root. An independent GitHub Actions workflow compiles the Hardhat contracts then runs Aderyn over the complete contracts package, producing a retained report.

**Tech Stack:** pnpm 10.11.1, Node.js 22+, Husky, lint-staged, Solhint, Prettier Solidity plugin, GitHub Actions, Hardhat, Aderyn.

**Spec:** `docs/superpowers/specs/2026-11-04-solidity-quality-gates-design.md`

## Global Constraints

- Do not alter the user’s existing `.codacy/` changes.
- Run Solhint and formatting only on staged `.sol` files at pre-commit time.
- Compile before repository-wide Aderyn analysis in CI.
- Prefer source fixes; a suppression must be detector-specific, narrowly scoped, and explain why it is safe.
- Keep Solidity behavior unchanged except for a necessary verified security correction.

## Review Focus

- A staged TypeScript or documentation-only change must not invoke the Solidity hook.
- A staged badly formatted Solidity file must be formatted and re-staged before commit proceeds.
- A staged Solhint violation must block commit and show the file/rule that failed.
- CI must analyze every contract, not only files altered by a pull request.
- A compilation or Aderyn failure must fail CI and preserve the Aderyn report for review.

---

### Task 1: Establish local Solidity quality gate

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `.husky/pre-commit`
- Create: `.solhint.json`
- Create: `.prettierrc.json`

**Interfaces:**
- Produces: `pnpm lint:solidity`, `pnpm format:solidity:check`, and `pnpm prepare` root scripts.
- Produces: a `lint-staged` mapping from `*.sol` to Prettier write mode and Solhint.

- [ ] **Step 1: Add the linting dependencies and scripts**

Add root development dependencies for `husky`, `lint-staged`, `solhint`, `prettier`, and the Solidity Prettier plugin. Define scripts that lint all `packages/contracts/contracts/**/*.sol`, verify their formatting, and initialize Husky after install.

- [ ] **Step 2: Create the versioned tool configurations**

Add `.solhint.json` that extends the current Solhint recommended baseline and explicitly selects the project’s Solidity 0.8.28-compatible rules. Add `.prettierrc.json` that loads the Solidity formatter plugin and uses a stable project-wide layout.

- [ ] **Step 3: Create the pre-commit hook**

Create `.husky/pre-commit` invoking `pnpm exec lint-staged`; configure lint-staged in `package.json` so staged `*.sol` files run `prettier --write` followed by `solhint`.

- [ ] **Step 4: Prove the local gate handles its boundary cases**

Run: `pnpm lint:solidity && pnpm format:solidity:check`

Expected: current formatted, lint-clean code passes.

Stage a temporary non-Solidity file and invoke the hook; expected: hook exits successfully without Solidity commands. Stage a temporary malformed Solidity fixture, invoke the hook; expected: formatter changes/re-stages the fixture and a lint violation blocks the hook. Remove all temporary fixtures before continuing.

### Task 2: Resolve all Solhint and formatting findings

**Files:**
- Modify: only Solidity source or test files reported by Task 1 tools.

**Interfaces:**
- Consumes: `pnpm lint:solidity` and `pnpm format:solidity:check` from Task 1.
- Produces: source that passes both local full-project commands with no Solhint suppressions unless a specific documented false positive remains.

- [ ] **Step 1: Capture the baseline finding list**

Run: `pnpm lint:solidity` and `pnpm format:solidity:check`.

Expected: failures identify every source location requiring repair.

- [ ] **Step 2: Repair each formatting and linting finding at its source**

Apply formatter output and make the smallest semantics-preserving source edits needed for each rule violation. For any rule that cannot safely apply to the FHE contract code, add only a detector/rule-specific inline suppression and a concise safety rationale.

- [ ] **Step 3: Prove Solhint is clean**

Run: `pnpm lint:solidity && pnpm format:solidity:check`

Expected: both commands exit 0 with no unresolved findings.

- [ ] **Step 4: Verify contract behavior remains intact**

Run: `pnpm contracts:compile && pnpm contracts:test`

Expected: compilation and the full Hardhat contract test suite pass.

### Task 3: Add a repository-wide Aderyn CI gate

**Files:**
- Create: `.github/workflows/solidity-quality.yml`

**Interfaces:**
- Consumes: `pnpm install --frozen-lockfile`, the root Solidity scripts, and the `packages/contracts` Hardhat project.
- Produces: a `solidity-quality` GitHub Actions check and `aderyn-report` artifact.

- [ ] **Step 1: Add the CI workflow**

Create a workflow triggered by pull requests and direct pushes that touch Solidity source, Solidity tool configuration, lockfiles, contract package files, or the workflow itself. Pin checkout, pnpm setup, and Node setup actions by commit SHA consistent with the existing workflow. Use pnpm 10.11.1 and Node 24, run a frozen install, compilation, `pnpm lint:solidity`, formatting check, then Aderyn from `packages/contracts` with Markdown and SARIF reports.

- [ ] **Step 2: Preserve analyzer output on success or failure**

Upload the generated Aderyn Markdown and SARIF files using an artifact step that executes even when the scan fails.

- [ ] **Step 3: Validate workflow syntax and local equivalent commands**

Run: `pnpm install --frozen-lockfile && pnpm contracts:compile && pnpm lint:solidity && pnpm format:solidity:check`

Run the documented Aderyn command locally from `packages/contracts`.

Expected: YAML parses, the local commands pass, and Aderyn generates both reports.

### Task 4: Resolve all Aderyn findings and perform final verification

**Files:**
- Modify: only Solidity source or test files reported by Aderyn; `.github/workflows/solidity-quality.yml` only if report-command integration needs correction.

**Interfaces:**
- Consumes: Aderyn reports from Task 3.
- Produces: a finding-free Aderyn report, or only narrowly documented false-positive suppressions.

- [ ] **Step 1: Review the Aderyn report finding by finding**

Classify each finding as a source defect, tool false positive, or project-specific accepted design. Do not suppress a finding until its applicability has been checked against the relevant contract control flow and tests.

- [ ] **Step 2: Add regression coverage before each behavioral correction**

For each real security/logic defect, add a focused Hardhat test that fails against the prior behavior, run it to confirm the expected failure, then apply the minimal correction and rerun the focused test. For semantics-preserving cleanup, retain the existing test suite as the proof.

- [ ] **Step 3: Repair findings or add approved narrow suppressions**

Fix every applicable finding. If a detector is a verified false positive, use its narrowest supported source-level suppression with a concise reason that explains the invariant making it safe; do not disable a detector globally.

- [ ] **Step 4: Run final quality and behavioral verification**

Run: `pnpm lint:solidity && pnpm format:solidity:check && pnpm contracts:compile && pnpm contracts:test`

Run the same Aderyn report command used by CI from `packages/contracts`.

Expected: all commands exit 0; the report contains no unsuppressed findings; report artifacts are present for CI upload.

- [ ] **Step 5: Inspect the final change boundary**

Run: `git diff --check && git diff -- . ':!.codacy/**'`

Expected: no whitespace errors and no changes to the pre-existing Codacy files.

## Self-review

- Spec coverage: Tasks 1–4 cover the local hook, formatter, full Solhint cleanup, Aderyn CI, reviewed suppressions, and final contract verification.
- Type consistency: the plan names only command and configuration interfaces; root scripts are defined before later tasks consume them.
- Review focus coverage: Task 1 owns staged-file behavior; Task 3 owns full-repository CI behavior and retained reports.
- Proportion: the plan fixes the configuration and validation boundaries without prescribing individual source edits before the analyzers produce their findings.
