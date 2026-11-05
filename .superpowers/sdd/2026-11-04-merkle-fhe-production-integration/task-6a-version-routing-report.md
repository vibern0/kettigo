# Task 6a version routing report

## Batch A — Worker-selected trusted scope (partial)

Status: completed local source slice only.  This is not activation, deployment,
browser verification, or completion of Task 6a.  The existing deployed E65
legacy scope remains the default.  No candidate address, proof namespace, live
configuration, Wrangler legacy configuration, cron, D1 binding, contract,
keeper, proof service, asset export, signing, funding, network, or credential
operation changed.

### Source and API boundary

Added `packages/web/worker/selected-pool-scope.ts`, a Worker/browser-safe pure
resolver and immutable tuple shape.  The only URL input is one `savings`
selector: omitted selects `legacy-e65`; malformed, blank, duplicate, unknown,
or unavailable values return no-bootstrap `400`.  The fixed Sepolia tuple has
the inventory pairings exactly:

- `legacy-e65`: pool `0xe65D6459a7Ce01315FbB0998C37233c6FeE3aB8b`, wrapper
  `0x6B26B258436bcCE719Be8F9B30F87FDFD9BdFA8a`.
- `legacy-9c`: pool `0x9c23E5f7143612dc1232FC643A57300291e0d719`, wrapper
  `0x3B4F71c77e288d92871Cda495891Cd42f543A3f5`.

Both remain `legacy1` with empty proof fields.  Addresses pass `getAddress()`
before emission.  `candidate-v2` is unavailable unless every explicit trusted
field validates: RPC URL, underlying token, wrapper, pool, proof URL,
namespace, and `true`/`false` onboarding value.  No candidate values were
supplied in source/configuration.  URL fields such as pool, RPC, proof, or
onboarding cannot alter a registry tuple.

`worker.ts` resolves once before the selected HTML/config response and writes
the selected tuple into both the inline parser-blocking bootstrap and
`/config.js?savings=...`; the scripts are byte-identical for the same request.
The legacy flat client fields are derived from the same tuple for B/C migration
compatibility.  Selected HTML and config have `Cache-Control: no-store`;
rewritten HTML drops stale content-length, ETag, and digest/integrity headers.
For known app HTML routes, conditional validators are stripped before the
assets binding fetch so a stale `304` cannot reuse an earlier bootstrap.  Static
assets retain their original validators and cache headers.  No config loader or
service worker was added.

Added candidate public declarations/env-example placeholders only:
`NEXT_PUBLIC_CANDIDATE_V2_RPC_URL`,
`NEXT_PUBLIC_CANDIDATE_V2_USDC_ADDRESS`,
`NEXT_PUBLIC_CANDIDATE_V2_CONFIDENTIAL_USDC_ADDRESS`,
`NEXT_PUBLIC_CANDIDATE_V2_CONFIDENTIAL_PRIZE_POOL_ADDRESS`,
`NEXT_PUBLIC_CANDIDATE_V2_PROOF_SERVICE_URL`,
`NEXT_PUBLIC_CANDIDATE_V2_PROOF_NAMESPACE`, and
`NEXT_PUBLIC_CANDIDATE_V2_ONBOARDING_ENABLED`.

### Tests and checks

New focused tests: `packages/web/tests/selected-pool-scope.test.mjs` and
`packages/web/tests/worker-version-routing.test.mjs`; updated bootstrap test:
`packages/web/tests/runtime-config-bootstrap.test.mjs`.

Commands run from repository root:

```sh
node --experimental-strip-types --import ./packages/keeper/src/register-ts-loader.mjs --test packages/web/tests/runtime-config-bootstrap.test.mjs packages/web/tests/selected-pool-scope.test.mjs packages/web/tests/worker-version-routing.test.mjs packages/web/tests/worker-schedule.test.mjs packages/web/tests/access-worker.test.mjs
pnpm --dir packages/web typecheck
pnpm exec prettier --check packages/web/worker.ts packages/web/worker/env.d.ts packages/web/worker/runtime-config-bootstrap.ts packages/web/worker/selected-pool-scope.ts packages/web/tests/runtime-config-bootstrap.test.mjs packages/web/tests/selected-pool-scope.test.mjs packages/web/tests/worker-version-routing.test.mjs
git diff --check
```

