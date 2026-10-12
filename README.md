# Kettigo

> Your savings, with a chance to win. Test version on Ethereum Sepolia.

**Live app:** https://kettigo.xyz

Mobile-first confidential prize-savings app for the Zama Developer Program
Mainnet Season 4 bounty. Kettigo recreates the core PoolTogether no-loss
mechanic on Ethereum Sepolia using Zama FHE; it does not integrate with the
official PoolTogether protocol.

> [!IMPORTANT]
> The confidential implementation is now the bounty path. `ConfidentialUSDC`
> wraps USDC as an ERC-7984 confidential token, and
> `ConfidentialPrizePool` handles encrypted deposits, encrypted principal,
> FHE-random weighted draws, confidential winnings, claiming, and encrypted
> withdrawals. The old plaintext `Vault` / `PrizePool` and the primitive spike
> have been removed so the repo tracks only the active confidential path. See
> [Bounty Scope and Architecture Decision](docs/BOUNTY_SCOPE.md) and the
> [Bounty Roadmap](docs/ROADMAP.md).

**What's in the box**

- **Passkey account** — A browser passkey solely owns a deterministic Safe 1.4.1
  account (ERC-4337, EntryPoint v0.7).
- **Gasless** — Pimlico as bundler + paymaster. Users never see a gas popup.
- **Fiat on-ramp** — out of scope for this MVP. Add Onramper / Wert / Stripe
  ramp integration when going past testnet.
- **No-loss** — Users can withdraw encrypted principal from
  `ConfidentialPrizePool` and unwrap it back to USDC. The visible global prize
  is currently mocked by sponsor/admin funding until a real yield source is
  plugged in.
- **Mobile-first PWA** — Next.js 15, Tailwind, and no crypto jargon in the UI
  ("Save", "Tickets", "Draw", "Withdraw").

## Repo layout

```
kettigo/
  packages/
    contracts/   # Hardhat — ConfidentialUSDC, ConfidentialPrizePool, mocks
    landing/     # Vite + Cloudflare Worker — see [Landing site operations](packages/landing/README.md)
    morpho-lab/  # Vite — local technical Morpho operator playground
    web/         # Next.js 15 PWA — passkeys + Safe + Pimlico + Zama SDK v3
  package.json   # npm workspaces root
```

## Quick start

```bash
# 1. Install everything with the pinned package manager.
corepack pnpm install --frozen-lockfile

# 2. Deploy confidential contracts to Sepolia.
cd packages/contracts
cp .env.example .env  # fill PRIVATE_KEY + SEPOLIA_RPC_URL
pnpm run deploy:confidential-usdc
# -> prints Circle Sepolia USDC + ConfidentialUSDC addresses
CONFIDENTIAL_USDC_ADDRESS=0x... pnpm run deploy:confidential-pool
# -> prints ConfidentialPrizePool address

# Optional: deploy and connect Morpho yield adapter.
CONFIDENTIAL_USDC_ADDRESS=0x... \
CONFIDENTIAL_PRIZE_POOL_ADDRESS=0x... \
MORPHO_UNWRAP_INTERVAL_SECONDS=300 \
pnpm run deploy:morpho-yield-adapter

# 3. Configure the web app.
cd ../web
cp .env.example .env.local
# fill NEXT_PUBLIC_USDC_ADDRESS, NEXT_PUBLIC_CONFIDENTIAL_USDC_ADDRESS,
#       NEXT_PUBLIC_CONFIDENTIAL_PRIZE_POOL_ADDRESS,
#       NEXT_PUBLIC_PASSKEY_RP_ID, NEXT_PUBLIC_PASSKEY_RP_NAME,
#       NEXT_PUBLIC_PIMLICO_API_KEY
# On Netlify, also set private keeper env vars:
#       SEPOLIA_RPC_URL, KEEPER_PRIVATE_KEY, MORPHO_KEEPER_START_BLOCK

# 4. Run.
pnpm run dev
# → http://localhost:3000
```

## Test the contracts

```bash
cd packages/contracts
pnpm test
```

Contract tests cover confidential deposits, encrypted principal decryption,
withdrawal/unwrap, public mocked prize funding, FHE-random draws, confidential
claims, and Morpho yield routing.

## Sepolia deployment

Frontend:

- **Live app:** https://kettigo.xyz
- **Host:** Netlify
- **Status:** fresh safe-withdrawals contracts deployed; run a new app
  end-to-end exercise before judging from the live URL.

