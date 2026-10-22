# Passkey-Owned Safe Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Web3Auth onboarding with a browser passkey that deterministically owns a Safe 1.4.1 account, sends sponsored EntryPoint 0.7 operations through Pimlico, and signs Zama decryption authorizations as the Safe.

**Architecture:** The browser persists validated public passkey metadata and reconstructs a Safe Relay Kit session on reload. Safe Protocol Kit supplies the canonical WebAuthn signer, Relay Kit supplies sponsored ERC-4337 operations, and the existing Zama adapter treats the checksum Safe address as the only user identity. The Worker remains an email-approval lookup and never receives wallet or passkey data.

**Tech Stack:** Next.js 15, React 18, TypeScript, Safe Protocol Kit 8.0.7, Safe Relay Kit 6.1.1, WebAuthn, viem, Zama SDK 3.6.0, Pimlico, Cloudflare Workers/D1.

**Spec:** `docs/superpowers/specs/2026-10-09-passkey-safe-auth-design.md`

## Global Constraints

- Passkeys are the only wallet onboarding method; do not retain Google, Apple, injected-wallet, seed-phrase, password, or exported-key fallbacks.
- Use Safe 1.4.1, the Safe ERC-4337 module compatible with EntryPoint 0.7, Pimlico bundling/sponsorship, and Ethereum Sepolia.
- Reuse canonical Safe WebAuthn and ERC-4337 contracts; introduce no Kettigo signer contract, P-256 verifier, Safe module, or signature encoder.
- Persist only validated public passkey metadata in the browser; never send credential metadata, signatures, Safe addresses, or email-to-wallet associations to the Worker.
- Keep the email gate as an independent approval lookup; approved emails may unlock multiple browser accounts and the active flow must not call the access-claim endpoint.
- Treat the Safe checksum address as the Zama user for encrypted input, ACL ownership, contract calls, and user decryption; normalize every address passed across a Zama boundary with `getAddress()`.
- Serialize bigint-bearing typed data safely before any JSON boundary; Safe signing itself must hash the structured typed data without lossy coercion.
- Keep existing Web3Auth code until the passkey/Safe/Zama compatibility adapter and its tests pass; remove Web3Auth only in the final migration task.
- Sign-out clears in-memory session and balance state but does not delete passkey metadata.
- User-facing copy must obey `AGENTS.md`: present Kettigo as a finished product and avoid restricted implementation/privacy/network terms.

## Review Focus

- Corrupt or schema-invalid local metadata must never be coerced into a signer or silently deleted; Task 1 tests rejection and preservation.
- A restored credential whose derived Safe differs from the stored checksum address must be blocked before any signing or submission; Task 2 tests the mismatch boundary.
- User cancellation must return the wallet state to a retryable no-account/ready state without being classified as an outage; Tasks 1 and 3 test the DOMException mapping and state transition.
- Pimlico may return a UserOperation hash long before a transaction hash; Task 2 tests receipt polling, failure receipts, and timeout so existing transaction consumers receive only a mined transaction hash.
- Zama typed data may contain bigint values and mixed-case addresses; Task 2 tests typed-data hashing plus checksum normalization without JSON serialization failure.

---

### Task 1: Add validated passkey metadata and WebAuthn lifecycle

**Files:**
- Create: `packages/web/src/lib/passkey-metadata.ts`
- Create: `packages/web/src/lib/passkey-webauthn.ts`
- Create: `packages/web/tests/passkey-metadata.test.mjs`
- Create: `packages/web/tests/passkey-webauthn.test.mjs`

**Interfaces:**
- Consumes: Web Storage, `navigator.credentials`, Safe `ExtractedPasskeyData`, and the configured relying-party ID.
- Produces: `PasskeyMetadata`, `readPasskeyMetadata(storage)`, `writePasskeyMetadata(metadata, storage)`, `createKettigoCredential(deps)`, `getKettigoCredential(rawId, deps)`, `isPasskeySupported()`, and `classifyPasskeyError(error)`.

- [ ] **Step 1: Write failing metadata tests**