Results: 17 Node tests passed; web TypeScript check, owned-file formatting, and
diff check passed.  The known `MODULE_TYPELESS_PACKAGE_JSON` loader warning was
unchanged; no package-module migration was made.

The Worker tests cover default/pairing, selector failures and URL injection,
inline/config identity, no-store/rewritten-header removal, bare config E65,
static asset header preservation, invalid HTML selector fail-before-assets, and
conditional HTML validator stripping.  Existing access and scheduler suites
cover unchanged API and five-minute dispatcher behavior.

### Local quality evidence

Ran:

```sh
python3 .superpowers/sdd/2026-11-04-merkle-fhe-production-integration/scoped-codacy.py task-6a-batch-a-codacy-final.json packages/web/worker.ts packages/web/worker/env.d.ts packages/web/worker/runtime-config-bootstrap.ts packages/web/worker/selected-pool-scope.ts packages/web/tests/runtime-config-bootstrap.test.mjs packages/web/tests/selected-pool-scope.test.mjs packages/web/tests/worker-version-routing.test.mjs
```

Final artifact: `task-6a-batch-a-codacy-final2.json` (the prior
`task-6a-batch-a-codacy-final.json` was superseded after the final allowlist
readback).  Lizard and ESLint9 each routed
all 7 explicit source/test files.  Lizard reported zero findings after the
Worker route extraction.  ESLint9 reported 21 High and 27 Warning findings,
plus two existing tool-adapter configuration errors.  The High findings are
the project configuration treating Node 24 web globals (`URL`, `Request`,
`Response`) as undefined in Node Worker tests; one existing literal test-file
read; and two false positive unhandled-async reports on the pre-existing
try/catch access handlers.  Warnings require Vitest conventions even though
this repository deliberately runs Node `node:test` suites.  No source security
or complexity defect was identified.  Cloud Codacy remains Unauthorized and is
blocked, not passed.

### Remaining work

Batch B must add the browser `readSelectedPoolScope` hydration boundary and
make client module globals derive only from it, with clean empty-fallback SSR
matching neutral first client markup.  Batch C must preserve selector query
state through Header/home/page navigation, force document navigation on scope
switch, gate only fresh candidate onboarding, retain funded candidate paths,
and prove same-Safe durable-operation fencing.  One later actual built-browser
gate must cover hydration, both namespaces, reload/back-forward, cache behavior
and correct-origin distinction.  Run the normal full web suite only after A/B/C
stabilize; do not produce final assets before source freeze.

### Readback

Read back the scoped report, touched files, and exact tests after validation.
The two pre-existing user-owned `.codacy` configurations were neither edited
nor staged; their required hash remains outside this Batch A change.

## Batch B — atomic client-selected scope (partial)

Status: completed local client source slice only. This is not activation,
deployment, browser rollout verification, or completion of Task 6a. The E65
legacy scope remains the Worker default. No contract, keeper, proof ingestion,
network request, signing, funding, credential, deployment, or configuration
change was made.

### Source and API boundary

`packages/web/worker/selected-pool-scope.ts` now exposes
`validateSelectedPoolScope(value)`. It accepts only a complete fixed-11155111
tuple: all role addresses must be checksum-normalizable, nonzero, distinct,
and paired exactly for the retained E65/9c legacy IDs. Legacy tuples must stay
`legacy1` with empty proof fields and onboarding disabled. Candidate tuples
must be complete v2 tuples and cannot relabel either known legacy pool/wrapper
pair. `packages/web/src/lib/runtime-config.ts` exposes
`readSelectedPoolScope(runtimeConfig)` and `SELECTED_SCOPE`; injected browser
configuration is accepted only through that complete object. It never fills a
partial injected object from fallback values. The static literal fallback uses
only explicit `process.env.NEXT_PUBLIC_*` properties and the same validator;
absent or sanitized values select no scope.

`packages/web/src/lib/contracts.ts` derives addresses, chain, and RPC only from
`SELECTED_SCOPE`; unavailable scope produces empty, non-requesting values, not
a zero-address SDK target. `passkey-safe.ts` now uses that RPC binding instead
of a second snapshot. Draw mode/proof and the participation v2 guard also read
the immutable selected tuple. Existing module-scoped clients therefore receive
the same `RPC_URL` binding. `Providers` renders a neutral unavailable surface
on SSR and the first client render, and mounts Wagmi, query, wallet, and
financial children only after hydration with a valid scope.

