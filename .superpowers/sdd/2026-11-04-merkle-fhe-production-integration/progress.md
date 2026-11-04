# SDD ledger — plan: docs/superpowers/plans/2026-11-04-merkle-fhe-production-integration.md

Base: 4d1e4a7, branch codex/merkle-fhe-production-integration. Existing user Codacy config changes are excluded from all commits. User requested implementation, commits, deployments, PR and final main validation. GPT-5.6 is unavailable; model replacement question pending.

## Preflight
| Tasks | Shared interface / internal consistency | Finding |
|---|---|---|
| 1 | Membership, tree, pending accounting vs withdrawal | Explicit exit must queue principal using existing withdrawal machinery; no liquid shortcut. |
| 2 | Snapshot credit vs existing claim/reinvest | Independent reserved liabilities and immutable historical owner/generation required. |
| 3 | Archive ingestion vs serving | Only canonical complete finalized checkpoints may be served; RPC root reads independent. |
| 4 | UI checks vs admission and old positions | Legacy pool routes required; no automatic unbounded checks. |
| 5 | New bounded run vs old soak | New authorization envelope required; old canary untouched. |
| 6 | Release candidate vs cutover | User authorizes deployment now; all release safety gates still apply. |
| 1,2 | Tree leaves/sums and historical ACLs | ABI/events freeze before downstream integration. |
| 1,4 | Pending principal/admission and withdrawal | Admission proof handle and nonce must match current mutation. |
| 1,5 | Admission automation | Reconcile exact intent; proofs tied to current state. |
| 1,6 | New immutable pool and old positions | Versioned deployment; never mutate old liabilities. |
| 2,3 | Snapshot/event schema and historical proof | Full depth paths and canonical close identity. |
| 2,4 | checkPrize ABI and checked metadata | ABI frozen before UI action. |
| 2,5 | Constant-work close and live runner | No participant enumeration or funding old canary. |
| 2,6 | Old prize liabilities | Keep old contract claim access. |
| 3,4 | Scoped proof API / structured outcomes | Client authenticates chain, pool, beneficiary, root and block. |
| 3,5 | Service reliability and capacity | No unbounded replay per request, explicit outages. |
| 3,6 | Persistence, backups and rollback | Both namespaces retained across cutover. |
| 4,5 | Transaction reconciliation | Confirm receipt and state before success; permission denial distinct. |
| 4,6 | Dual pool routing | Preserve claim and withdrawal access during failure/rollback. |
| 5,6 | Real aged ciphertext vs release gate | Earliest canary 2026-12-27T16:04:36Z; impossible to prove today. |

Ruling: User execution request supersedes the document publication-only prohibition; production cutover still requires successful gates — no unsafe bypass — release may remain blocked.
Ruling: Work on a dedicated branch in the existing checkout and preserve user edits; user explicitly requested final validation here on main — no unsolicited extra checkout — shared checkout needs coordinated edits.
Ruling: Do not promise 60-day retention or claim full completion before due canary; implement remaining work independently — retention gate cannot be accelerated — production activation may remain blocked.

## Tasks
1 pending; 2 pending; 3 pending; 4 pending; 5 pending; 6 pending.

Model: user clarified GPT-5.6 Terra medium; spawn accepted `gpt-5.6-terra`, agent /root/membership_terra implements Task1. Substitute /root/membership interrupted before edits.
Baseline: contracts34/34; keeper7/7. Baseline web running.
Task1 BASE4d1e4a7.
Inventory: Worker configured e65D6459a7Ce01315FbB0998C37233c6FeE3aB8b (5 participants/draw24), local env9c23E5f7143612dc1232FC643A57300291e0d719 (1 participant/draw8); both legacy32-cap. Both must be retained in versioned routing.

Task5 preparation: concrete proposed run envelope docs/releases/merkle-fhe-v2-run-envelope.md; no funding, signatures or deployments occurred. New ceilings600 transactions/0.003feeETH/0.005fundingETH/100USDC/100000wei/two hours; approval pending.

