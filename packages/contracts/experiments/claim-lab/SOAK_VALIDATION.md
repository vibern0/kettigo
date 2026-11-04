# Sustained processing and 60-day recovery validation

The 24-hour experiment finished on **2026-10-29 at 16:04:39 UTC** with all
48 load cycles completed. The outcome is **completed with interruptions**:
conservation and recovery passed at the tested workload; uninterrupted
availability did not. Maximum processing capacity remains unmeasured.
No contracts were deployed or application addresses changed.
The runner attaches to the existing ReusableMerkleProbe at
`0xAdB8F835E565aC7e71d2DF6cFBd0FC003fa22C27` on Ethereum Sepolia.

## Final result

The immutable window was 2026-10-28T16:04:38.978Z through
2026-10-29T16:04:39.131Z: 24 hours plus 153 ms. All scheduled work eventually
finished, with four cycles starting over five minutes late and several stopped
intervals. This was not an uninterrupted 24-hour pass.

| Evidence | Result |
| --- | --- |
| Load cycles | 48: one at concurrency 2, one at 4, 46 at 8 |
| Independent live wallets | 8, repeatedly reusing slots 0..7 |
| Unique deposits / admissions / exits / prize checks | 374 of each |
| Confirmed transactions, including setup/canary | 1,635; zero mined reverts |
| Outstanding work at completion | Zero transactions and client operations |
| Prize accounting | 528 units paid across load draws; 11-unit canary unclaimed |
| Principal and backing | All cycle-end token/owner/backing checks passed |
| Actual transaction fees | 0.0004631114392 Sepolia ETH, below 0.0015 cap |
| Gas funding transfers | 0.00064 Sepolia ETH, equal to fixed cap |
| Maximum scheduling lag | 24 minutes 43.015 seconds |
| Final local regression | 124 passing; one opt-in stress test skipped |

Successful-attempt latencies, including guarded retries but excluding failed
attempts and stopped intervals:

| Operation | Samples | p50 | p95 | p99 |
| --- | ---: | ---: | ---: | ---: |
| Transaction confirmation | 1,590 | 10.424 s | 21.408 s | 24.066 s |
| Public admission proof | 388 | 12.853 s | 22.071 s | 23.658 s |
| Cold award decryption | 378 | 10.278 s | 15.621 s | 17.581 s |
| Cold balance decryption | 384 | 2.808 s | 7.985 s | 8.231 s |
| Archive reconstruction/query | 50 | 0.389 s | 0.794 s | 1.544 s |

These sample counts include repeated labels after recovery; unique completed
actions are the transaction-based counts above. The 41 ordinary eight-user
cycles without a stopped/recovery interval took 116.295–155.149 seconds,
median 134.200 seconds and p95 145.913 seconds. Offering eight users every
30 minutes did not saturate the service and cannot establish maximum throughput.
Live indices were only 0..7; larger indices can require more left-prefix FHE
additions, so this does not validate the worst position of the depth-32 tree.

There were 16 recorded failed operations within the load window, plus a send
incident whose original error was masked. Eight were actual relayer/gateway
readiness timeouts after 91.762–92.715 seconds with HTTP 503. All recovered, but
successful-only percentiles must not hide them. The remaining failures involved
RPC indexing/visibility and SDK permission views; guarded retries recovered 65
public-ACL operations and 38 user-ACL operations, at most four retries each.
No HTTP 429 was observed. Shared-owner nonce interference also occurred during
setup. Detailed incidents remain below and in the saved evidence.

Machine-readable evidence: [final summary](soak-final-summary.json),
[final audit](soak-final-audit.json), [full run state](soak-results.json),
and [sanitized events](soak-events.jsonl).

## Final archive audit and integration limits

An independent empty SQLite archive rebuilt its derived tables from **25,890
retained event payloads and canonical positions**. It reconstructed **382
proofs**, authenticated every load/canary root against onchain state, confirmed
all **374** load checks are settled, and confirmed all **eight** canary checks
are false. The saved canary paths match the independently rebuilt paths exactly.
The pool runtime hash matches its baseline and active participant count is zero.
This audit made no signatures, transactions or ciphertext decryptions.

An attempted deployment-to-present replay from the configured RPC failed with
code **4444**, `pruned history unavailable`. Reducing the range did not solve it;
single-block queries at known event blocks 12007448/49/51/52 also failed.
Recent logs and current claim flags remained available. The successful rebuild
therefore proves recovery from retained logs, not recovery after losing every
archive copy. Durable event backups and a verified historical-RPC fallback are
required before integration. This RPC result says nothing about ciphertext TTL.

Other integration requirements established by this run are confirmed-block
permission reads with narrow bounded retries, exact signed-transaction recovery,
first-error preservation, and a dedicated keeper/deployment signer. Service
readiness failure must remain a visible pending/recovery condition: admission
delay can delay a depositor's eligibility. Neither a broad retry of genuine
permission denials nor silently extending timeouts is justified by these tests.

The remaining capacity work is a separately bounded high-concurrency test with
many distinct active users and worst-position proofs, followed by an uninterrupted
run of the hardened tooling. This experiment does not establish unlimited-user
live capacity or production readiness, and no further funded run was started.
Real 60-day ciphertext recovery remains pending until 2026-12-27T16:04:36Z.