Current confidential deployment:

The addresses below use automatic withdrawal delivery, deployed September 16,
2026. This is a fresh Sepolia test deployment, replacing the previous pool without
migrating its disposable test balances or pending claims. Local frontend and
keeper configuration must point to the same pool.

- **USDC underlying:** `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`
- **ConfidentialUSDC:** `0x6B26B258436bcCE719Be8F9B30F87FDFD9BdFA8a`
- **ConfidentialPrizePool:** `0xe65D6459a7Ce01315FbB0998C37233c6FeE3aB8b`
- **MorphoYieldAdapter:** `0xb2dAb46E04c875E6C8c1B966cFC3E1f40f063e90`
- **Chain:** Ethereum Sepolia (`11155111`)
- **Draw interval:** `86400` seconds (24 hours)
- **Withdrawal batch interval:** `300` seconds; delivery continues automatically
  after settlement, subject to proof availability and market liquidity.
- **Pool deployment transaction:** `0x2f4bd61e8879daf74a709c9bda2acea4c63b37d85a35aaf1c65c3b002153d904`
- **Keeper scan start block:** `11719086`

Frontend env values:

```bash
NEXT_PUBLIC_USDC_ADDRESS=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238
NEXT_PUBLIC_CONFIDENTIAL_USDC_ADDRESS=0x6B26B258436bcCE719Be8F9B30F87FDFD9BdFA8a
NEXT_PUBLIC_CONFIDENTIAL_PRIZE_POOL_ADDRESS=0xe65D6459a7Ce01315FbB0998C37233c6FeE3aB8b
NEXT_PUBLIC_CHAIN_ID=11155111
```

### Example Sepolia run

The deployed pool has been exercised end to end on Sepolia with real wrapped
USDC deposits, sponsor-funded prizes, round closes, prize claims, and a USDC
withdrawal request. As of August 26, 2026, the pool had closed 8 rounds, started
round 9, and registered 1 participant:
`0x8AEFBA26724c9FD9a1f06E3a65bfd7a8004d2F79`.

Useful example transactions:

- Initial zero-prize close for round 1:
  `0x467a5b4fbef7ad249c915a1619babd5fd1b7ff2ba17a9893fa8552e50e9e724b`
- Prize funding of `1.000000` USDC for round 2:
  `0xc6b2d346173cffc926cc0b88872eaf2be934a54d861ff264026aa8357622d348`
- Second prize funding of `1.000000` USDC for round 2:
  `0xb8f6452f178868186a612813bf69af595f953ccbe9833ad91bfbc6684070c315`
- Round 2 close over the funded prize reserve:
  `0x9cc90c2e47644068f128f568c74dba119e41186d74ae06d6dbd50e9686d80be6`
- Deposit with decrypt delegate update:
  `0xda63b1918d1a022db8bc8fc506b62c434e05bc0f81b6f8263b270f79fe775368`
- Prize claim after a later round:
  `0x322964721c739ba894ea8fb98a70c33782562c3e911f736543535213bfdd52a7`
- USDC withdrawal request:
  `0xc1a105950198e87adb5d43d998a44444e227d30bd430dd0675cf2b74a0948bd0`
- Round 8 close and round 9 start:
  `0xf3ee88144c386ae78bae23e44181dbb03972645bfeacb3864dce57865f4c7478`
- Prize claim after round 8:
  `0xe9028ea4edc3caafc5a70d3f78fa2b95a75497c78faaa3b4b600fddb9048f7d9`

Explorer links use the Sepolia Etherscan transaction URL format:
`https://sepolia.etherscan.io/tx/<hash>`.

## How to test the live app

Use the hosted app at https://kettigo.xyz.

1. Create an account in the app.
2. Fund that account with Circle's faucet: https://faucet.circle.com.
3. Deposit some funds for saving. To test weighted winner selection, repeat
   this with more than one account.
4. Go to the admin tab and close the current round. A new round starts
   automatically.
5. Fund the new round from the admin tab.
6. Wait for the round to end, close it, then check and claim any prize.
7. Fund each new round before testing it. This sponsor-funded amount stands in
   for the yield that would fund prizes in a production PoolTogether-style pool.

## Architecture

### Bounty target

- **Network:** Ethereum Sepolia only.
- **Token:** Circle's official Sepolia USDC
  (`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`) plus an ERC-7984 confidential
  wrapper. `MockUSDC` remains only for local Hardhat tests.
