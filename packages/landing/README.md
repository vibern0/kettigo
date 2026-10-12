# Kettigo Landing Operations

This package is the standalone public landing site and email waitlist. It builds
a Vite React frontend and a same-origin Cloudflare Worker that serves static
assets and writes D1-backed waitlist rows.

It does not connect wallets, read contracts, or change the product app
deployment. App entry is handled by `packages/web`, which reads the same
approval table.

## Local Setup

Install workspace dependencies from the repository root:

```bash
npm install
```

Run the local site:

```bash
npm run landing:dev
```

Run the automated landing checks:

```bash
npm run landing:typecheck
npm run landing:test
npm run landing:build
```

## Local D1 And Approval

Apply the local D1 migration:

```bash
npm exec --workspace @kettigo/landing wrangler d1 migrations apply kettigo-landing-local --local
```

Join the waitlist from the browser with any email. Approve an email directly in
D1 by setting `approved_at`:

```bash
npm exec --workspace @kettigo/landing wrangler d1 execute kettigo-landing-local --local --command "UPDATE waitlist_entries SET approved_at = datetime('now') WHERE email_normalized = 'person@example.com';"
```

## Production D1

The shared production D1 database is already provisioned as `kettigo` with ID
`d6cfede8-60bb-45dc-b342-60e6da48f1e4`. Verify it from `packages/landing`
before applying migrations or deploying:

```bash
npm exec --workspace @kettigo/landing wrangler d1 info kettigo
```

Stop if the reported name or ID differs. Keep the `DB` binding name unchanged,
and do not create or rebind the production database during a routine deploy.

Apply the migration to the remote D1 database after the ID is configured:

```bash
npm exec --workspace @kettigo/landing wrangler d1 migrations apply kettigo --remote
```

The web Worker has its own Wrangler config at `packages/web/wrangler.jsonc`.
Keep its `database_name` and `database_id` synchronized with this config so
both Workers use the same `DB` binding and schema.

The landing Worker explicitly sets an empty Cron Trigger list. Keep this in
place: the app Worker owns scheduled keeper work, while the landing Worker
only serves the site and waitlist. Wrangler otherwise leaves an existing
dashboard Cron Trigger attached when `crons` is omitted. Its no-op scheduled
handler is only a rollout safeguard; it must not replace removing accidental
triggers.

Approve remote emails with a targeted D1 update after reviewing the row.

## Production deployment

The two Workers have separate deployment targets:

| Site | Worker | Wrangler config |
| --- | --- | --- |
| `https://kettigo.xyz` | `kettigo-landing` | `wrangler.toml` (mirrors `packages/landing/wrangler.jsonc`) |
| `https://app.kettigo.xyz` | `kettigo` | `packages/web/wrangler.jsonc` |

Use the repository's pinned `pnpm@10.11.1` from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter @kettigo/landing build
pnpm exec wrangler deploy --config packages/landing/wrangler.jsonc --dry-run
npm run landing:deploy
```

The deploy script also applies the empty Cron Trigger list after uploading the
Worker. Keep that step so stale keeper schedules are removed.

The landing config owns the `kettigo.xyz` custom domain. The root
`wrangler.toml` and `cf:build` script target the landing Worker because
Cloudflare Workers Builds reads the repository-root convention. Keep the root
config synchronized with `packages/landing/wrangler.jsonc`. The app remains
isolated in `packages/web/wrangler.jsonc` and must always be deployed with that
explicit config path.

Cloudflare Workers Builds settings for `kettigo-landing`:

- Production branch: `main`
- Root directory: `/`
- Build command: `pnpm run landing:build`
- Deploy command: `pnpm run landing:deploy`
- Preview branch builds: enabled (required for PR checks)
- Previews Base build command: `pnpm run cf:build`
- Preview command: `npx wrangler preview`

Keep these repository scripts in the hosted build settings; the landing deploy
script supplies the explicit config path. A manual landing deployment alone
does not repair an incorrect automatic build trigger.
After deploying, confirm the apex loads `/assets/` landing bundles and shows
“Make your USDC feel lucky.”, while `app.kettigo.xyz` still loads the app's
`/_next/` bundles. Recheck after an automatic build from `main`.

## Production Smoke Tests

Exercise these flows against the preview URL before routing public traffic:

- Waitlist join: a new email returns the joined success state and inserts one
  row with `approved_at` empty.
- Replay: submitting the same email again returns the idempotent success state
  and does not add another row.
- Manual approval: setting `approved_at` in D1 lets the same email enter the app
  after wallet sign-in.
- Reuse prevention: after the first wallet signature is saved, a different
  wallet/signature for that email is rejected by the app gate.
- Attribution: only `utm_source`, `utm_medium`, `utm_campaign`, `ref`, and the
  referrer hostname are stored within the documented limits.
- Privacy: logs and D1 rows contain no IP address, user agent, or full referrer
  URL.

## Rollback

List deployments and identify the previous good Worker version:

```bash
npm exec --workspace @kettigo/landing wrangler deployments list
```

Restore the previous Worker version:

```bash
npm exec --workspace @kettigo/landing wrangler rollback <version-id>
```

The waitlist migrations are additive for data retention. Leave them in place
during Worker rollback because dropping waitlist data is not a safe rollback.

## Manual Browser Review

After starting `npm run landing:dev`, inspect 320px, 390px, 768px, 1024px, and
1440px widths. Confirm there is no horizontal scrolling; keyboard navigation
reaches every control; focus is visible; reduced-motion mode suppresses motion;
CTA anchors land on the expected sections; status messages receive focus after
submission; temporary failures keep form values; and no request reaches smart
contracts.

## Operator Checklist

- `npm install`
- `npm run landing:typecheck`
- `npm run landing:test`
- `npm run landing:build`
- Local migration and email approval succeed.
- Production D1 reports `kettigo` / `d6cfede8-60bb-45dc-b342-60e6da48f1e4`.
- Remote migration applies before remote approvals.
- Preview deployment passes waitlist join, replay, approval, and app gate smoke
  tests before the custom domain is connected.
