# Kettigo — Web (PWA)

Mobile-first PWA. Next.js 15 (App Router) + Tailwind + wagmi v2 + Safe
passkeys + Pimlico.

Live app: https://kettigo.xyz

## Stack

- **Next.js 15** — App Router, RSC where it makes sense, `"use client"` for
  anything wallet-related.
- **Tailwind 3** — custom design tokens in `tailwind.config.ts` (dark theme,
  mobile-first `.app-shell`).
- **wagmi v2** + **viem v2** — chain reads, contract calls, event watching.
- **WebAuthn passkeys** — a discoverable ES256 credential is the sole owner.
- **Safe Protocol Kit** — deterministic Safe 1.4.1 account with the Safe
  ERC-4337 module and EntryPoint v0.7. Pimlico is the bundler + paymaster.

## Pages

| Path | Purpose |
| --- | --- |
| `/` | Landing — hero, next-draw countdown, connect CTA, "how it works". |
| `/savings` | Deposit / withdraw USDC, see balance + tickets. |
| `/draw` | Current draw — countdown, prize pool, sponsor / close. |
| `/history` | Last 20 draws, winners. |
| `/profile` | Smart account, balances, network info, sign out. |

## Setup

```bash
cp .env.example .env.local
# fill in:
#   NEXT_PUBLIC_USDC_ADDRESS, NEXT_PUBLIC_CONFIDENTIAL_USDC_ADDRESS
#   NEXT_PUBLIC_CONFIDENTIAL_PRIZE_POOL_ADDRESS
#   NEXT_PUBLIC_PASSKEY_RP_ID, NEXT_PUBLIC_PASSKEY_RP_NAME
#   NEXT_PUBLIC_PIMLICO_API_KEY
pnpm run dev
```

Netlify also runs the Morpho keeper as a Scheduled Function. Configure these as
private Netlify environment variables, not `NEXT_PUBLIC_*`:

```bash
SEPOLIA_RPC_URL=https://...
KEEPER_PRIVATE_KEY=0x...
MORPHO_KEEPER_START_BLOCK=11730807
MORPHO_KEEPER_MAX_TXS=1
WITHDRAWAL_KEEPER_LOOKBACK_BATCHES=8
```

The Morpho function checks deposit-routing work every five minutes and limits
idle Morpho interest accrual to once per hour to reduce extra base-unit rounding
in a small market. Each ready `closeDraw()` separately accrues interest and
harvests the resulting surplus for that draw. The withdrawal function runs every
minute, scans recent batches, closes expired nonempty batches, and settles closed
batches once their public-decryption proof is available.

## Cloudflare Worker deployment

The web Worker owns its deployment configuration in
`packages/web/wrangler.jsonc`. Its `DB` binding points to the same D1 database
as the landing Worker, while its assets and entry point remain package-local.

Build and deploy from the repository root:

```bash
pnpm run cf:build
pnpm exec wrangler deploy --config packages/web/wrangler.jsonc
```

Apply the shared landing migrations to the configured remote database with:

```bash
pnpm exec wrangler d1 migrations apply kettigo --remote --config packages/web/wrangler.jsonc
```

## Where things live

```
src/
  app/
    layout.tsx           # font, metadata, providers
    providers.tsx        # wagmi + react-query + wallet
    page.tsx             # landing
    savings/page.tsx     # deposit/withdraw form
    draw/page.tsx        # active draw
    history/page.tsx     # past draws
    profile/page.tsx     # account info
  components/
    Header.tsx           # top nav + connect button
    ConnectButton.tsx    # create/open passkey account CTA
    Countdown.tsx        # draw countdown timer
  lib/
    contracts.ts         # addresses, ABIs, RPC, Pimlico URL
    wagmi.ts             # wagmi config (Sepolia)
    passkey-safe.ts      # passkey-owned Safe + Pimlico flow
    passkey-webauthn.ts  # browser credential creation and assertion
    wallet-context.tsx   # React context exposing session
    usePoolData.ts       # wagmi hooks for prize-pool reads
    morpho-keeper.ts     # scheduled keeper decision logic
    withdrawal-keeper.ts # scheduled withdrawal settlement decisions
    format.ts            # USDC + countdown formatters
    cn.ts                # tailwind-merge className helper
```

## Notes

- All contract calls go through the passkey-owned Safe (Pimlico bundler +
  paymaster), so the user signs sponsored UserOperations through the Safe.
- USDC `approve` is a one-time setup per session, sent as its own UserOp.

## Passkey acceptance run

Configure a deployed contract set and a funded Pimlico account before this
manual browser gate:

1. Use an approved email and create a passkey. Record the checksum Safe address.
2. Submit a sponsored transaction and confirm Safe 1.4.1 is deployed through
   EntryPoint v0.7.
3. Deposit, then use the Safe-backed Zama signer to complete balance decryption.
4. Reload the app, open the saved account, and confirm it derives the same Safe address
   before completing another sponsored action.

Passkey recovery and migration from older account types are not supported in
this phase. Clearing site data or losing access to the passkey can make the Safe
inaccessible. The app stores only public credential metadata needed to derive
the account; it never stores the credential secret.