Test that the versioned record round-trips only `rawId`, P-256 `x`/`y`, verifier address, and checksum Safe address; malformed JSON, unknown versions, invalid hex coordinates, invalid credential IDs, and non-checksum derivation inputs return an explicit `invalid` result while leaving storage untouched.

- [ ] **Step 2: Run the metadata tests and observe the missing module failure**

Run: `node --experimental-strip-types --test packages/web/tests/passkey-metadata.test.mjs`

Expected: FAIL because `passkey-metadata.ts` does not exist.

- [ ] **Step 3: Implement strict metadata parsing and persistence**

Use storage key `kettigo.passkey.v1`; expose a discriminated read result (`missing`, `valid`, `invalid`) and normalize the stored Safe/verifier addresses with `getAddress()`. Do not delete an invalid record automatically.

- [ ] **Step 4: Write and fail WebAuthn option/error tests**

Test discoverable credential creation with ES256 (`alg: -7`), `residentKey: "required"`, `userVerification: "required"`, a random user ID unrelated to email, allow-credential restoration by decoded raw ID, unsupported-browser classification, and `NotAllowedError` cancellation classification.

Run: `node --experimental-strip-types --test packages/web/tests/passkey-webauthn.test.mjs`

Expected: FAIL because `passkey-webauthn.ts` does not exist.

- [ ] **Step 5: Implement the minimal WebAuthn adapter and run both tests**

Run: `node --experimental-strip-types --test packages/web/tests/passkey-metadata.test.mjs packages/web/tests/passkey-webauthn.test.mjs`

Expected: all passkey metadata and WebAuthn tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/lib/passkey-metadata.ts packages/web/src/lib/passkey-webauthn.ts packages/web/tests/passkey-*.test.mjs
git commit -m "feat(web): add passkey metadata lifecycle"
```

### Task 2: Prove the canonical passkey Safe session boundary

**Files:**
- Create: `packages/web/src/lib/smart-session.ts`
- Create: `packages/web/src/lib/passkey-safe.ts`
- Create: `packages/web/tests/passkey-safe.test.mjs`
- Modify: `packages/web/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `packages/web/next.config.js`

**Interfaces:**
- Consumes: Task 1 `PasskeyMetadata`, Safe Protocol Kit passkey extraction and verifier lookup, Safe Relay Kit `Safe4337Pack`, Sepolia RPC, and Pimlico URL.
- Produces: `PasskeySmartSession`, `createPasskeyAccount()`, `restorePasskeyAccount()`, `sendSmartTransaction(session, to, data)`, `sendSmartTransactionBatch(session, calls)`, and `signSafeTypedData(protocolKit, typedData)`.

- [ ] **Step 1: Add exact Safe SDK dependencies and write the failing session tests**

Pin `@safe-global/protocol-kit` to `8.0.7` and `@safe-global/relay-kit` to `6.1.1`. Test canonical verifier lookup, Safe `1.4.1`, `safeModulesVersion: "0.3.0"`, threshold 1, deterministic salt, checksum address persistence, reload equality, derivation mismatch rejection, and existing-vs-counterfactual initialization using injected SDK/network boundaries.

- [ ] **Step 2: Run the focused tests and observe missing session behavior**

Run: `node --experimental-strip-types --test packages/web/tests/passkey-safe.test.mjs`

Expected: FAIL because `passkey-safe.ts` and `smart-session.ts` do not exist.

- [ ] **Step 3: Implement account creation/restoration and sponsored sends**

Create the passkey with `Safe.createPasskeySigner`, add `getP256VerifierAddress(String(sepolia.id))`, initialize `Safe4337Pack` with the shared signer owner path, and return the checksummed predicted/existing Safe address. Build, sign, and submit Safe operations through Relay Kit, poll `getUserOperationReceipt`, reject failed receipts, and return the mined transaction hash expected by existing pages.

- [ ] **Step 4: Add typed-data tests before implementation**

Test that a bigint-bearing EIP-712 object hashes with viem, `protocolKit.signHash()` receives that hash, the returned owner signature is encoded with Safe's canonical `buildSignatureBytes`, and the session address remains checksummed.