- **Accounting:** individual deposits, balances, shares, and winnings encrypted
  onchain.
- **Draw:** deposit-weighted winner selection over encrypted balances using
  Zama FHE randomness. No offchain RNG and no plaintext balance calculation.
- **Claim/decryption:** winner-only confidential prize flow plus Zama EIP-712
  user decryption.
- **Prize/yield:** the global prize amount is public for UX. It is currently
  mocked by sponsor/admin funding on Sepolia; Aave/Morpho/Superlend-style yield
  can replace that funding source later.
- **PoolTogether:** mechanic reference only; no official protocol dependency.

### Morpho Yield Flow

The Morpho integration keeps the user's direct action confidential: users only
deposit `cUSDC` into `ConfidentialPrizePool`. They never deposit into Morpho
directly and Morpho positions are not used as per-user balances.
See [docs/PRIVACY_AND_KEEPER.md](docs/PRIVACY_AND_KEEPER.md) for the current
keeper cadence and privacy tradeoffs.

The pool enforces a first-phase `1,000 USDC` principal limit per account. After
deposits arrive, `ConfidentialPrizePool` accumulates encrypted pending principal.
A keeper runs on a timed cadence, default `MORPHO_UNWRAP_INTERVAL_SECONDS=300`,
and requests one `ConfidentialUSDC.unwrap` with `MorphoYieldAdapter` as the USDC
receiver. That request reveals only the finalized window amount, not each
depositor's amount. On the next ready run, the keeper obtains Zama's public
decryption proof, finalizes the unwrap, and calls
`supplyAvailableMorphoPrincipal()` so the adapter supplies all available USDC
to Morpho Blue. Idle runs accrue Morpho's lazy interest accounting before
harvesting any observable surplus into the prize reserve. The keeper still
checks routing work every five minutes, but it waits at least one hour between
explicit Morpho accruals so sub-base-unit interest is not repeatedly rounded
away in this small test market.

The adapter tracks pool principal separately from market value. The prize is the
surplus reported by `accruedYieldAssets()`: current Morpho supplied assets minus
tracked principal. When the keeper calls `harvestMorphoYield(maxAssets)`,
the pool instructs the adapter to withdraw only that surplus, wrap it back into
`cUSDC`, and send it to `ConfidentialPrizePool` using the existing
`PRIZE_FUNDING_DATA` callback. The pool then holds the harvested yield as the
active prize reserve. The smallest harvestable prize is one USDC base unit:
`0.000001 USDC`.

If the pool needs more withdrawal liquidity, the owner/keeper calls
`restoreMorphoPrincipal(assets)`. The adapter withdraws principal from Morpho,
wraps the returned USDC as `cUSDC`, and transfers it back to the pool. User
withdrawals still reduce encrypted principal and pay from the pool's `cUSDC`
balance, so keep enough restored liquidity available before large withdrawals.

Sepolia defaults:

```bash
MORPHO_BLUE_ADDRESS=0xd011EE229E7459ba1ddd22631eF7bF528d424A14
MORPHO_MARKET_ID=0x8c561f0929c3a3e2b20fba99c2ae15fc57b4d0599e4371b67c9a58388a27b9d2
MORPHO_UNWRAP_INTERVAL_SECONDS=300
```

Netlify keeper env values:

```bash
SEPOLIA_RPC_URL=https://...
KEEPER_PRIVATE_KEY=0x...
MORPHO_KEEPER_START_BLOCK=11711000
MORPHO_KEEPER_MAX_TXS=1
```

### Automatic withdrawal delivery

The updated pool accepts one `requestWithdrawal` transaction from the user.
After the batch closes, the withdrawal keeper settles its backing, calls
`processWithdrawal(batchId, account)`, and finalizes the wrapper request. The
permissionless payout always sends to that account; the keeper cannot choose a
different recipient. Every transaction receipt is checked before advancing.
The user does not need to keep the app open or approve another transaction.

From the repository root, run `pnpm keeper:watch` for continuous local processing
(Ctrl+C stops it). `pnpm keeper:all` performs one pass. The watcher runs the
Morpho and withdrawal keepers sequentially, retries every 15 seconds after each
pass, and continues with withdrawals even if the Morpho keeper fails.
Node 24 and the local keeper environment are required. Check configuration
without sending transactions with `npm run keeper:withdrawal -- --check`.