Added `packages/web/tests/client-selected-scope.test.mjs`, covering complete
legacy acceptance, partial/mixed legacy rejection, candidate legacy-pair
relabel rejection, and no partial bootstrap/fallback mix. No navigation,
onboarding, durable storage key, Safe fence, or loader behavior changed; those
remain Batch C work.

### Tests and checks

Commands run from repository root:

```sh
node --experimental-strip-types --import ./packages/keeper/src/register-ts-loader.mjs --test packages/web/tests/runtime-config-bootstrap.test.mjs packages/web/tests/selected-pool-scope.test.mjs packages/web/tests/client-selected-scope.test.mjs packages/web/tests/worker-version-routing.test.mjs packages/web/tests/worker-schedule.test.mjs packages/web/tests/access-worker.test.mjs
pnpm --dir packages/web typecheck
pnpm exec prettier --check packages/web/worker/selected-pool-scope.ts packages/web/src/lib/runtime-config.ts packages/web/src/lib/contracts.ts packages/web/src/lib/passkey-safe.ts packages/web/src/components/draw/draw-page-utils.ts packages/web/src/components/savings/ParticipationPanel.tsx packages/web/src/app/providers.tsx packages/web/tests/client-selected-scope.test.mjs
git diff --check
python3 .superpowers/sdd/2026-11-04-merkle-fhe-production-integration/scoped-codacy.py task-6a-batch-b-codacy.json packages/web/worker/selected-pool-scope.ts packages/web/src/lib/runtime-config.ts packages/web/src/lib/contracts.ts packages/web/src/lib/passkey-safe.ts packages/web/src/components/draw/draw-page-utils.ts packages/web/src/components/savings/ParticipationPanel.tsx packages/web/tests/client-selected-scope.test.mjs
```

Result: 21 focused Node/Worker tests passed; web TypeScript, owned-file
Prettier, and diff checks passed. The existing `MODULE_TYPELESS_PACKAGE_JSON`
warning remains unchanged. The strict scoped Codacy artifact is
`.superpowers/sdd/2026-11-04-merkle-fhe-production-integration/task-6a-batch-b-codacy.json`:
both Lizard and ESLint9 routed all 8 explicit files; Lizard reported zero
findings. ESLint9 reported 30 High / 34 Warning / 132 Info plus 2 adapter
errors. The High entries are the known adapter configuration treating Next/JSX
and DOM/Worker globals as undefined, not a source defect; the additional React
style/performance findings apply existing provider conventions. Cloud Codacy is
Unauthorized and blocked, not passed. The two user-owned `.codacy` files were
not edited or staged and retain the required baseline hash.

### Remaining work

Batch C still owns document navigation/query preservation, candidate-only
fresh-deposit onboarding, durable same-Safe recovery fencing, and its
component/browser-facing tests. One later whole-6a built-browser gate must
validate rendered SSR/hydration, both scopes, reload/back-forward, cache, and
correct-origin behavior. Run the normal full web suite only after B+C are
stable; no final asset export is authorized.

## Batch B closure — strict validator and rendered hydration evidence

Status: B source closure completed locally at `a4987ca` plus the pending scoped
commit. This remains neither activation nor whole-6a completion.

The Worker now passes its constructed scope through the same
`validateSelectedPoolScope` used by the browser, so a candidate that reuses
either retained legacy wrapper or pool is unavailable before bootstrap. The
validator now checks raw legacy proof/onboarding fields before normalization.
Browser fallback applies only if the runtime bootstrap is entirely absent;
partial/invalid bootstrap does not fall back. An explicit v2 static mode with
an incomplete candidate stays unavailable rather than choosing legacy.

`Providers` now renders `Loading savings…` for SSR and first hydration, then
mounts financial providers only with a valid selected scope; a missing scope
becomes the nonfinancial unavailable surface after hydration. New
`packages/web/tests/providers-selected-scope.test.tsx` uses real
`renderToString`/`hydrateRoot` with narrow provider mocks to prove matching
first markup, no recoverable hydration error, no wallet mount before hydration,
valid post-hydration mount, and continued nonfinancial unavailable behavior.
The participation and five affected draw suites now exercise `SELECTED_SCOPE`
mode reads instead of the removed environment-mode production path.

Final commands run from repository root:

```sh
node --experimental-strip-types --import ./packages/keeper/src/register-ts-loader.mjs --test packages/web/tests/runtime-config-bootstrap.test.mjs packages/web/tests/selected-pool-scope.test.mjs packages/web/tests/client-selected-scope.test.mjs packages/web/tests/worker-version-routing.test.mjs packages/web/tests/worker-schedule.test.mjs packages/web/tests/access-worker.test.mjs
pnpm --dir packages/web exec vitest run --config vitest.config.mts tests/providers-selected-scope.test.tsx tests/savings-participation.test.tsx tests/draw-prize-proof-http.test.tsx tests/draw-prize-credit-review.test.tsx tests/draw-prize-credit-refresh.test.tsx tests/draw-prize-credit-ownership.test.tsx tests/draw-prize-history-scope.test.tsx
pnpm --dir packages/web typecheck
pnpm exec prettier --check packages/web/worker/selected-pool-scope.ts packages/web/src/lib/runtime-config.ts packages/web/src/lib/contracts.ts packages/web/src/lib/passkey-safe.ts packages/web/src/components/draw/draw-page-utils.ts packages/web/src/components/savings/ParticipationPanel.tsx packages/web/src/app/providers.tsx packages/web/tests/client-selected-scope.test.mjs packages/web/tests/selected-pool-scope.test.mjs packages/web/tests/providers-selected-scope.test.tsx packages/web/tests/savings-participation.test.tsx packages/web/tests/draw-prize-proof-http.test.tsx packages/web/tests/draw-prize-credit-review.test.tsx packages/web/tests/draw-prize-credit-refresh.test.tsx packages/web/tests/draw-prize-credit-ownership.test.tsx packages/web/tests/draw-prize-history-scope.test.tsx
git diff --check
python3 .superpowers/sdd/2026-11-04-merkle-fhe-production-integration/scoped-codacy.py task-6a-batch-b-closure-final-codacy.json packages/web/worker/selected-pool-scope.ts packages/web/src/lib/runtime-config.ts packages/web/src/lib/contracts.ts packages/web/src/lib/passkey-safe.ts packages/web/src/components/draw/draw-page-utils.ts packages/web/src/components/savings/ParticipationPanel.tsx packages/web/src/app/providers.tsx packages/web/tests/client-selected-scope.test.mjs packages/web/tests/selected-pool-scope.test.mjs packages/web/tests/providers-selected-scope.test.tsx packages/web/tests/savings-participation.test.tsx packages/web/tests/draw-prize-proof-http.test.tsx packages/web/tests/draw-prize-credit-review.test.tsx packages/web/tests/draw-prize-credit-refresh.test.tsx packages/web/tests/draw-prize-credit-ownership.test.tsx packages/web/tests/draw-prize-history-scope.test.tsx
```

Result: 25 Node/Worker and 53 rendered tests passed; typecheck, formatting,
and diff checks passed. Final artifact
`.superpowers/sdd/2026-11-04-merkle-fhe-production-integration/task-6a-batch-b-closure-final-codacy.json`
routed all 16 explicit paths through both Lizard and ESLint9. Lizard reported
zero findings. ESLint9 reported 55 High / 537 Warning / 458 Info plus two
adapter errors; these remain the known project adapter issues around Next JSX,
DOM/Worker globals, and incompatible test style rules, not a new source
defect. Cloud Codacy is Unauthorized and blocked, not passed. Read back this
report, changed source/tests, and final artifact before the scoped commit.

## Batch C — navigation, onboarding, and durable fences

Status: completed local source slice at base `58f3128`.  This is not
activation, deployment, final asset export, browser rollout, financial signing,
funding, or a claim that live positions were proved.  E65 remains the default.
No Worker tuple/registry, contracts, keeper, proof ingestion, SDK request,
credential, durable-key schema, deployment configuration, or `.codacy` user
configuration changed.

### Source and behavior boundary

Added `packages/web/src/lib/scope-navigation.ts`.  `scopeHref` preserves every
unrelated query value and the hash while replacing only `savings`; normal
Header, home, and Draw-to-Savings links use the selected immutable ID.  A
tested `switchDocumentScope` helper delegates to `location.assign`, rather
than a client router, for a future explicit scope switch.  No picker or global
scope setter was introduced.

On a candidate document served from an origin other than the fixed
`https://kettigo.xyz`, Header shows the absolute `Earlier savings` link to
that origin after hydration.  It carries no selector and makes no credential
portability claim.  The actual browser origin is the sole comparison input.