Baselineweb175 node tests+15 UItests passed. Root docs commits8a44798/43e9091 preserve concrete budget and legacy routes. Task1 source review base43e9091.
Codacy Cloud repository read unauthorized (no CODACY credentials in process/project env); user asked to refresh local CLI login. Local capability ready9 tools, SQLint missing with dependency-install failure, TSQLLint cloud-only configured; preserve user configs. Wrangler4.149.0 authentication present; missing K2 scopes irrelevant unless deployment requires them.

Task1 root-cause diagnosis: preliminary tree recomputed each parent sum from updated child sums, creating32 sequential FHE dependencies and HCUTransactionDepthLimitExceeded. Ruling: use reviewed probe delta updates (old ancestor +/- same accepted delta independently), preserving depth32 and real FHE caps; queue full exit with shared withdrawal helper — no changed privacy or liquid withdrawal shortcut — incorrect delta accounting would corrupt root sums, so conservation/tree tests required.
Task3 deploy prerequisite: inventory agent found no persistent Node24 host/deploy credentials, independent backup target or historical RPC fallback; user asked for host/access location. Development continues; deployment cannot be claimed.

User approved exact capacity envelope on2026-11-04. Clock notstarted, no signatures/funding yet. User instructed continue and report CodacyCloud gate blocked (no credentials supplied); do not claim cloudapproval. User asked explanation of proofservicehost; explained and awaiting choice between existingCloudflare durableSQLite adaptation and separatepersistentNodehost.

User instruction: no draw-history service. Proposed Task3/4 amendment documented at docs/superpowers/plans/2026-11-04-merkle-fhe-client-proofs-amendment.md; client canonical event proof rebuilding preserves contract design but depends on historical RPC and replaces operated service guarantees. Await approach confirmation before dependent client implementation; Task1/2 unaffected.

User clarified proofstore concept and asked PostgreSQL/D1. Explained D1 isSQLite and proofserviceinternal/no readablebalances. Prior clientproofamendment is superseded, unapproved, and notimplemented. New proposed CloudflareWorker+dedicatedD1 asyncbatch adaptation: docs/superpowers/plans/2026-11-04-merkle-fhe-cloudflare-proof-storage-amendment.md; preservesindexedAPI and originaloperationalgoals. Awaiting approachapproval; contracttaskscontinue.

User approved Worker+dedicatedD1 amendment on2026-11-04. Supersedes no-service/client-rebuild proposal; no separateNodehostneeded. Task3 keepsindexedproofAPI/backups/canonicalcheckpointrequirements, adaptsruntime/storage toWorkers+D1. Task1commita1e38cd,42tests,runtime17192bytes; reviewagentreview_membershiprunning. Rootdocsnotcode willnotaffectsource Task1reviewrange94d2ed5..a1e38cd.

Task1 review: counterfindingwithdrawn after focusedlegacy/FHEsemanticsinvestigation; countercounts schedulingattempts, encryptedacceptedpending/accountingremainscorrect, validzerounwrappossible. Ruling: preservepublicattemptcounter; do notintroduceadditionalplaintextacceptancebranch/asynchronousAPI — preservesexistingkeeper/confidentiality — zeroamountunwrapmayconsumeagastransaction/timerreset. RemainingImportant: documentpermanentpositivebit/delayedeligibility. Implementerfixround1running. Reviewer amendedsamefile.

Task1: fixround1/5(1documentationfindingaddressed,0open; counterfindingwithdrawnafterresearch; sourcecommitc2f2d80). Task1 complete(commits94d2ed5..c2f2d80, reviewclean;44contracttests,runtime17192). Task2BASEc2f2d80, agent/root/snapshot_claims(gpt-5.6-terra medium)running. OriginalTask1interimclose scan explicitlyreplaced inTask2. D1amendmentapproved557e401.