Withdrawal runs report confirmed `transactions` and unresolved `pending` work.
Failed batches do not block other payouts. Requests are scanned from the first
batch, so old requests do not fall out of a lookback window. This full scan is
appropriate for the bounded demo; a long-running production service needs a
durable cursor and pending-work index before batch history grows large.
The savings screen refreshes pending delivery and wallet USDC automatically.
Unknown amounts display as pending, never as zero USDC.

The Netlify function is scheduled every minute, but automatic delivery requires
that scheduled service to be deployed and running, or the local watcher to remain
running. Local one-shot commands do not establish a background service.
The previous pool at `0x92938dbFFa6A7De3dd2a009e10f5d2100fA594e6` cannot perform
the new permissionless payout. It is no longer selected by the local app. Old
requests are not migrated into the replacement pool.

To verify a live round trip with the configured deployer, fund that account with
at least 1 Sepolia USDC. The smoke script defaults to read-only status; the two
explicit write steps deposit 1 USDC and request its withdrawal. Run from
`packages/contracts`:

```bash
WITHDRAWAL_SMOKE_STEP=deposit pnpm exec hardhat run scripts/smoke-withdrawal.ts --network sepolia
# Wait for the running Morpho keeper to supply the deposit.
WITHDRAWAL_SMOKE_STEP=request pnpm exec hardhat run scripts/smoke-withdrawal.ts --network sepolia
# Wait for the withdrawal keeper to deliver USDC, then verify:
pnpm exec hardhat run scripts/smoke-withdrawal.ts --network sepolia
```

The script stores its evidence in ignored `cache/withdrawal-smoke-*.json`, refuses
to repeat recorded deposit/request steps, and reports `roundTripVerified: true`
only after wrapper finalization and restoration of the original USDC balance.
Avoid other transfers on that test account during the run. Coordinate write steps
with the keeper if both use the same signer to avoid competing transaction nonces.

Current confidential architecture:

```
                        ┌─────────────────────┐
                        │      Passkey        │
                        │ (WebAuthn / ES256)  │
                        └──────────┬──────────┘
                                   │ owner signer
                                   ▼
                        ┌─────────────────────┐
                        │   Safe smart acct   │ ← Protocol Kit + viem
                        │  (ERC-4337, EP 0.7) │
                        └──────────┬──────────┘
                                   │ signed UserOp
                                   ▼
                        ┌─────────────────────┐
                        │       Pimlico       │ ← bundler + paymaster
                        └──────────┬──────────┘
                                   │ sponsored tx
                                   ▼
        ┌──────────────────────────────────────────────────┐
        │                  Ethereum Sepolia                │
        │                                                  │
        │  USDC ──► ConfidentialUSDC ──► ConfidentialPrizePool │
        │             ERC-7984 cUSDC          │                │
        │                   ▲                 │ FHE draw       │
        │                   │                 ▼                │
        │           MorphoYieldAdapter  private winnings       │
        │                   ▲                 │                │
        │                   └──── USDC ◄──── unwrap batches    │
        │                         │                            │
        │                         ▼                            │
        │                    Morpho Blue                       │
        └──────────────────────────────────────────────────┘
```

### ConfidentialPrizePool contract analysis

`ConfidentialPrizePool` is the active bounty contract at
`packages/contracts/contracts/ConfidentialPrizePool.sol`.

- Deposits arrive through `ConfidentialUSDC.confidentialTransferAndCall`.
  Normal transfer callbacks increase the sender's encrypted principal and the
  encrypted total principal, then grant decrypt access to the account and its
  optional delegate. If Morpho is enabled, the pool also adds the deposit amount
  to an encrypted pending-Morpho batch.
- Morpho principal movement is keeper-timed. Once `morphoUnwrapInterval` has
  elapsed and deposit activity exists, the keeper requests one unwrap for the
  encrypted pending batch and sends the resulting USDC to `MorphoYieldAdapter`.
  After unwrap finalization, the keeper calls `supplyAvailableMorphoPrincipal`.
- Prize funding uses callback data prefixed with `PRIZE_FUNDING_DATA`. The
  encrypted cUSDC reserve is held by the pool, while the same amount is mirrored
  in `publicPrizeReserve` so the app can show the active prize. Morpho-harvested
  yield uses this same callback after the adapter wraps harvested USDC.
- Draw closing is permissionless once `nextDrawAt` has passed. The contract
  scales a 64-bit encrypted random word by encrypted total principal, then
  scans the bounded participant list using encrypted cumulative balances.