Fresh deposit is now fail-closed when no selected scope exists, or when the
selected ID is `candidate-v2` and its trusted onboarding flag is false.  The
gate is checked at the button, review, preparation, and prepared-send paths.
Legacy E65/9c deposits remain available despite their registry onboarding
value being false.  Candidate withdrawal, pending withdrawal/unwrap recovery,
balance access, prize check/history, wallet claim/reinvest, and positive
pending-admission review/confirm remain reachable.  No durable key was
changed: pending unwrap/withdrawal records retain wrapper/pool+account keys;
the literal prize-check intent, global same-Safe pending-operation fence,
read-session, passkey, chunk-reload, and Activity keys have no scope suffix,
copy, migration, or concurrency exception.

Several older rendered fixtures used the pre-B runtime shape.  They now supply
a complete legacy/candidate selected scope to exercise the same fail-closed
boundary, including the B `runtimeConfig(env, selectedPoolScope)` API.  No
production fallback/env-mode path was restored.

### Tests and checks

Focused red/green sequence:

```sh
node --experimental-strip-types --import ./packages/keeper/src/register-ts-loader.mjs --test packages/web/tests/scope-navigation.test.mjs
pnpm --dir packages/web exec vitest run --config vitest.config.mts tests/savings-participation.test.tsx
pnpm --dir packages/web exec vitest run --config vitest.config.mts tests/savings-participation.test.tsx tests/draw-prize-history-scope.test.tsx tests/draw-prize-history.test.tsx tests/draw-prize-credit-review.test.tsx tests/draw-prize-credit-refresh.test.tsx tests/draw-prize-credit-ownership.test.tsx
pnpm --dir packages/web exec vitest run --config vitest.config.mts tests/savings-access-activity.test.tsx tests/savings-access-review.test.tsx tests/celebration-flows.test.tsx tests/savings-participation.test.tsx
pnpm --dir packages/web exec vitest run --config vitest.config.mts tests/draw-prize-history-activity.test.tsx tests/draw-prize-history-immutable.test.tsx
pnpm --dir packages/web typecheck
pnpm --dir packages/web test
pnpm exec prettier --check <all Batch C source/test paths>
git diff --check
```

The new helper tests first failed for the absent module/export, then passed
(five Node cases).  The fresh-candidate-deposit test first failed because the
button was active, then passed after the narrow guard.  The focused rendered
sets passed 63, 51, and 22 tests respectively; the normal full web command
passed all 344 Node tests and 152 rendered tests.  TypeScript, Prettier, and
diff checks passed.  The existing `MODULE_TYPELESS_PACKAGE_JSON` loader and
Gelato deprecation warnings remain unchanged.

### Local quality evidence

Ran:

```sh
python3 .superpowers/sdd/2026-11-04-merkle-fhe-production-integration/scoped-codacy.py task-6a-batch-c-codacy.json <16 Batch C source/test paths>
```

Artifact: `task-6a-batch-c-codacy.json`.  Both Lizard and ESLint9 routed all
16 explicit paths.  Lizard reported nine findings and ESLint9 reported the
known broad React/Next adapter output (192 High, 882 Warning, 1544 Info), plus
two adapter configuration warnings: unavailable TypeScript parser services and
an unresolved Tailwind theme.  There are no Lizard findings in the new
`scope-navigation.ts` helper.  The apparent critical Savings file-NLOC finding
is not introduced by C: `git show 58f3128:packages/web/src/app/savings/page.tsx`
already has 1,265 physical lines, while formatter reflow in this workspace
produces 1,499/1,357 Lizard NLOC against the 1,150 threshold.  Its listed
Savings/Draw/Header functions and the Draw ref/effect findings are accepted
baseline code; C added only narrow guards/link values and did not restructure
the financial parent to chase analyzer output.  Cloud Codacy remains
Unauthorized and blocked, not passed.

The user-owned `.codacy/codacy.config.json` and
`.codacy/codacy.config.baseline.json` remained unstaged and retain SHA-256
`10a73e5d2e2f469bf20753fd4af3f49598727fc1e954cc4856a39ccdb181ada4`.

### Remaining whole-6a gate

Run the later clean built-browser verification after source freeze: real Worker
HTML/config bootstrap, both configured namespaces, reload/back-forward,
cache/no-store behavior, alternate-origin earlier-savings presentation, and
actual live-position safety.  No local suite proves live balances or a
deployment.