## What can be established now

[LongHorizon.test.ts](test/LongHorizon.test.ts) passes two tests. One reconstructs
the same historical claims after restart and independent cold event replay.
The other advances through62 daily draws and63 simulated days, including60
unattended rounds and5,270,398 seconds of user inactivity. After full exit,
slot reuse, rejoining, restart and cold reconstruction, all122 entitlements
settle exactly once:336 prize units paid,7 unallocated reserve units retained,
and all principal returned. Wrong account/generation/path/round and replay fail.

This verifies contract state/history behavior with the local FHE mock. It does
not make real ciphertexts sixty days old or validate a60-day service guarantee.

The cache-free live preflight decrypted the previous research award created in
block12007455. Its age at the observed block was **69,276 seconds (19.24 hours)**.
The result11 matched the known award. A new SDK instance with **new MemoryStorage**
made an observed POST202 and GET200 to the relayer. This ciphertext had been
accessed before; it is a warm-history observation, not an untouched-retention test.

## Why a fresh request matters

SDK3.6.0 can return cached plaintext before contacting the relayer. The exported
`memoryStorage` is a singleton; another SDK sharing it does not establish cold
retrieval. This runner constructs a new MemoryStorage and fresh SDK credentials
for each cold award/balance measurement and verifies a new successful HTTP POST
for that exact operation label. Only allowlisted route, method, status and timing
are logged; URLs, queries, headers, payloads and credentials are omitted.