- Winner credit is private. Each participant's encrypted winnings are updated
  with `FHE.select`, and only that account or its decrypt delegate receives
  decrypt access.
- Claims transfer encrypted cUSDC winnings to the caller and reset their
  encrypted winnings handle.
- Immediate Sepolia withdrawals accept an encrypted requested amount, cap it
  with `FHE.min(requested, principal)`, reduce encrypted principal, and either
  return cUSDC or create an underlying USDC unwrap request. The mainnet path
  also supports queued withdrawal batches: requests reduce active principal
  immediately, aggregate encrypted batch liabilities, restore liquidity from
  Morpho, and let users claim their encrypted amount after the batch is funded.
- The no-loss invariant is principal-backed by pool-held cUSDC plus queued
  withdrawal liquidity restored from Morpho. Prize funds sit in the separate
  encrypted prize reserve and are not consumed by withdrawal.

Important current limitations:

- `MAX_PARTICIPANTS` is 32, which is appropriate for the Sepolia FHE demo but
  not a scalable production participant set.
- Draw eligibility uses live balances at close time. The next hardening step is
  a draw-start snapshot so late deposits or withdrawals cannot affect the same
  round's odds.
- Draw selection uses 128-bit encrypted scaling:
  `floor(random64 * encryptedTotalPrincipal / 2^64)`. The maximum aggregate
  principal is bounded by `MAX_PARTICIPANTS * MAX_USER_PRINCIPAL`, keeping the
  scaled product inside 128 bits while avoiding a fixed public ticket range.
- Withdrawal batches currently use a trusted clear aggregate amount at restore
  time. The remaining mainnet hardening step is to replace that input with the
  Zama public-decryption proof flow and keeper reconciliation.
- Participant addresses, participant count, transaction timing, draw timing,
  public prize funding amounts, and the configured draw interval are visible.
  Individual principal, total principal, random ticket, prize credit, and
  winnings remain encrypted.

## Current implementation status

- **Confidential lifecycle is deployed and working end to end on Sepolia.**
  `ConfidentialUSDC` wraps USDC as ERC-7984, and
  `ConfidentialPrizePool` supports encrypted deposits, encrypted-amount
  withdrawals, public mocked prize funding, encrypted winnings, claim, and
  Zama EIP-712 user decryption from the frontend.
- **Draw MVP uses encrypted scaled tickets.** `closeDraw` uses
  `FHE.randEuint64()`, scales it by encrypted total principal in 128-bit FHE
  arithmetic, and compares the resulting encrypted ticket against encrypted
  cumulative principal ranges. This removes the old fixed ticket range that
  could bias ordinary USDC-sized deposits.
- **Zama SDK v3 address handling** must preserve checksum addresses. The app
  normalizes user and contract addresses with `viem.getAddress()` before they
  enter `sdk.encrypt()`, `sdk.decryption.decryptValues()`, or public-decryption
  helpers.
- **Zama EIP-712 signing** is isolated inside the v3 SDK signer adapter. The
  passkey-owned Safe signs for its cUSDC balance, pool principal, and winnings.
- **Morpho yield adapter exists but is not the live judge fallback.** Users
  still deposit only `cUSDC` into `ConfidentialPrizePool`; the keeper requests
  timed principal unwraps to `MorphoYieldAdapter`, the adapter supplies USDC to
  Morpho Blue, and harvested surplus is wrapped back into `cUSDC` as the prize
  reserve. The sponsor-funded path remains available for demos. If an encrypted
  no-winner branch carries funds forward, that carry is intentionally not
  disclosed by the public mirror.
- **Tickets = live share balance**. Should be a snapshot at draw start to
  prevent last-minute deposit/withdraw manipulation.
- **USDC** uses Circle Sepolia USDC for deployment when practical, with
  `MockUSDC` kept for local Hardhat tests and fallback demos.
- **Fiat on-ramp** is out of scope for this MVP. Add MB Way via Onramper or
  Stripe's on-ramp.
- **Legal** — "no-loss lottery" lives in a grey zone in PT (SRIJ) and EU. Get
  legal sign-off before any mainnet or marketing.

## Where to go from here

1. Keep the funded Netlify app and Sepolia contracts available for judges:
   https://kettigo.xyz.
2. Record the real-person demo using the verified hosted flow.
3. Publish the X thread/article and add the final link here.
4. Continue hardening after submission: draw-start snapshots, larger participant
   sets, real yield integration, and production legal review.