D1 created (authorized) kettigo-proof-v2-sepolia/60fc25ef-1686-4c1a-b8b4-604456d00bdb WEUR; existingappDBuntouched. CLIcreationlogretained. NoEthereumtxs yet, validationclocknotstarted.
Ruling: implement/test Task5runner andTask6releasecode before starting liveenvelope; original Task5livevalidationdepends onTask6candidate deployment, andclockstartsfirstsignedETHtxincludingdeploy — finishpreparationfirsttoavoid consumingthefixedtwohourwindow oncodework — livevalidation evidence may requirepost-Task6phase. No clockreset/capextension.
D1runtime notes .superpowers/sdd/.../d1-implementation-notes.md verifiedagainstcurrentD1limits (batchcountsoneinvocationquery; statementsindividuallimits), architectureamendmentapproved.

Task2 partialagent stoppedat49passing/runtime18325; no commit. Reassignedremaining4096/rightmost/invariantverification+Task2commit to freshclaim_scale_tests(gpt-5.6-terra medium), no concurrentimplementers. ExistingTask2report+codearehandoff; rootdoccommit23f59b4 inventoryonlyexcludedfromsource review. PerdrawencryptedAwardOf addedforstablehistoricaloutcomesafterclaim/reinvest.
LocalSQLintresolved: officialchecksum-verified sqlint0.3.0,pg_query5.1.0,googleprotobuf3.25.5 gems installed onlyinCodacyruntime; nativecompileusesHAVE_STRCHRNULforcurrentmacOSSDK; inspectSQLintready. No source/userconfigchanges. TSQLLintstillcloud-only.
Backuppreflight: R2isnotenabled(accountAPIcode10042); no bucketscreated. Do notclaimindependentcloudbackupconfigured. Completebackupcode/localrestorefirst, thenR2activationmayneeduseraccountaction; alternativeindependentexportsremainpossible. GitHubsecretsnameshaveKEEPER_PRIVATE_KEY/RPC/BetterStackonly,noCFtoken.

Quality scope clarification: uncommitted user Codacy configs select a different experimental analyzer set (SQLint/TSQLLint/ESLint8/PMD) from the committed release config (spectral/ESLint9/Checkov/PMD7). Preserve user edits. Release scans use an exact git-HEAD copy in ignored SDD/codacy-release-config.json, not experimental unstaged config; all11committed analyzers are available. Preliminary working-config scan found6ESLintnewline-formatwarnings in tests, now cleaned by scaleagent;22typeawarerules skipped in experimentalESLint8 config, so that scan waspartial. Fresh committed-config scan running. This is release/Cloudconfig parity, not disabling rules.

Task2 commitc107273: default52passing+1optinpending; actualRUN_TASK2_SCALE=1 testpassed4096members129754ms,33boundary,index4095; runtime18341. Review claims found2Important evidencegaps: exitreuse test onlyreverted; weightedmodelonlyconservation. Fixround1 assigned claim_scale_tests, adding genuineexit/reuse/rejoin, exactindependentintervaloracle inclboundaries/zero, sameblockordering, creditclaim/reinvest endtoend. No sourcefinancialbugfound. Publicreserveannouncementsminor assignedTask4UI/Task5keeper; notfundedliabilityauditsignal. Rootdoccommit1d2a659 analyzerexceptionsafterc107excludedfromtaskfixreview.
Sourceverificationpreflight: enoughconfiguredtestgasandatleast1USDC, gaspricewithinceiling; fullmaxbudgetsneednotallbespent. NoEthereumfunds/signaturesstarted. Dedicatedtestoperatorneededfornonceisolationfromexistingkeepers; do notmodifyexistingkeys/jobs.

Task 2: fix round 1/5 (2 Important findings plus same-block/credit evidence gaps addressed, 0 open; c107273..7bf237d; review clean). Task 2 source complete: 56 default tests plus actual 4096 opt-in passed; runtime 18,341 bytes. Root review-doc commit 1d2a659 was excluded from the source review. Minor public-mirror labels and keeper policy carried to Tasks 4/5. Task 3 base 7bf237d; proof_service agent (GPT-5.6 Terra medium) now sole implementer; approved Worker+D1 override and new D1 ID provided.
Ruling: finish Tasks 3–6 local code/tests/reviews before joint live validation because the service/clients require Task 6's fresh candidate and the fixed two-hour clock includes deployment. Keep live operation/restore/backfill/soak acceptance explicitly pending; local tests do not prove remote operation — preserves the approved window for testing — integrated defects may require a new approved run if the window expires.

