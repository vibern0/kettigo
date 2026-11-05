# Task 6a C — navigation, onboarding, and durable-fence integration brief

Status: read-only preparation only.  This file names the smallest intended C
surface after B exposes the public immutable `SELECTED_SCOPE` /
`readSelectedPoolScope` hydration contract.  It neither changes source nor
tests.  E65 remains the default; no candidate is activated.

## Exact routing boundary

Add one browser-safe `packages/web/src/lib/scope-navigation.ts` helper.  Its
input is a normal internal path or `URL` plus the selected scope ID; it retains
every unrelated query parameter and hash, removes/replaces only `savings`, and
returns a same-origin href.  `scopeHref(pathname, SELECTED_SCOPE.id)` is the
only normal-link constructor.  A second tiny helper handles a requested scope
switch with `window.location.assign(scopeHref(currentLocation, nextId))`; it
must not use the Next router.  Do not persist the selected ID in browser
storage: the URL is the complete selection record for reload and browser
history.

After B is accepted, bind the following to that helper:

- `components/Header.tsx`: logo and all three navigation links.
- `app/page.tsx`: the signed-in savings entry and results link.
- `app/savings/page.tsx`: any internal recovery/status handoff added by C;
  its current deposit/withdraw sheets are in-page actions and need no route
  transition.
- `app/draw/page.tsx`: the existing participation handoff should be an actual
  scoped Savings link, not plain instructional text; all existing draw actions
  remain in their selected document.
- `app/profile/page.tsx`: it has no current internal navigation, but future
  internal links in this page must use the same helper.  The C regression suite
  should render it under a selected scope to prevent a hidden direct href from
  being introduced.

Use ordinary scoped `href`s for same-scope navigation.  A scope picker, if
rendered in C, must use a literal anchor/document assignment only for a
different ID, preserving all unrelated query values.  Avoid `next/link` for
the switch itself because it is not an adequate lifecycle reset.  Back/forward
then reload the selected document and obtain the Worker-selected tuple again.

On an alternate-host candidate view, add a correct-origin absolute link to
`https://kettigo.xyz` labelled `Earlier savings` (or equivalent everyday
language).  Do not carry a candidate selector to that link and do not present
the link as an account/credential transfer.  Its only claim is that it opens
the earlier savings site at its real origin.  The link is not needed on the
correct origin.

## Onboarding guard: narrow placement

The only new gate is:

```ts
const freshDepositEnabled = SELECTED_SCOPE?.id !== "candidate-v2" ||
  SELECTED_SCOPE.onboardingEnabled;
```

Apply it at the fresh-deposit/new-position affordance in
`app/savings/page.tsx`: prevent opening `DepositSheet`, and re-check in
`reviewDeposit` and `prepareDeposit` so a stale click cannot prepare or send a
deposit.  Keep the candidate page usable when the value is false; do not
replace the page with an unavailable view and do not redirect it to E65.

`WithdrawalSheet`, its refresh, `claimWithdrawal`, `finalizeUnwrap`, balance
access recovery, stored pending unwrap/withdrawal discovery, and all existing
withdraw flows stay reachable.  `ParticipationPanel` must keep rendering the
v2 existing-pending admission path (`pendingAdmissionOf`, review/confirm) for
candidate positions already in progress; only the empty/fresh "add to savings"
path is suppressed.  It should never use the onboarding flag to hide a
positive pending admission or a previously funded member.

`draw/page.tsx` must still expose v2 prize history/checks and credited wallet
claim/reinvest (`claimPrize` and `claimPrizeToSavings`) with onboarding off.
The candidate flag is not a prize, history, read-access, withdrawal, or
recovery switch.  Legacy E65 and 9c behavior stays byte-for-byte equivalent in
effect: their registry value is false but it must not disable their deposit
controls.

Product strings introduced for the disabled fresh entry should be neutral
everyday copy, e.g. `New savings are not available right now.`  Do not use
implementation, network, or privacy terms in rendered copy.

## Durable state and async fence: no schema changes

Do not alter, suffix, migrate, duplicate, or clear any of these literal keys:

- `kettigo:pending-unwraps:<token>:<user>` and
  `kettigo:pending-withdrawals:<pool>:<user>` in `app/savings/page.tsx`;
  their real wrapper/pool account identities already separate retained scopes.
- `kettigo.prize-check-intent.v1` in `lib/prize-check-coordinator.ts`.
  Its pool/account/draw/operation validation remains authoritative.  A saved
  E65 intent opened from a 9c/candidate document must be displayed/recovered
  only as a foreign-scope state, must not auto-send, and must not become a
  second intent slot.
- `kettigo:pending-user-operation:v1:<chain>:<entryPoint>:<sender>` and
  `kettigo:pending-user-operation:<chain>:<entryPoint>:<sender>` in
  `lib/pending-operation-guard.ts`.  Keep one same-Safe fence across every
  selected route; no scope-dependent lock name, recovery exception, or
  parallel prepare/send path.
- `kettigo.zama-read-session.v1:<safe>`, `kettigo.passkey.v1`, and
  `kettigo:last-chunk-reload`.  They remain Safe/origin/UI state as currently
  defined, with no version dimension or cross-origin copy.
- `kettigo:actions`.  Preserve legacy activity entries; optional new display
  metadata cannot reinterpret an existing record or create a financial target.

Document navigation is the intended in-memory isolation boundary.  Any C
callback guard that survives until unload may compare the complete selected
tuple/pool in memory, but no `scope.id` is persisted merely for that purpose.

## Smallest expected touchlist after source grant

Source:

- New: `packages/web/src/lib/scope-navigation.ts`.
- Modify: `packages/web/src/components/Header.tsx`,
  `packages/web/src/app/page.tsx`, `packages/web/src/app/savings/page.tsx`,
  `packages/web/src/components/savings/ParticipationPanel.tsx`, and
  `packages/web/src/app/draw/page.tsx`.
- Modify `packages/web/src/app/profile/page.tsx` only if it needs a scoped
  navigation entry or an explicit alternate-origin earlier-savings link.  Do
  not touch `contracts.ts`, Worker tuple code, passkey metadata, session-key
  code, pending-operation code, or prize-intent schema in C.

Tests (new focused files where practical; extend existing fixture conventions
instead of moving financial tests):

- `packages/web/tests/scope-navigation.test.mjs`: default/selected link hrefs;
  preservation of ordinary queries and hash; replacement/removal of only
  `savings`; reload/back-forward URL behavior; switch calls document navigation
  and never the client router.
- Extend `packages/web/tests/savings-participation.test.tsx` and
  `packages/web/tests/savings-approval.test.mjs`: candidate onboarding false
  blocks only fresh deposit, while withdrawal, pending withdrawal recovery,
  existing/pending positive admission, and legacy deposit remain usable.
- Extend `packages/web/tests/draw-prize-history-*.test.tsx` and/or
  `draw-prize-credit-*.test.tsx`: disabled candidate onboarding retains history
  check, wallet claim, and add-to-savings action paths; legacy makes no v2
  behavior requests.
- Extend `packages/web/tests/prize-check-coordinator-recovery.test.mjs` plus
  `pending-operation-guard.test.mjs`: a retained cross-route E65 intent is
  read-only/non-auto-send under another selection, and the one Safe lock still
  rejects a concurrent scope action.
- Add a compact rendered navigation assertion for Header/home/Draw handoff
  (and Profile when applicable), including the correct absolute
  `https://kettigo.xyz` link only on the alternate origin.

No test should manufacture a pool by query address, depend on a storage
companion key, or simulate scope switching through a client-side global setter.

## Concrete questions to resolve at implementation time

1. B currently presents `SELECTED_SCOPE` as an immutable module export.  C
   needs confirmation of the exact public scope-ID type/export path so the
   helper does not duplicate it; no context/global setter is requested.
2. The current UI has no scope picker.  Should C expose selection controls now,
   or only make every existing route scope-preserving and reserve switching for
   explicit URL/alternate-origin links?  The latter is the smallest safe slice.
3. The required alternate-origin link needs a reliable origin signal.  C should
   use a trusted runtime-origin/config field supplied by A/B/Worker, not infer
   it from candidate ID or an arbitrary browser query.  If that signal is not
   already public, root must choose its minimal trusted source before C edits.
