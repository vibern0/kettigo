# Solidity quality gates

## Intent

Make Solidity quality checks automatic before commits and in pull requests, then
bring the current contracts into compliance. This provides fast local feedback
for style issues and a repository-wide security-analysis gate in CI.

## Goals

- Run Solhint and Solidity formatting against staged Solidity files before a
  commit is created.
- Run Aderyn across `packages/contracts` in GitHub Actions.
- Fail the respective gate for actionable findings.
- Fix all findings discovered in the existing contracts, unless a narrow,
  documented suppression is demonstrably required.

## Non-goals

- Add fuzzing, formal verification, or general JavaScript/TypeScript linting.
- Change contract behavior except where a legitimate analyzer finding requires
  a safe correction.
- Alter the user’s existing Codacy configuration changes.

## Approaches considered

1. **Husky + lint-staged, with Aderyn CI (selected).** Version the local hook
   and run only staged Solidity files before each commit; run a full Aderyn
   scan in GitHub Actions. This gives quick local feedback without making
   ordinary commits scan the entire project.
2. **CI-only.** Avoids local hook dependencies but delays feedback until a
   pull request is opened.

## Design

- Add root development dependencies for Husky, lint-staged, Solhint, and a
  Solidity formatter; define `prepare`, `lint:solidity`, and
  `format:solidity:check` scripts.
- Add a versioned Husky pre-commit hook that delegates staged `.sol` files to
  lint-staged. Lint-staged runs the formatter in write mode and Solhint on the
  exact staged file list, restaging formatter output.
- Configure Solhint with a minimal, explicit project policy based on the
  Solidity compiler version and security rules. Prefer source fixes over rule
  disablements.
- Add an Aderyn workflow triggered on pull requests and direct pushes affecting
  Solidity-quality-gate files. It installs pinned project dependencies, builds
  the contracts, executes Aderyn, and uploads its report as a CI artifact.
- Treat suppressions as exceptions: an inline suppression must identify the
  specific detector and include a concise reason; broad or unreviewed global
  suppression is disallowed.
- First establish the configuration, then run and repair Solhint findings to a
  clean result, then Aderyn findings to a clean result. Re-run the complete
  quality and contract-test checks at the end.

## Acceptance criteria

- A staged poorly formatted or Solhint-invalid Solidity file causes the
  pre-commit gate to format/fail as appropriate.
- The existing Solidity code passes Solhint and the formatter check.
- Aderyn runs in CI with a reviewable report, and the existing contracts have
  no unsuppressed Aderyn findings.
- Existing contract compilation and tests continue to pass.