Run: `node --experimental-strip-types --test packages/web/tests/passkey-safe.test.mjs`

Expected: the new typed-data cases fail because session signing is not implemented.

- [ ] **Step 5: Implement typed-data signing and prove the adapter**

Run:

```bash
node --experimental-strip-types --test packages/web/tests/passkey-safe.test.mjs
corepack pnpm --filter @kettigo/web typecheck
```

Expected: focused tests pass and typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/web/package.json packages/web/next.config.js pnpm-lock.yaml packages/web/src/lib/smart-session.ts packages/web/src/lib/passkey-safe.ts packages/web/tests/passkey-safe.test.mjs
git commit -m "feat(web): add passkey-owned Safe session"
```

### Task 3: Decouple the approval gate from wallet identity

**Files:**
- Modify: `packages/web/src/lib/access.ts`
- Modify: `packages/web/src/lib/access-cache.ts`
- Modify: `packages/web/src/components/AccessGate.tsx`
- Modify: `packages/web/worker/access.ts`
- Modify: `packages/web/worker.ts`
- Modify: `packages/web/tests/access-cache.test.mjs`
- Modify: `packages/web/tests/access-worker.test.mjs`
- Create: `packages/web/tests/access-client.test.mjs`

**Interfaces:**
- Consumes: existing `/api/access/status` and `/api/waitlist` responses.
- Produces: an approved-gate cache independent of account metadata; no active `/api/access/claim` client or Worker route.

- [ ] **Step 1: Rewrite tests first for independent approval**

Test that approved email status sets the gate marker without a wallet; reload bypasses the email form after wallet readiness; the client never posts wallet or signature fields; the Worker returns 404 for `/api/access/claim`; and repeated approved-email checks never mutate `wallet_address`, `joined_message`, or `joined_signature`.

- [ ] **Step 2: Run access tests and observe the old binding behavior fail**

Run: `node --experimental-strip-types --test packages/web/tests/access-cache.test.mjs packages/web/tests/access-client.test.mjs packages/web/tests/access-worker.test.mjs`

Expected: FAIL because the current cache and claim route bind email to a wallet/signature.

- [ ] **Step 3: Remove the active claim flow and simplify the gate**

Cache only an approval marker plus normalized email, let approved status unlock passkey onboarding, preserve entered email after status failures, retain waitlist behavior for pending/unknown email, and remove Worker mutation code while leaving nullable D1 columns untouched.

- [ ] **Step 4: Run access tests and typecheck**

Run:

```bash
node --experimental-strip-types --test packages/web/tests/access-cache.test.mjs packages/web/tests/access-client.test.mjs packages/web/tests/access-worker.test.mjs
corepack pnpm --filter @kettigo/web typecheck
```

Expected: access tests pass and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/access.ts packages/web/src/lib/access-cache.ts packages/web/src/components/AccessGate.tsx packages/web/worker/access.ts packages/web/worker.ts packages/web/tests/access-*.test.mjs
git commit -m "feat(web): decouple access approval from wallet"
```

### Task 4: Migrate wallet state and Zama authorization to the Safe

**Files:**
- Modify: `packages/web/src/lib/wallet-context.tsx`
- Modify: `packages/web/src/lib/wallet-errors.ts`
- Modify: `packages/web/src/lib/zama.ts`
- Modify: `packages/web/src/lib/confidential-balances.ts`
- Modify: `packages/web/src/app/savings/page.tsx`
- Modify: `packages/web/src/app/draw/page.tsx`
- Modify: `packages/web/src/components/ConnectButton.tsx`
- Modify: `packages/web/src/components/Header.tsx`
- Modify: `packages/web/src/app/profile/page.tsx`
- Modify: `packages/web/test/wallet-errors.test.mjs`
- Create: `packages/web/tests/passkey-wallet-contract.test.mjs`

**Interfaces:**
- Consumes: Task 2 `PasskeySmartSession` and Task 3 approved-gate state.
- Produces: wallet states `checking`, `no-account`, `creating`, `awaiting-verification`, `ready`, `unsupported`, `cancelled`, `invalid-metadata`, and `service-unavailable`; a single Safe-backed Zama signer for balances, principal, and winnings.

