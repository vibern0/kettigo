# Merkle + FHE integration progress — 6 November 2026

## Scoped resume: cleanup and SDK/evidence integration

The user resumed only the first two immediate next steps, using parallel
GPT-5.6 medium agents. [PR #52](https://github.com/vibern0/kettigo/pull/52)
remains a draft. Commit `9f3c214` had already preserved the six unfinished
cleanup files; the stopped checkpoint below predates that preservation commit
and the opening of the PR.

- **Pinned-reader cleanup:** fixed the missing runtime `getAddress` import,
  canonical fingerprint typing, and reserved-scope metadata overrides; removed
  retired source and split SDK/principal tests while retaining historical skip,
  dependency-order, object-key-order, and method-receiver checks.
- **SDK/evidence implementation:** added closed canonical receipt readers,
  operation-specific Safe log ownership, a historical proof adapter using the
  existing proof client, graph-bound conditional credit evidence, and a finite
  resolver producing the approved encoder's reference records. Real compiled
  graph tests cover deposits, admission, all prize-funding actions, historical
  checks, pinned principal, withdrawal batches, account/Morpho unwraps, Safe
  initial batches, and reference-free EOA actions.
- **Fresh combined verification:** 190 candidate tests passed with no failures,
  cancellations, or skips. Candidate and contracts TypeScript checks passed;
  formatting passed for the changed/new candidate files. Shared proof-client
  tests passed 26/26 and protocol tests passed 24/24 during this resume.
- **Steps 1–2 source/local accepted:** the independent combined review and its
  scoped re-review approved the result. Review found and verified fixes for
  cross-producer evidence substitution (including Safe/EOA downgrade) and
  surplus historical configuration overriding graph-derived proof scope. The
  resolver now binds producer action ID, kind, and owner before sensitive work
  and copies only the four permitted historical configuration fields.
- **Qualified local analysis:** the final candidate scan supplied 20 paths;
  Lizard and ESLint9 each routed 19 source/test files (`tsconfig.json` is not a
  source route). Lizard reported zero findings. ESLint9 reported 16 High,
  122 Warning, and 3 Info findings, plus two analyzer configuration warnings.
  Guarded canonical handle-map access, graph-bounded array indexes, test
  fixtures, propagated async errors, and mismatched test-framework rules were
  inspected and qualified locally by the reviewer; this is not a clean ESLint
  or Cloud pass. Codacy Cloud API access still returns `Unauthorized`; no Cloud
  false-positive disposition or clean release gate is claimed.
- **Whole-PR gate remains open:** a fresh local PR scan with the current user
  configuration returned 120 ESLint8 High findings, a TypeScript parser-services
  warning, and a Trivy timeout at the explicit 30-second tool bound. Semgrep,
  Jackson, and Markdownlint reported zero findings. These results cover the
  broader existing PR, not just the two resumed steps; they have not all been
  adjudicated in this resume. The candidate's separate Lizard/ESLint9 review
  does not replace this remaining whole-branch quality gate.

The resolver remains a data-only layer with injected canonical recovery/read
evidence. Wiring that authority into an executable, recovering workload driver
is a later step. No deployment, funding, financial signature, live run, or
application/browser exercise was resumed. The retention canary is untouched.

The next implementation work after these two steps is the executable finite
workload driver, followed by constrained Safe/browser attachment and concrete
deployment/run readiness. The original spending envelope remains unchanged.

## Historical stopped checkpoint

Status recorded at **2026-11-06 01:30 UTC**. Work was stopped at the user's
request. **The integration is not complete or ready for release.**

Plan: [production integration](../superpowers/plans/2026-11-04-merkle-fhe-production-integration.md).
The user approved the dedicated Cloudflare Worker + D1 approach.

## Repository checkpoint

- Branch: `codex/merkle-fhe-production-integration` in the original checkout.
- Last implementation commit: `27cd219` — pinned current-principal completion evidence.
- There are additional **uncommitted, not fully validated** candidate-runner changes,
  listed below. They were preserved rather than discarded or committed as complete.
- Final validation on local `main` has **not** happened. Remote `main` has not
  been updated by this integration work. No PR has been opened.
- The two pre-existing user edits in `.codacy/codacy.config.json` and
  `.codacy/codacy.config.baseline.json` were preserved, not staged. Both retain
  SHA-256 `10a73e5d2e2f469bf20753fd4af3f49598727fc1e954cc4856a39ccdb181ada4`.

## Completed implementation

| Area                                 | Completed work                                                                                                                                                                                                                                                     | Remaining acceptance boundary                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Membership and draws, Tasks 1–2      | Depth-32 membership tree, positive admission, generation/slot reuse, constant-size draw snapshots, historical individual checks, immutable awards, and prize/principal accounting fixes. Task-scoped reviews completed.                                            | Final explicit 4,096-account rerun and live candidate verification.                                       |
| Proof service, Task 3 source         | Worker + D1 archive, scoped historical proofs, canonical receipt/header ingestion, reorg handling, bounded requests, retained SQL restore/canonical replay tools, and independent RPC backfill tools. Source reviewed.                                             | Worker deployment, candidate namespace, real ingestion/monitoring, remote restore and backfill exercises. |
| App integration, Task 4 source       | Strict proof validation; check/claim/reinvest flows; admission and recovery states; existing-session reads; Safe operation persistence and locking; withdrawal access during archive outage. Task reviews completed.                                               | Clean exported build and actual browser end-to-end tests against the candidate.                           |
| Version routing, Task 6a             | Trusted legacy/candidate scopes, legacy default, query-ID selection, matching HTML/config, cache protection, scoped navigation, and candidate-only fresh-deposit onboarding switch. Existing storage keys and Safe lock retained. Independent review approved.     | Deployed-browser reload/back/forward, correct-origin behavior and live-position checks.                   |
| Migration tests, Task 6b             | Genuine archived v1 fixture with pinned provenance; actual old withdrawal to USDC followed by explicit new deposit/admission; eager-v1 versus checked-v2 winnings; interleaved settlement and rollback liability accounting. Review approved after two fix rounds. | Local contract evidence only; deployed UI rollback remains separate.                                      |
| Candidate runner foundations, Task 5 | Durable journal, EOA sender, Safe budget/wire/credential policies, strict static inputs, complete 375-action definition and journal binding, and closed EOA calldata encoder. Reviewed foundations completed.                                                      | The executable runner and browser attachment are not complete.                                            |
| SDK data foundation                  | Checksummed SDK inputs, strict input/proof shapes, bool/uint64 public-decrypt ABI matching, SDK-to-encoder deposit integration, malformed-response tests, four shared ABI events, and typed imports.                                                               | Whole SDK/evidence task is not yet independently accepted; remaining work below.                          |

Selected implementation checkpoints:

- `5f54aee`: complete workload semantics and verified journal binding.
- `c0b0eba`: completed version-routing regression coverage.
- `af53680`: reviewed calldata-encoder provenance/type corrections.
- `0ca22ca`, `967e32d`, `8610444`: migration implementation and reviewed fixes.
- `3659b9e`, `c465d04`, `60de33d`, `18621e1`: SDK data foundation and tests.
- `27cd219`: pinned-reader implementation, with further cleanup still uncommitted.

## Verification actually recorded

These are the latest recorded checks for the named source checkpoints, **not
proof that every file in the stopped working tree passes**.

- Web: **503 passing tests** (347 Node + 156 rendered) at the completed routing
  checkpoint; TypeScript and formatting passed.
- Contracts: **66 passing, 1 intentional pending** at the completed migration
  checkpoint. The pending test is the opt-in 4,096-account scenario; its final
  rerun is still required.
- Candidate runner: the controller independently ran **146 passing tests**,
  candidate and contracts TypeScript checks, formatting and diff checks against
  `27cd219`, before the additional stopped edits.
- Solidity static analysis: Aderyn **0 high / 0 low**, 9 units, 2,140 SLOC.
  This used solc 0.8.33/Prague; the actual Hardhat build uses
  0.8.28, optimizer 200, via-IR, Cancun. Solhint: 9 existing warnings, 0 errors.
- Local Codacy at `27cd219`: Lizard 0; ESLint reported 10 High, 27 Warning,
  1 Info plus two tool-configuration warnings. Several findings concern guarded
  map/index access, Node test/framework rules and propagated async errors;
  these are qualified local results, **not a clean ESLint or Cloud pass**.
- Codacy Cloud remained **Unauthorized/blocked**. The user explicitly instructed
  continuing and reporting this blocked gate; no Cloud false-positive disposition
  has been claimed.
- A pinned Playwright/Chromium toolchain was installed and passed a blank-page
  launch check. **The actual application browser flow has not been validated.**

## Deployment and spending status

The dedicated D1 database `kettigo-proof-v2-sepolia`
(`60fc25ef-1686-4c1a-b8b4-604456d00bdb`, WEUR) exists. Remote migrations
`0001_proof_archive.sql` and `0002_checkpoint_state.sql` were applied successfully.
A subsequent primary read confirmed **0 namespaces and 0 ingestion-state rows**.
This is schema preparation, not an operating proof service.

**No candidate contracts, proof Worker, or updated candidate app have been
deployed from this integration branch. No live financial signatures, funding,
or transaction broadcasts have started. The approved two-hour run clock has
not started.** Existing legacy deployments and the retention canary were not
used to fund or validate the new candidate.

The original approved run envelope remains in effect: 33 fresh participants,
maximum 600 transactions/UserOperations, 0.003 test ETH aggregate fees,
0.005 test ETH gross funding, 100 test USDC, and a fixed two-hour run.
A higher Safe fee policy was proposed because an unsigned Safe quote exceeded
that fee ceiling; **the higher policy was not approved or activated**.

The retention canary remains untouched. Its earliest permitted validation is
**2026-12-27 16:04:36 UTC**. No 60-day availability claim has been established.

## Work preserved but not accepted

The stopped pinned-reader cleanup changes these files:

- `packages/contracts/experiments/claim-lab/candidate/workload-completion.ts`
- `packages/contracts/experiments/claim-lab/candidate/workload-data.test.mjs`
- `packages/contracts/experiments/claim-lab/candidate/workload-data.ts`
- `packages/contracts/experiments/claim-lab/candidate/workload-principal.ts`
- New `packages/contracts/experiments/claim-lab/candidate/journal-values.d.mts`
- New `packages/contracts/experiments/claim-lab/candidate/workload-values.ts`

This cleanup addresses canonical object equality, strict skip-resolution states,
protected wrapper parameters, method receiver preservation, shared validators,
retired-code removal and regressions. **Its complete final test/analysis result
was not captured before the stop.** Do not treat the earlier 146-test result as
validation of these subsequent edits.

An ignored source-only snapshot, diff and SHA-256 manifest were saved under
`.superpowers/sdd/2026-11-04-merkle-fhe-production-integration/stopped-2026-11-06/`.
The plan's ignored `progress.md`, `controller-resume.md`, implementation reports
and review reports retain the detailed execution history. They are not staged.

## Still pending, in order

1. Verify and finish the stopped pinned-reader cleanup; retain its complete
   dependency and historical skip checks. Recheck the current code before reuse.
2. Complete the closed canonical event-to-reference resolver and historical proof
   bundle adapter. Cover withdrawal batch IDs, receipt/log identity, unwrap
   correlation, positive admission and exact draw-close log positions.
3. Complete graph-bound conditional credit evidence for EOA and Safe owned reads.
   The existing placeholder condition helper is not an accepted skip authority.
   Run the combined SDK/evidence task review after these pieces are complete.
4. Implement the executable finite workload driver: recovery of all saved intents,
   including terminals; conditional results in the existing journal; complete
   failure/timeout metrics; sanitized CLI; and measured journal-size gates.
5. Implement and test constrained Safe ACL prefixes and the private browser budget
   attachment, including genuine Confirm ordering, SDK wire equivalence and stop
   behavior. The public delegate/expiry handoff design still needs actual frozen-
   build preflight. Standalone access grants are outside the declared workload.
6. Prepare the final deployment manifest and concrete run readiness. Obtain any
   necessary amendment to the Safe fee envelope before financial execution.
7. Deploy/verify fresh Sepolia candidate contracts, configure/deploy the proof
   Worker and app, and run the bounded live lifecycle/capacity/recovery tests.
   Exercise actual retained restore, separate RPC backfill, failover, rollback,
   checkpoint lag and platform limits. Report assisted operation honestly.
8. Complete the whole-branch review, final validation **here on local main**,
   explicit 4,096-account scenario, sanitized build and deployment checks,
   Codacy PR gates/blocked-Cloud report, and then open the PR. No merge is authorized.

## Execution note

The work took too long. Repeated context-limited subagent handoffs, partial
implementation reports and subsequent correctness/quality rework fragmented the
runner integration. There is substantial reviewed source work, but the live
release and final-main verification are still unfinished. Resume from the
preserved checkpoint rather than restarting completed tasks or reviews.