Independent Task6 contract source review found H-01 stale zero-leaf entitlement grief and M-01 idle-unsupplied withdrawal liveness; root followup confirmed M-02 manual-restore cash classification. Proof service paused without discarding code. Regressions reproduced H-01/M-01 RED before fixes. Commit5772c39 fixes all3: canonical full-exit hash+sum in one subtraction, idle-first residual restoration, manual-returned liquid accounting and global nonempty-unfunded-batch guard. Full61tests passed (4096 opt-in was run on prior source and will rerun final); runtime19462. Reviewer contract_security scoped7bf237d..5772c39: all3 ADDRESSED, no new Important defect. Not an external cryptographic audit. Service resumed from preserved skeleton/report; ABI unchanged.
Ruling: retain manual restoration with exact uint64-bounded liquid accounting, but forbid it during any nonempty unfunded withdrawal batch — avoids changing fixed settlement amounts and preserves useful existing admin ABI — operator manual restoration is temporarily unavailable until all affected batches fund; ordinary settlement remains permissionless.
The speculative reserve/winnings overflow issue was withdrawn after verifying OpenZeppelin ERC7984 mint uses FHESafeMath.tryIncrease(totalSupply) and wrapper guards inferred supply. False public funding metadata is display integrity only, not additional actual received tokens; do not add a public-decryption funding redesign.

Task3 scaffold492a98f is NOT accepted complete. Only2empty-history Worker tests existed. Root identified nonempty INSERT arity errors (slots9placeholders/8columns, draws10/9), >100sequentialD1reads per depth32proof, int64-cast pagination, ineffective reorg loop(nextBlock>lastFinalized), RPC_URL vsPRIMARY/HISTORICAL mismatch, unknown/unindexed draws misreported NOT_ELIGIBLE, no chain/hash validation, no backup adapter, unfinished adversarial matrix. No remote deployment. Split remaining Task3 into sequential smaller implementation scopes: 3a archive/domain/schema/nativeD1tests + readable formatting/bindings-only types; 3b RPC/ingestion recovery; 3c HTTP/worker/backup restore. Freshagentproof_archive_core GPT5.6Terra medium owns3a now; originalproof_service completed and no longer editing. Preserve publicAPI; finalwholeTask3review occurs after all local acceptance passes. No Ethereumclock started.

Task3a core complete locally (not whole Task3): corrected slot/draw arity, canonical empty-block headers/parent hashes, pre-write SQLite-triggered CAS, exact uint256 ordering, bounded depth32 D1 batch node fetch, uint/bounds validation, formatted proof-service TS/config, and bindings-only generated Wrangler declaration included in tsconfig. Native Miniflare D1 suite6passes covers real depth32 historical proof, duplicate/conflicting logs, stale/unexpected writers, maxuint pagination, rollback predecessor. Fresh typecheck, dry-run build, Prettier check, and protocol23suite pass. Node24 export/restore plus RPC/HTTP adverse tests remain 3b/3c; no remote or Ethereum operation.

Task3b local handoff: native Worker/D1 suite10passes. Ingestion has a durable deployment-parent anchor, pre-no-work checkpoint validation, bounded128-block common-ancestor rollback, disabled deep/unknown fork status, chain/header/log hash and receipt completeness checks, independent close snapshot checks, and a fail-closed missing-state trigger. Scheduler initializes D1 itself; no client GET dependency. Fresh proof-service typecheck/build dry-run/protocol23 pass. HTTP adverse paths, robust receipt fallback limits, Node24 export/restore, and live RPC backfill remain Task3c/operations; no remote D1/Ethereum action.