Sources: [SDK decryption cache](https://github.com/zama-ai/sdk/blob/v3.6.0/packages/sdk/src/services/decryption-service.ts),
[storage implementation](https://github.com/zama-ai/sdk/blob/v3.6.0/packages/sdk/src/storage/memory-storage.ts),
[Node runtime](https://github.com/zama-ai/sdk/blob/v3.6.0/packages/sdk/src/node/config.ts).
The global fetch wrapper is instrumentation for the pinned runtime, not a
documented SDK fetch-injection option. Public admission proofs are measured
separately from fresh authorized user decryptions.

## Real60-day acceptance

The runner creates an eight-user funded draw spanning indices0..7, records its
canonical block timestamps and complete old paths, then withdraws principal and
reuses slots. All eight claims stay untouched for the future day60 test. Using
mixed/rightmost positions matters: those claims actually consume old left-prefix
sum handles, whereas index0 alone has no nonempty prefix.

At actual age>=60days, acceptance requires:

1. Restore/rebuild the archive independently and authenticate old paths against
   saved onchain roots and the recorded chain/pool namespace.
2. Submit **new historical claim transactions** using old balances, ticket and
   necessary prefix handles, with no current-registration requirement.
3. Cold-decrypt the newly computed awards with new credentials and observed
   relayer requests; check actual private token deltas and prize conservation.
4. Keep an untouched cohort distinct from any periodically decrypted cohort, so
   a hypothetical refresh-on-access mechanism cannot masquerade as retention.

Canary draw **2** is saved for eight users. Its conservative creation timestamp
is 2026-10-28T16:04:36Z; the earliest real 60-day test is
**2026-12-27T16:04:36Z**. All eight principals exited and claims remain untouched.
The paths and metadata appear in `retentionCanary` in
[the live status](soak-results.json). Keep the ignored
`cache/soak/wallets.json` securely available for the later authorized decryptions;
archiving the worktree does not preserve ignored files automatically. No60-day
result or SLA is asserted before the real elapsed-time test succeeds.

Zama stores actual ciphertext material offchain, while our archive stores
hashes/handles and history. Rebuilding the latter does not restore the former.
We found no managed-Sepolia60-day retention guarantee in the reviewed primary
documentation. Self-hosted relayer request-record cleanup settings are not a
ciphertext lifetime. Sources: [FHE handles](https://docs.zama.org/protocol/protocol/overview/library),
[coprocessor storage](https://docs.zama.org/protocol/protocol/overview/coprocessor),
[relayer configuration](https://github.com/zama-ai/fhevm/blob/11d9237d9577d1082927af5b6c90d9156fd317dd/relayer/docs/SELF_HOSTING.md).

## Live soak design and controls

The intended workload is24hours,48 load cycles every30minutes, plus the retained
canary draw. User concurrency ramps2,4,8. Each round actually deposits, proves
positive admission, funds/closes, exits, checks prizes and cold-decrypts results.
All user token balances, sponsor balance, prize totals, principal return and
underlying backing are checked. Gas sponsorship uses at most0.00008ETH per
research wallet,0.00064ETH aggregate. Transaction fees are capped at0.0015ETH;
fixed gas price100000wei; at most3500 transactions. These are Sepolia test funds.

Signed hashes/nonces and maximum fee reservations are persisted before broadcast.
Uncertain sends reconcile using the exact signed raw transaction. Tests cover
budget arithmetic, private-cache orphan recovery, exclusive single-writer lease,
atomic state replacement, nonce monotonicity, and draining unfinished work even
if the launch deadline elapsed. Each signer owns its nonce sequence. Actual
receipt fees, including mined failures, remain counted. Caps never increase
automatically. HTTP429 starts cooldown respecting numeric Retry-After.

Eight participants are real separately funded research wallets. This measures
the chosen workload; it is not a thousands-wallet live stress test or proof of
saturation capacity. Report observed throughput, p50/p95/p99 readiness latency,
failures, incomplete work and backlog drain. Operator-internal coprocessor queue
depth is not visible here; client outstanding operations and HTTP polls are proxies.

## Startup findings and corrections

- The RPC returned an old pending nonce immediately after a successful broadcast.
  A second signed send reused that nonce and was rejected. A regression test now
  makes allocation take the maximum of RPC state and saved signed nonces.
- The existing owner has EIP-7702 delegation and its txpool permits only one
  pending transaction. Its calls now wait for a receipt before another owner
  send. Independent user wallets submit their own admissions/checks concurrently;
  one isolated research wallet sponsors token setup/prizes. After initial gas
  funding, only draw closure needs the shared owner.
- Another canonical transaction from the shared owner consumed a nonce while our
  saved signed attempt remained unmined. We verified the distinct canonical hash,
  sender/nonce, different intent and absent original hash before retiring the
  unexecutable attempt. Its original record/raw file are retained as abandoned
  history, with zero onchain fee. No blind higher-fee replacement was sent.

These are signer/RPC operational findings, not measured FHE saturation. The
reduced48-cycle schedule keeps user-paid operations within fixed wallet funding.
The original96-cycle ceiling was reduced, not raised. Shared-owner interference
remains a reason to prefer a dedicated deployment owner/keeper for later work.

The initial public-decryption failures also proved to be a client/RPC snapshot
problem: a latest-state getter returned an all-zero marker immediately after a
confirmed deposit. Error instrumentation showed `chainId0, expected11155111` for
that zero handle, before any public-decryption HTTP request. The receipt and an
explicit read at its block both contained the correct nonzero marker. Admission
now decodes the confirmed receipt's emitter/account-bound event directly; award
and balance reads use confirmed transaction block snapshots. Regression tests
reject missing/wrong-emitter/wrong-account/zero-marker events. Blind retries of
the zero handle were removed; their diagnostic records remain in the event log.
These failures must not be reported as service throttling or coprocessor backlog.

The log RPC also lagged the confirmed chain by one block during the first load
cycle. Archive replay now stops at the frozen draw's confirmed closure block;
explicit RPC head/header indexing errors receive bounded retries. A regression
test distinguishes these from integrity errors, which must still stop the run.
The interrupted cycle resumed and passed conservation; its original error remains
in the evidence. This observation does not establish coprocessor congestion.

## Observed checkpoint, 2026-10-28T16:12Z

The runner is alive. Its immutable load window is
**2026-10-28T16:04:38.978Z through 2026-10-29T16:04:38.978Z**
(Lisbon local time is UTC on these dates). One of 48 load cycles has completed:
two users in draw 3, with principal return, prize total 11, all eight wallet
balances, sponsor/owner accounting and underlying backing verified. Across
setup, the canary and load work, **53 transactions confirmed, zero reverted,
zero pending**. Actual fees are **0.0000120226586 Sepolia ETH**; wallet gas
funding totals **0.00064 Sepolia ETH**, its full fixed allowance.

Four- and eight-user load cycles have not yet completed. Current latency samples
are too few for a capacity conclusion, and cycle 0 includes a diagnosis/recovery
pause. The status reporter tracks completed scheduled cycles and scheduling lag;
elapsed wall time alone is insufficient to call the coverage complete. This is
an initial successful checkpoint, not a completed soak or evidence of unlimited
live capacity.

Validation after the final tooling fixes: **107 research tests passing, one
opt-in stress test pending; 34 production tests passing**. Strict TypeScript
checks for the driver and its helpers passed. An independent review found no
additional major actionable issues. These checks do not replace live results.

## Recovery checkpoint, 2026-10-28T16:46Z

Cycle 1 (four users) stopped at 16:35Z after all four deposits confirmed in
block 12013546. One SDK public-proof preflight reported that its exact receipt
marker was not permitted; the other three proofs succeeded. No admission
transaction was sent for this cycle before the stop, and no transaction was
pending or reverted: 57 confirmed, fees 0.0000133374094 Sepolia ETH.

A read-only investigation at 16:44:55Z verified the saved receipt's canonical
block hash and queried the executor's ACL
`0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D`. The failed marker was permitted
both **at the deposit block** and at latest. The SDK source performs its own
latest-state ACL read before the relayer request. No failed request reached the
relayer. This is consistent with a stale latest-state RPC permission view;
the precise backend response at failure time was not captured.

The research runner now verifies permission at the confirmed deposit block
before attempting a public proof. Only the exact handle-specific SDK ACL
mismatch can retry, for six attempts with 1/2/4/8/16-second waits. An actual
confirmed-block denial, unrelated error or persistent mismatch still stops the
run; this does not grant permissions or bypass SDK checks. Retry events are
saved. Four new regression tests cover recovery, denied permission, unrelated
errors and the bound; the focused 10-test suite and strict typecheck passed.

The same saved run resumed, with its original clock, fee/funding caps and
retention canary preserved. All four public proofs succeeded on resumption;
the cycle remains in progress at this checkpoint. This interruption is part of
the reliability evidence. Repeated successful proof measurements after resume
are **attempt samples**, not additional unique completed admissions; unique
admissions/checks are determined by confirmed transaction labels. The status
reporter now exposes those unique completed load actions separately and labels
latency samples as attempts. The full updated research suite passed:
**111 passing, one opt-in stress test pending**. Production sources were unchanged.

At **16:47:44Z**, cycle 1 completed with all four users exited and prize checks
settled; awards sum to 11 and all private token/owner/underlying balances match.
There are now **71 confirmed transactions, zero mined reverts, zero pending**;
actual fees **0.000017053836 Sepolia ETH**. Load cycles 0 and 1 account for six
unique deposits, six admissions, six exits and six prize checks. The four-user
cycle's 785,065 ms includes the stopped/recovery interval, not continuous service
latency. The eight-user load stage is still pending. The resumed run remains
active under its original stop time; no canary claims or additional funding
occurred during recovery.

## Eight-user recovery checkpoint, 2026-10-28T17:42Z

Cycle 2 reached eight concurrent users, all eight deposits confirmed, then the
confirmed-block ACL read for user 0 failed with RPC `-32001`,
`block not found: 0xb7507f` (block 12013695). Seven public proofs completed;
two recovered the previously guarded latest-state ACL mismatch with one retry
each. The fatal read failed before a relayer request. No cycle-2 admissions
were sent before stopping. There were 79 confirmed transactions, zero mined
reverts, zero pending and fees 0.0000196833336 Sepolia ETH.

At 17:41:56Z, read-only checks verified the original deposit receipt and block
hash are still canonical and the marker is permitted at that block and latest.
The bounded RPC indexing handler now also recognizes this exact code/message
shape. A regression failed with the observed response before the fix and
passed after; unrelated `-32001` errors remain fatal. Eight focused readiness
tests and the strict driver typecheck passed. No retries change block tags,
permissions, transaction nonces or budgets.

The same run resumed at 17:42Z without new funding or redeployment. Its original
stop time remains fixed. The interruption delays the next scheduled cycle and
must count against continuous coverage; completion of eventual work cannot
erase the gap. The eight-user load cycle is not yet complete at this checkpoint.
No saturation or 24-hour availability conclusion follows from this run so far.

At **17:44:04Z**, the first eight-user load cycle completed: all eight
withdrawals and prize checks settled, cold award decryptions total 11, and all
token/owner/underlying balance checks passed. There were **105 confirmed
transactions, zero mined reverts, zero pending**, fees
**0.0000267442896 Sepolia ETH**. Load totals are 14 unique deposits, admissions,
exits and prize checks each. The cycle's 2,365,910 ms includes its approximately
37-minute stopped interval. Cycle 3 started at 17:44:04Z, about 9 minutes 26
seconds after its scheduled time, so complete on-time coverage is already
unachievable for this run. It remains useful for recovery and repeated bounded
workload evidence; it must not be described as an uninterrupted 24-hour pass.
The process is alive and continuing; all eight retention claims remain untouched.

## Healthy checkpoint, 2026-10-28T18:43Z

After 2.65 elapsed hours, six of 48 load cycles are complete, including four
eight-user cycles. The last three eight-user cycles completed in 131.766,
134.486 and 140.477 seconds without further fatal errors. There are 207
confirmed transactions, zero mined reverts, zero pending and zero outstanding
client operations; 38 unique deposits, admissions, exits and prize checks each.
The latest conservation check passed at 18:36:59Z. Fees total
0.000055815666 Sepolia ETH; gas funding remains at its original 0.00064 cap.
Observed successful-attempt p95 latencies: transaction confirmation 23.287 s,
public admission proof 21.554 s, cold award decryption 15.424 s, cold balance
decryption 7.892 s. No observed HTTP 429 responses. The process is alive and
waiting for its next scheduled cycle. The earlier interrupted coverage and one
late cycle remain recorded; this is bounded-workload evidence only. Canary
metadata is unchanged and no retention claim was submitted.

At **19:45Z** (3.68 elapsed hours), eight load cycles are complete, six with
eight users: 275 confirmed transactions, zero mined reverts/pending/outstanding,
and 54 unique deposits/admissions/exits/prize checks each. Conservation passed
at 19:36:51Z. The latest cycles took 134.717 and 132.994 seconds. Guarded ACL
view mismatches recovered within the existing bound (at most three retries);
no new fatal errors or HTTP 429s occurred. Successful-attempt p95 timings are
22.603 s for confirmations, 21.554 s for admission proofs, 15.360 s for cold
awards and 7.892 s for cold balances. Fees are 0.0000751965916 Sepolia ETH,
with funding unchanged. The original coverage gap, late cycle, caps, stop time
and untouched retention cohort remain preserved. No intervention was needed.

At **20:46Z** (4.69 elapsed hours), ten load cycles are complete, eight at
eight-user concurrency. All 343 transactions confirmed with zero mined reverts,
pending transactions or outstanding client operations. There are 70 unique
completed deposits, admissions, exits and prize checks each; conservation passed
at 20:36:51Z. The two latest cycles took 122.580 and 132.787 seconds. Guarded
ACL retries recovered within their original bound, with no new fatal errors or
HTTP 429s. Successful-attempt p95: confirmations 22.044 s, admission proofs
21.554 s, cold awards 15.316 s, cold balances 7.828 s. Fees total
0.000094577508 Sepolia ETH. The process, original caps/clock and untouched
canary remain intact; the earlier coverage gap remains unresolved by design.

## User-decryption recovery checkpoint, 2026-10-28T21:51Z

Cycle 10 (draw 13) completed all eight prize-check transactions but stopped
during cold award reads at 21:06:53Z. The SDK rejected user grants for users
1/3 and contract grants for users 2/7 before their relayer requests; the other
four award decryptions succeeded. The ledger has 377 confirmed transactions,
zero mined reverts/pending, 78 unique deposits/admissions/exits/prize checks each,
and fees 0.0001042679664 Sepolia ETH. Cycle 10's full conservation check had
not completed, so it remains unfinished despite all claim transactions mining.

Read-only checks at 21:49:13Z verified all four saved claim receipts and block
hashes are canonical. All four exact award handles have both user and contract
`persistAllowed` grants **at claim block 12014901** and at latest. As with
public proofs, SDK source checks latest-state ACL views before requesting
decryption. This is consistent with stale RPC permission reads; the original
backend responses were not directly captured.

Cold award/token/owner reads now require both grants at their confirmed snapshot
before an exact user/account/contract/handle-specific SDK permission mismatch
can retry. Six attempts and 1/2/4/8/16-second waits remain the bound. A genuine
confirmed-block denial or unrelated error is fatal. Each attempt uses a fresh
SDK and MemoryStorage, still requiring an observed successful relayer POST.
No permissions are granted or bypassed, and no claim transaction is duplicated.
The new regression exhibited the failure before the retry fix; all 12 focused
readiness tests and strict driver typechecking passed afterward.

The original run resumed at 21:50:33Z with no new funding or deployment, preserving
the original clock, caps, failures and untouched canary. The roughly 44-minute
interruption adds another coverage gap. This evidence does not establish
uninterrupted availability or maximum coprocessor capacity.

At **21:51:06Z**, cycle 10 completed without additional onchain transactions:
all eight cold awards sum to 11 and every token/owner/backing check passed.
Its 2,787,180 ms includes the stopped interval. Cycle 11 began immediately,
approximately 16 minutes 27 seconds late. Eleven cycles are now complete;
the ledger still has 377 confirmed transactions, zero mined reverts and fees
0.0001042679664 Sepolia ETH. The process is alive, continuing the same run;
the eight retention claims remain untouched.

The full updated research regression suite finished with **116 passing, one
opt-in stress test pending**. Strict TypeScript and status-script syntax checks
also passed. Production contracts and application addresses were unchanged.

At **22:43Z** (6.65 elapsed hours), fourteen load cycles are complete, twelve
at eight-user concurrency. All 479 transactions confirmed with zero mined
reverts/pending/outstanding; 102 unique deposits/admissions/exits/prize checks
each, with conservation last verified at 22:36:52Z. The three cycles after
recovery took 141.376, 122.586 and 133.884 seconds. One public ACL mismatch
recovered with a single guarded retry; no user-ACL retries, new fatal errors
or HTTP 429s occurred. Successful-attempt p95: confirmations 20.497 s, admission
proofs 21.554 s, cold awards 15.360 s, cold balances 7.905 s. Fees total
0.0001333393584 Sepolia ETH. The process is alive, original limits and canary
are intact, and both late cycles and all earlier interruptions remain recorded.

## Withdrawal reconciliation checkpoint, 2026-10-28T23:50Z

Cycle 14 closed draw 17, then stopped at 23:06:02Z while reconciling user 6's
exit. Immediately after broadcast, `getTransaction(savedHash)` returned null;
the runner's exact rebroadcast failed with RPC `-32000`, `already known`.
Seven other withdrawals confirmed. The saved ledger had 504 confirmed
transactions, zero mined reverts, and one uncertain transaction, not a proven
withdrawal failure. Fees recorded before reconciliation were
0.0001412508406 Sepolia ETH.

At 23:48:52Z, read-only recovery found the exact saved hash, sender and nonce
53, with successful receipt in canonical block 12015498. No alternate nonce,
replacement transaction or additional funding was needed. Reconciliation now
tolerates only the exact already-known response to that saved raw transaction,
then requires hash-matching lookup and the existing sender/nonce/receipt checks.
Missing visibility gets at most six polls with 1/2/4/8/16-second waits; unrelated
send errors, a different hash, or persistent invisibility remain fatal.

The observed failure was reproduced by a regression before the fix. All 74
soak tooling tests, strict driver typechecking and reporter syntax checks pass.
The original run resumed at 23:49:39Z; the saved exit reconciled successfully
and its actual fee was counted once. Cycle 14 remains in progress at this
checkpoint. This approximately 44-minute interruption adds another coverage
gap. Contracts, clocks, fee/funding caps and all eight retention claims are
unchanged. This is transaction/RPC recovery evidence, not FHE saturation.

At **23:50:21Z**, cycle 14 completed: eight award decryptions total 11, all
principal/token/owner/backing checks passed, and no withdrawal transaction was
repeated under another hash. Fifteen load cycles are complete, accounting for
110 unique deposits, admissions, exits and prize checks each. The checkpoint
has 513 confirmed transactions, zero mined reverts/pending, actual fees
0.0001430298088 Sepolia ETH. Cycle 15 started approximately 15 minutes 42
seconds late; the original schedule and coverage gaps remain preserved. The
same process continues under unchanged limits, with the retention draw intact.

At **2026-10-29T00:43Z** (8.65 elapsed hours), eighteen load cycles are complete,
sixteen with eight users. All 615 transactions confirmed, with zero mined
reverts/pending/outstanding and 134 unique deposits/admissions/exits/prize
checks each. Conservation passed at 00:36:59Z. The latest three cycles took
127.772, 135.124 and 137.920 seconds. A user-ACL mismatch in cycle 16 recovered
with one guarded retry; no further fatal errors or HTTP 429s occurred.
Successful-attempt p95: confirmations 20.605 s, admission proofs 21.582 s,
cold awards 15.500 s, cold balances 8.034 s. Fees total 0.0001721011712 Sepolia
ETH. The process is alive under its original caps/clock, with the canary intact.
All three late cycles and previous coverage interruptions remain recorded;
this remains bounded-workload evidence, not continuous availability or saturation.

At **01:45Z** (9.68 elapsed hours), twenty load cycles are complete, eighteen
with eight users: 683 confirmed transactions, zero mined reverts/pending/
outstanding, and 150 unique deposits/admissions/exits/prize checks each.
Conservation passed at 01:36:36Z; latest cycles took 119.342 and 117.459 s.
No new fatal errors, user-ACL retries or HTTP 429s occurred. Successful-attempt
p95: confirmations 20.291 s, admission proofs 21.554 s, cold awards 15.473 s,
cold balances 7.990 s. Fees total 0.0001914821024 Sepolia ETH. The process is
alive; original caps, stop time, canary and all earlier coverage gaps are intact.

At **02:52Z** (10.79 elapsed hours), twenty-two load cycles are complete,
twenty at eight-user concurrency: 751 confirmed transactions, zero mined
reverts/pending/outstanding, and 166 unique deposits/admissions/exits/prize
checks each. Conservation passed at 02:36:58Z; latest cycles took 122.416 and
139.489 s. Two user-ACL mismatches recovered with one guarded retry each;
no new fatal errors or HTTP 429s occurred. Successful-attempt p95:
confirmations 19.681 s, admission proofs 21.582 s, cold awards 15.500 s,
cold balances 8.005 s. Fees total 0.0002108630216 Sepolia ETH. Original limits,
clock, canary and coverage-gap records remain intact; no intervention was needed.

## Gateway readiness failure, 2026-10-29T03:57Z

Cycle 22 confirmed eight deposits in block 12016693, then **all eight public
admission-proof requests timed out** at approximately 03:06:47Z. Each ran about
92 seconds with approximately 41 SDK polls before HTTP **503**,
`readiness_check_timed_out: Ciphertext not ready for decryption on the gateway
chain`. These are actual relayer/gateway-readiness failures, unlike earlier
latest-state RPC permission mismatches. No admission transaction was sent for
the cycle. The ledger has 759 confirmed transactions, zero mined reverts or
pending, fees 0.0002134925228 Sepolia ETH. Twenty-two cycles are fully complete;
174 deposits but only 166 admissions/exits/prize checks are complete.

At 03:57:01Z, read-only investigation verified all eight receipts and block
hashes remain canonical, and every marker is publicly permitted at its deposit
block and at latest. The client cannot observe internal gateway/coprocessor
queues or determine the underlying service cause. This simultaneous failure
does not by itself establish saturation at eight users.

The same runner resumed against the saved deposits, with unchanged SDK timeout,
concurrency, original clock, limits and canary. It must receive valid proofs
before any admission transaction. No code changes or automatic extended retry
were introduced to hide the failure. The service-readiness incident and roughly
51-minute stopped interval remain part of the reliability result; no completed
capacity or availability conclusion is asserted.

At **03:59:21Z**, cycle 22 completed: all eight admissions, withdrawals and
prize checks succeeded, cold awards total 11, and every token/owner/backing
check passed. Twenty-three load cycles are complete; 174 unique deposits,
admissions, exits and prize checks each, with 785 confirmed transactions,
zero mined reverts/pending and fees 0.0002205534792 Sepolia ETH. Cycle 23
started about 24 minutes 43 seconds late; the original stop time remains fixed.
No code or timeout changes were needed for this service recovery. We did not
probe continuously during the stopped interval, so the service's actual outage
duration is unknown. Successful-only latency percentiles exclude these eight
approximately 92-second failed attempts; they must be reported alongside the
failure distribution. The runner is alive and continues under the same limits;
the retention draw is untouched.

At **04:56Z** (12.87 elapsed hours), twenty-six load cycles are complete,
twenty-four with eight users: 887 confirmed transactions, zero mined reverts/
pending/outstanding, and 198 unique deposits/admissions/exits/prize checks each.
Conservation passed at 04:36:51Z; latest cycles took 135.566, 134.796 and
132.818 s. No new fatal errors or HTTP 503/429s occurred after recovery.
Successful-attempt p95: confirmations 22.255 s, admission proofs 21.582 s,
cold awards 15.552 s, cold balances 7.985 s; the earlier eight approximately
92-second failures remain separate. Fees total 0.000249624854 Sepolia ETH.
The process, original limits/clock and canary are intact. All four late cycles
and prior interruptions remain recorded; no intervention was needed.

At **05:55Z** (13.84 elapsed hours), twenty-eight load cycles are complete,
twenty-six with eight users: 955 confirmed transactions, zero mined reverts/
pending/outstanding, and 214 unique deposits/admissions/exits/prize checks each.
Conservation passed at 05:36:54Z; latest cycles took 122.931 and 132.391 s.
No new fatal errors or HTTP 503/429s occurred. Successful-attempt p95:
confirmations 21.561 s, admission proofs 21.554 s, cold awards 15.621 s,
cold balances 8.005 s; the previously failed requests remain in the evidence.
Fees total 0.0002690057684 Sepolia ETH. The process is alive, with original
limits/clock, canary and four late-cycle/coverage-gap records preserved.

At **06:56Z** (14.86 elapsed hours), thirty load cycles are complete,
twenty-eight with eight users: 1,023 confirmed transactions, zero mined reverts/
pending/outstanding, and 230 unique deposits/admissions/exits/prize checks each.
Conservation passed at 06:37:01Z; latest cycles took 120.796 and 142.819 s.
User-ACL mismatches recovered within the original bound (up to four retries);
no new fatal errors or HTTP 503/429s occurred. Successful-attempt p95:
confirmations 21.054 s, admission proofs 21.554 s, cold awards 15.621 s,
cold balances 8.038 s; prior failed attempts remain separately recorded.
Fees total 0.0002883866644 Sepolia ETH. The process is alive with original
limits/clock, canary and all prior coverage gaps preserved; no intervention needed.

At **07:58Z** (15.89 elapsed hours), thirty-two load cycles are complete,
thirty with eight users: 1,091 confirmed transactions, zero mined reverts/
pending/outstanding, and 246 unique deposits/admissions/exits/prize checks each.
Conservation passed at 07:36:48Z; latest cycles took 123.623 and 129.431 s.
No new fatal errors or HTTP 503/429s occurred. Successful-attempt p95:
confirmations 20.497 s, admission proofs 21.582 s, cold awards 15.621 s,
cold balances 8.075 s. Fees total 0.0003077675596 Sepolia ETH. The original
clock, limits, canary, failures and four late-cycle records remain preserved;
the process is alive and no intervention was needed.

At **08:58Z** (16.89 elapsed hours), thirty-four load cycles are complete,
thirty-two with eight users: 1,159 confirmed transactions, zero mined reverts/
pending/outstanding, and 262 unique deposits/admissions/exits/prize checks each.
Conservation passed at 08:36:58Z; latest cycles took 155.149 and 139.442 s.
No new fatal errors or HTTP 503/429s occurred. Successful-attempt p95:
confirmations 21.635 s, admission proofs 21.582 s, cold awards 15.552 s,
cold balances 8.038 s. Fees total 0.000327148468 Sepolia ETH. The process is
alive with original limits/clock and canary intact; prior failures and four
late cycles remain recorded. No intervention was needed.

At **10:01Z** (17.95 elapsed hours), thirty-six load cycles are complete,
thirty-four with eight users: 1,227 confirmed transactions, zero mined reverts/
pending/outstanding, and 278 unique deposits/admissions/exits/prize checks each.
Conservation passed at 09:36:53Z; latest cycles took 134.423 and 134.200 s.
Guarded user-ACL retries recovered; no new fatal errors or HTTP 503/429s occurred.
Successful-attempt p95: confirmations 21.379 s, admission proofs 21.582 s,
cold awards 15.521 s, cold balances 8.034 s. Fees total 0.0003465293752 Sepolia
ETH. The process is alive under unchanged limits/clock, with canary, earlier
failed attempts and four late-cycle/coverage-gap records preserved.

At **11:05Z** (19.01 elapsed hours), thirty-eight load cycles are complete,
thirty-six with eight users. Cycle 38 is active: its eight deposits confirmed
and admission proofs are in progress with bounded ACL retries. The ledger has
1,303 confirmed transactions, zero mined reverts/pending transactions, 302
deposits and 294 admissions/exits/prize checks each; eight client operations
are outstanding. Latest completed conservation check: 10:37:04Z. The preceding
cycles took 116.295 and 145.913 s. No new fatal errors or HTTP 503/429s occurred.
Successful-attempt p95: confirmations 21.798 s, admission proofs 21.677 s,
cold awards 15.521 s, cold balances 8.005 s. Fees total 0.0003685397724 Sepolia
ETH. Original limits/clock, canary, failed requests and four late-cycle records
remain intact. No intervention was needed.

At **12:02Z** (19.97 elapsed hours), forty load cycles are complete,
thirty-eight with eight users: 1,363 confirmed transactions, zero mined reverts/
pending/outstanding, and 310 unique deposits/admissions/exits/prize checks each.
Conservation passed at 11:37:03Z; latest cycles took 145.849 and 144.931 s.
Guarded user-ACL retries recovered; no new fatal errors or HTTP 503/429s occurred.
Successful-attempt p95: confirmations 21.635 s, admission proofs 21.677 s,
cold awards 15.500 s, cold balances 8.002 s. Fees total 0.000385291202 Sepolia
ETH. The process, original limits/clock and canary are intact. All failures
and four late cycles remain recorded; no intervention was needed.

At **13:07Z** (21.04 elapsed hours), forty-three load cycles are complete,
forty-one with eight users: 1,465 confirmed transactions, zero mined reverts/
pending/outstanding, and 334 unique deposits/admissions/exits/prize checks each.
Conservation passed at 13:06:59Z; latest cycles took 118.803, 140.639 and
140.621 s. No new fatal errors or HTTP 503/429s occurred. Successful-attempt
p95: confirmations 21.720 s, admission proofs 21.677 s, cold awards 15.500 s,
cold balances 7.990 s. Fees total 0.0004144120014 Sepolia ETH. The runner is
alive, with original limits/clock, canary, historical failures and four late
cycles preserved. No intervention was needed; this is not yet the 24-hour result.

## Masked send-error recovery, 2026-10-29T14:10Z

Cycle 44 stopped at 14:05:25Z during admissions. The ledger retained one signed
transaction (`cycle-44-admit-3`, nonce 176); later queued operations threw
`Runner stopped after a failed operation`, masking the original send error.
All eight public proofs succeeded. The ledger had 1,510 confirmed transactions,
one uncertain signature and no mined reverts, with fees 0.0004277425778 Sepolia
ETH before reconciling that signature. Forty-four cycles were fully complete.

At 14:08:08Z, read-only checks found that exact saved hash, sender and nonce,
with successful receipt in canonical block 12019992. The ignored raw file's
hash matches; latest/pending nonce is 177. The transaction was accepted and
mined, but the original RPC/broadcast exception is unavailable. We cannot
attribute its exact cause retrospectively or classify it as service saturation.

The runner now latches the first fatal exception and propagates it through
later queue/batch aborts, rather than replacing it with a generic stop error.
Three regressions failed before the fix; all 77 soak-tooling tests and strict
driver typechecking pass afterward. Send/budget/nonce policy is unchanged.
The same run resumed, reconciling the saved admission before any new sends;
it does not replace or repeat that admission. Clock, limits, existing failures
and the untouched retention draw are preserved. This interruption remains
part of the reliability evidence.

At **14:11:18Z**, cycle 44 completed with all eight awards summing to 11 and
every principal/token/owner/backing check passing. There are now **45 completed
load cycles**, 350 unique deposits/admissions/exits/prize checks each, and
**1,533 confirmed transactions, zero mined reverts/pending/outstanding**.
Actual fees are 0.0004338917742 Sepolia ETH. The run resumed at 14:09:39Z,
approximately 4 minutes 14 seconds after its saved stop; this gap remains
recorded. Its original stop time is still 16:04:38Z, with three load cycles
remaining and the canary intact. The process is alive; no full availability
or saturation claim follows from recovery.

At **15:09Z** (23.08 elapsed hours), forty-seven load cycles are complete,
forty-five with eight users: 1,601 confirmed transactions, zero mined reverts/
pending/outstanding, and 366 unique deposits/admissions/exits/prize checks each.
Conservation passed at 15:06:42Z; latest cycles took 147.942 and 123.355 s.
Guarded user-ACL retries recovered; no new fatal errors or HTTP 503/429s occurred.
Successful-attempt p95: confirmations 21.478 s, admission proofs 22.071 s,
cold awards 15.621 s, cold balances 7.985 s. Fees total 0.0004533715558 Sepolia
ETH. One scheduled load cycle remains before the original 16:04:38Z stop.
The process is alive; original caps, canary, failure history and coverage gaps
are intact. This checkpoint does not mark the 24-hour run complete.

## Status and continuation

Run from `packages/contracts` without any signer or RPC access:

```sh
node experiments/claim-lab/soak/status.cjs
```

State is [soak-results.json](soak-results.json); sanitized HTTP/operation records
are [soak-events.jsonl](soak-events.jsonl). Process logs, raw signed transactions,
keys and SQLite remain in the ignored cache. The detached local process uses
`caffeinate -i` while active; closing the lid, loss of network/power or killing
the process can interrupt coverage. Actual elapsed/observed coverage must be
reported honestly, not inferred from a scheduled duration.

The detached runner exited after its original deadline with its lease released.
The hourly soak monitor was removed after this final audit; it does not
schedule the future 60-day claim. Preserve the ignored wallet keys, event archive
and canary paths for that later test. Archiving this worktree does not preserve
ignored files automatically.