- [ ] **Step 1: Add failing wallet-state and migration contract tests**

Test distinct unsupported/cancelled/invalid-metadata/Pimlico messages, sign-out balance clearing without metadata deletion, absence of `ownerAddress` and owner Zama adapters, Safe address use in deposit callback data and every encryption/decryption request, and passkey-only onboarding copy.

- [ ] **Step 2: Run the tests and observe Web3Auth/owner-delegate failures**

Run: `node --experimental-strip-types --test packages/web/test/wallet-errors.test.mjs packages/web/tests/passkey-wallet-contract.test.mjs packages/web/tests/zama-sdk-migration.test.mjs`

Expected: FAIL because current wallet state and Zama code expose Web3Auth owner concepts.

- [ ] **Step 3: Integrate passkey sessions throughout the UI**

Restore validated metadata on load without prompting; create accounts only from explicit user action; retain the session on Pimlico or Zama failure; clear only in-memory session/balances on sign-out; update account/profile controls and product-safe copy; use `session.address` as deposit callback data and use one Safe-backed Zama signer for all account values.

- [ ] **Step 4: Run focused tests, full web tests, and typecheck**

Run:

```bash
node --experimental-strip-types --test packages/web/test/*.test.mjs packages/web/tests/*.test.mjs
corepack pnpm --filter @kettigo/web typecheck
```

Expected: all web tests pass and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src packages/web/test packages/web/tests
git commit -m "feat(web): use Safe passkeys for wallet actions"
```

### Task 5: Remove Web3Auth and document/verify the migration

**Files:**
- Delete: `packages/web/src/lib/web3auth.ts`
- Delete: `packages/web/test/web3auth-config.test.mjs`
- Modify: `packages/web/package.json`
- Modify: `packages/web/next.config.js`
- Modify: `packages/web/.env.example`
- Modify: `packages/web/README.md`
- Modify: `packages/web/wrangler.jsonc`
- Modify: `wrangler.jsonc`
- Modify: `packages/web/worker.ts`
- Modify: `pnpm-lock.yaml`
- Create: `packages/web/tests/passkey-migration.test.mjs`

**Interfaces:**
- Consumes: all prior task interfaces.
- Produces: a passkey-only production bundle and operator instructions for the live Sepolia compatibility/acceptance run.

- [ ] **Step 1: Add the failing removal/config test**

Test that no production source, dependency, runtime key, documentation, or transpile list references Web3Auth; runtime config exposes only the passkey relying-party values plus existing chain/contracts/Pimlico values; docs list the real passkey creation, Safe deployment, sponsored transaction, Zama decryption, and reload acceptance steps.

- [ ] **Step 2: Run the migration test and observe Web3Auth references**

Run: `node --experimental-strip-types --test packages/web/tests/passkey-migration.test.mjs`

Expected: FAIL with current Web3Auth dependency, module, config key, and documentation references.

- [ ] **Step 3: Remove Web3Auth and finish configuration/docs**

Remove `@web3auth/modal`, delete the old module/test, add `NEXT_PUBLIC_PASSKEY_RP_ID` and `NEXT_PUBLIC_PASSKEY_RP_NAME` to both Worker runtime-config allowlists and examples, update the README architecture and recovery limitations, and document that the live compatibility gate requires configured Pimlico and deployed Zama contracts.

- [ ] **Step 4: Run clean install, tests, build, and deployment dry run**

Run:

```bash
corepack pnpm install --frozen-lockfile
node --experimental-strip-types --test packages/web/test/*.test.mjs packages/web/tests/*.test.mjs
corepack pnpm --filter @kettigo/web typecheck
corepack pnpm --filter @kettigo/web build
corepack pnpm exec wrangler deploy --dry-run --config packages/web/wrangler.jsonc
git diff --check
```

Expected: every command exits 0; the bundle contains no Web3Auth dependency path.

- [ ] **Step 5: Commit**

```bash
git add packages/web package.json pnpm-lock.yaml wrangler.jsonc
git commit -m "chore(web): complete passkey authentication migration"
```
