# Kettigo Go-To-Market

## Summary

Kettigo has a real user and investor wedge, but it should not launch as a
generic savings app. The strongest near-term market is crypto-native USDC users
who understand onchain deposits, like prize-based upside, and care that their
balances and winnings are not exposed to everyone.

The broader prize-linked savings category has behavioral evidence from consumer
finance research. PoolTogether validates that the mechanic can work onchain,
but it is a competitor and a market reference, not a user-acquisition channel.
Kettigo's differentiated angle is private prize-linked stablecoin savings:
users keep their principal, stay eligible for deposit-weighted prizes, and avoid
making personal savings activity fully visible onchain.

Before mainnet, the public conversion goal is a qualified waitlist. The current
Sepolia product is a gated research environment for invited participants, not
the main destination for broad marketing traffic.

## Product Positioning

Kettigo is a no-loss USDC savings app where every saved dollar gives the user
more chances to win prizes.

For internal strategy, the differentiator is confidential prize-linked savings:
encrypted balances, deposit-weighted onchain draws, private winnings, and user
controlled decryption. For public product copy, follow the repository copy
rules: do not use words such as encrypted, confidential, private, public,
decrypted, mock, testnet, Sepolia, prototype, faucet, or leakage in user-facing
UI or marketing copy.

Recommended public positioning:

> Save in USDC. Stay in control of your money. Get chances to win at the end of
> each draw.

## Evidence Of Demand

### Prize-linked savings has behavioral demand

Prize-linked savings products have existed globally for centuries and have been
studied as a way to turn lottery-like motivation into savings behavior. NBER's
overview argues these products may be especially popular among low- and
moderate-income non-savers in the United States.

Source: [NBER, "Making Savers Winners"](https://www.nber.org/papers/w16433)

An IZA discussion paper found that adding prize-linked savings options can
increase total savings and reduce lottery expenditures, especially among people
with lower savings and income.

Source: [IZA, "Savings and Prize-Linked Savings Accounts"](https://www.iza.org/publications/dp/6927)

### Consumer fintech products proved interest, but not durable trust

Yotta showed that a prize-linked savings app can acquire mainstream users. In
January 2021, Forbes reported that Yotta had raised a $13.2M Series A led by
Base10 Partners, had roughly $200M deposited, 130,000 signups, 90,000 users with
a balance, and 60,000 users with tickets that week. Its later exposure to the
Synapse failure and the continuing consumer-redress process make it a warning
about operational transparency and withdrawal trust, not only a growth example.

Source: [Forbes, Yotta Series A](https://www.forbes.com/sites/igorbosilkovski/2021/01/28/savings-account-app-yotta-raises-13-million-in-series-a/)

Source: [Yotta payment-processing updates](https://www.withyotta.com/payment-processing-updates)

PrizePool also showed investor and user demand. In June 2021, PrizePool
announced a $10M Series A led by M13, with seed investors including Accomplice,
Bling Capital, World Innovation Lab, and Coatue. The announcement said PrizePool
had attracted tens of thousands of savers, tens of millions of dollars saved,
70% weekly app return behavior, and about 10,000 prize winners. The consumer app
was subsequently wound down in 2024. Its historical adoption supports the
behavioral thesis, but it should not be presented as a current success.

Source: [PrizePool Series A announcement](https://www.globenewswire.com/news-release/2021/06/02/2240464/0/en/prize-linked-savings-startup-prizepool-announces-10m-in-series-a-funding.html)

Source: [PrizePool consumer-app closure](https://www.doctorofcredit.com/prizepool-savings-review-prized-linked-savings-account/)

### Stablecoin adoption supports the initial market

The Federal Reserve reported that the stablecoin market reached $317 billion in
April 2026 and that retail-sized USDC and USDT wallets grew substantially during
2025. This validates the choice to start with people who already hold and use
stablecoins rather than asking mainstream savers to adopt both a new asset and a
new savings behavior at once.

Source: [Federal Reserve, "Stablecoins in 2025"](https://www.federalreserve.gov/econres/notes/feds-notes/stablecoins-in-2025-developments-and-financial-stability-implications-20260408.html)

### DeFi users already understand no-loss prize pools

PoolTogether proves that crypto-native users will deposit into a no-loss prize
savings protocol. DefiLlama tracks PoolTogether V5 as an active yield-lottery
protocol with current TVL and fee data. Its scale and volatility suggest a real
but narrow category rather than automatic mass-market demand. Kettigo should
learn from that evidence without recruiting from PoolTogether-owned communities.

Source: [DefiLlama, PoolTogether V5](https://enterprise.defillama.com/protocol/pooltogether-v5)

### Privacy-preserving crypto has investor momentum

Zama's funding validates investor interest in FHE and confidential onchain
applications. In March 2024, Zama announced a $73M Series A co-led by Multicoin
Capital and Protocol Labs, with participation from Metaplanet, Blockchange,
VSquared, Stake Capital, Portal Ventures, and strategic founders from major
crypto ecosystems.

Source: [Zama, "The Zama FHE Master Plan"](https://www.zama.org/post/zama-fhe-master-plan)

In June 2025, Zama announced a $57M Series B co-led by Pantera Capital and
Blockchange, bringing total funding to over $150M and valuation north of $1B.
This points to a stronger market narrative around confidential blockchain
applications.

Source: [Zama Series B announcement](https://www.zama.org/post/announcing-the-zama-confidential-blockchain-protocol)

Zama's 2026 protocol update provides stronger product-timing evidence than
funding alone: the mainnet stack is live, official confidential wrappers include
USDC, and Zama now has user-facing portfolio, staking, and bridging products.
That makes the Zama ecosystem the best initial source of technically capable
users who already understand the underlying value.

Source: [Zama Protocol update](https://www.zama.org/post/zama-protocol-update-new-sdk-delegated-decryption-developer-tooling-and-protocol-apps)

## Target Users

### 1. Crypto-native USDC savers

These users already understand wallets, stablecoins, deposits, gas, and DeFi
risk. They are the lowest-friction early adopters.

Why they might use Kettigo:

- They hold idle USDC.
- They like upside but do not want to risk principal in trading.
- They dislike fully visible balances and wallet activity.
- They can tolerate an early web3 onboarding flow.

Where to find them:

- Zama's forum, Discord, Developer Program, product users, and community calls.
- Stablecoin and Ethereum communities where promotional posts are welcome.
- Complementary Safe, WebAuthn, Pimlico, Morpho, and Circle developer
  ecosystems.
- ETHGlobal, FHE, and privacy hackathon alumni.
- The team's direct network and referrals from qualified early members.

### 2. Zama ecosystem early adopters

These users understand confidential assets, tolerate early infrastructure, and
can evaluate whether Kettigo turns Zama's technology into a useful consumer
experience. They are likely to become reviewers and advocates before they
become large depositors.

What to test:

- Whether the savings use case is compelling beyond its technical novelty.
- Whether users prefer larger pooled prizes or more frequent small prizes.
- Whether the claim/check-prize flow feels exciting or too much work.
- Whether a guided preview leads to another voluntary visit or referral.

### 3. Lottery-adjacent savers

These users are attracted to chance-based upside but should not be asked to
learn DeFi first. They are a later segment after onboarding is much simpler.

Why they might use Kettigo:

- The emotional hook is familiar: a chance to win.
- The rational hook is stronger than lottery tickets: principal can be
  withdrawn.
- The habit can become weekly saving instead of weekly spending.

Main blocker:

- Regulatory, trust, custody, and wallet UX questions become much more
  important for mainstream users.

### 4. Privacy-conscious onchain users

These users care less about lottery psychology and more about financial
discretion.

Why they might use Kettigo:

- They do not want public balance tracking.
- They want consumer-friendly examples of confidential DeFi.
- They may become advocates even before they become large depositors.

## Investor Segments

### Best initial investor fit: crypto privacy and infrastructure funds

These investors already believe FHE and confidential smart contracts matter.
They are most likely to understand Kettigo before there is mainstream
traction.

Targets to research and approach:

- Multicoin Capital.
- Protocol Labs.
- Pantera Capital.
- Blockchange.
- Portal Ventures.
- Stake Capital.
- Metaplanet.
- VSquared.
- Zama ecosystem grants and developer programs.

Pitch angle:

> Kettigo is a consumer DeFi app that makes confidential smart contracts
> tangible: private balances, private prize discovery, and a simple savings
> behavior users already understand.

### Second fit: DeFi seed investors

These investors will care about deposits, protocol safety, yield source,
retention, and distribution.

Pitch angle:

> PoolTogether proved no-loss prize savings works in DeFi. Kettigo brings the
> mechanic to confidential stablecoin savings, where privacy is part of the
> product value instead of a technical footnote.

### Third fit: consumer fintech investors

These investors are more likely to wait until Kettigo has real usage,
regulatory clarity, and a simple onboarding path.

Relevant prior investors in the category:

- Base10 Partners.
- Y Combinator.
- Core Innovation Capital.
- Slow Ventures.
- M13.
- Accomplice.
- Bling Capital.
- World Innovation Lab.
- Coatue.

Pitch angle:

> Prize-linked savings apps have already shown consumer demand. Kettigo
> rebuilds the mechanic with user-controlled stablecoin savings and onchain
> transparency where it helps, while shielding personal balances and winnings.

## Competitive Landscape

### PoolTogether

PoolTogether is the most important reference point. It validates the no-loss
prize savings mechanic in DeFi. Kettigo should not compete by claiming to be
"PoolTogether but smaller." It should compete by being the private stablecoin
prize-savings experience. PoolTogether's Discord, forum, Reddit, and other
owned communities are explicitly out of scope as acquisition channels. This
avoids building distribution on a competitor's audience or presenting
Kettigo as a derivative community project.

### Yotta and PrizePool

Yotta and PrizePool validate consumer demand and investor interest. They also
show the risks of relying on opaque fintech infrastructure and partner-bank
chains. Kettigo should learn from their user psychology while avoiding claims
that imply bank-like guarantees.

### Standard yield apps

Aave, Morpho vaults, Superlend-style products, and other yield apps compete for
idle USDC. Kettigo should not try to beat them on APY. The reason to choose
Kettigo is the prize experience, principal control, and personal financial
discretion.

## Core GTM Wedge

Start with the smallest group that can understand the full value:

> Crypto-native USDC holders who want a more exciting way to save and want their
> financial activity to remain their business.

Do not start with mass-market savers. That audience is attractive later, but it
requires stronger compliance, fiat onboarding, education, and trust signals.

## Launch Strategy

### Phase 1: Credibility inside the Zama ecosystem

Goal: turn Kettigo from a bounty demo into a credible showcase of
confidential DeFi.

Actions:

- Submit and promote the Zama bounty build.
- Publish a technical article explaining the confidential draw mechanic.
- Share a short demo video with the full save, draw, check, claim, and withdraw
  loop.
- Ask Zama/OpenZeppelin ecosystem people for technical review and amplification.
- Collect testimonials from developers who understand the difficulty of the FHE
  implementation.

Success metrics:

- Bounty acceptance or recognition.
- Zama ecosystem shares, comments, or introductions.
- Developer GitHub stars, forks, and inbound questions.
- At least 10 high-quality wallet test users.

### Phase 2: DeFi community pilot

Goal: build a qualified waitlist and test whether invited users return for
repeated draws before any broad mainnet launch.

Actions:

- Recruit the first cohort from Zama and complementary infrastructure
  ecosystems, the team's direct network, and qualified referrals.
- Direct broad traffic to a waitlist rather than the live Sepolia application.
- Invite a small subset into guided previews that require no real funds.
- Keep preview draws simple and predictable.
- Track repeat participation, deposits, withdrawals, prize checks, and claims.
- Interview users who deposit more than once and users who churn immediately.

Success metrics:

- Repeat deposit behavior.
- Users checking draw results without reminders.
- Low withdrawal panic after draws.
- Users can explain Kettigo in one sentence.

### Phase 3: Investor-facing traction package

Goal: convert usage into a fundraising narrative.

Actions:

- Prepare a short deck around the wedge, not the full future roadmap.
- Show user behavior, not just cryptography.
- Include protocol architecture, risk controls, and roadmap to audited mainnet.
- Highlight that privacy is a consumer benefit, not only infrastructure.

Success metrics:

- Warm intros to privacy, DeFi, and consumer fintech investors.
- Follow-up meetings after first pitch.
- Investor requests for deposit/retention cohorts.

## Messaging

### Main message

Save in USDC and get chances to win, while staying in control of your money.

### For DeFi users

Kettigo turns USDC saving into a draw: save, stay eligible at the end of each
draw, check whether you won, claim a prize if eligible, and request your money
when you need it.

### Technical positioning for the Zama/FHE ecosystem

This language belongs in technical material and investor conversations, not in
user-facing product copy:

Kettigo is a consumer-grade confidential DeFi use case: encrypted balances,
deposit-weighted FHE draws, private winnings, and user-controlled decryption.

### For investors

Kettigo combines a proven savings behavior with a new privacy primitive. The
initial market is crypto-native USDC savers; the long-term market is anyone who
wants savings upside without turning personal financial activity into a public
feed.

## Risks And Objections

### "Is there enough demand?"

There is historical demand for the mechanic, supported by academic research,
Yotta, PrizePool, and PoolTogether. The fintech examples also suffered serious
trust or durability problems, while the onchain category remains relatively
narrow. The open question is whether Kettigo's combination of prize-based
saving, control, and financial discretion earns repeat behavior.

### "Is this regulated like gambling, banking, or securities?"

This must be reviewed before any real-money public launch. Prize-linked savings
has specific legal treatment in different jurisdictions, and DeFi adds custody,
yield, token, and consumer-protection questions.

### "Will users understand the privacy benefit?"

Not if the product leads with cryptography. The user-facing benefit should be
financial discretion and control. Technical privacy can be explained in docs and
investor material.

### "Can prizes be large enough to matter?"

Prize size depends on pooled deposits, yield, sponsorship, or incentives. Early
launches may need sponsored prizes. Long-term sustainability needs real yield,
protocol incentives, or partner-funded prize campaigns.

### "Will FHE be too slow or expensive?"

This is a product and infrastructure risk. The near-term design should constrain
participant counts, draw cadence, and operations until the technology matures.

## Near-Term Validation Plan

1. Publish a waitlist with source tracking and questions that identify current
   USDC users and preview volunteers.
2. Recruit 20 crypto-native participants from Zama, complementary ecosystems,
   direct outreach, and qualified referrals.
3. Run a structured guided preview where every invited participant completes
   deposit, draw check, claim if eligible, and withdrawal without real funds.
4. Interview every participant with five questions:
   - What made you trust or distrust it?
   - Would you deposit again?
   - Did the chance to win change your behavior?
   - Did privacy matter to you?
   - What part felt confusing or risky?
5. Publish a public build log and technical walkthrough.
6. Turn the results into an investor memo with usage evidence.

## First 30 Days Of Acquisition

### Week 1: Build the funnel

- Make the waitlist the primary public call to action.
- Ask for email, country, current USDC usage, preferred contact handle, and
  willingness to join a short preview.
- Add source and referral attribution.
- Publish a short video showing the save, draw, check, claim, and withdrawal
  loop.

### Week 2: Recruit through Zama

- Publish a Zama Developer Program showcase and ask for feedback.
- Request permission before sharing in community channels.
- Contact technically capable users directly and run two guided group previews.
- Record objections, completion failures, and the language participants use to
  describe the product.

### Week 3: Activate referrals

- Give qualified members a referral link or invite allocation.
- Offer non-financial benefits such as priority consideration, product sessions,
  and influence over draw cadence.
- Do not promise tokens, financial rewards, access, or winnings.
- Publish genuine feedback and a short build story on X and Farcaster.

### Week 4: Add complementary partners

- Approach Zama first, followed by Safe, WebAuthn, Pimlico, Morpho, Circle, and
  ETHGlobal communities where there is a genuine integration story.
- Prefer co-hosted walkthroughs and useful technical content over paid promotion.
- Give every partner a distinct source link and compare qualified-user rates.

Thirty-day targets:

- 100 total waitlist registrations.
- 40 qualified current USDC users.
- 20 user conversations.
- 10 completed guided previews.
- 5 participants who voluntarily return for another draw.

The primary metric is qualified repeat interest, not the raw waitlist count.

## Invite-Only Preview Access

### Initial Cloudflare access model

When the web app moves to Cloudflare, keep the public acquisition funnel and
the invited product experience separate:

- `kettigo.com` remains public and sends visitors to the waitlist. Protect
  the signup form with Cloudflare Turnstile and validate its token server-side.
- `preview.kettigo.com` hosts the invited product experience behind
  Cloudflare Access.
- Add each approved participant's email address to an Access allow policy and
  use Cloudflare's email one-time PIN login. Removing the address revokes future
  access.

This controls the exact preview cohort without adding invite-code logic or an
application database. It is appropriate for the first 20-100 research
participants. The tradeoff is an extra authentication step before the app's passkey,
which is acceptable for a guided preview but can distort measurements of the
eventual consumer onboarding flow.

Sources:

- [Cloudflare Access one-time PIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)
- [Cloudflare Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
- [Cloudflare Turnstile setup](https://developers.cloudflare.com/turnstile/get-started/)

### Later branded invitation flow

Only replace Cloudflare Access when its extra login becomes a measured product
problem. The next stage should use:

- A Cloudflare Worker to issue and redeem invitations.
- Cloudflare D1 for approved identities, hashed invitation codes, cohorts,
  expiration, redemption status, and revocation.
- Turnstile on public waitlist and invitation-redemption forms.
- Random invitation codes bound to the approved email address or wallet.

Do not use Workers KV as the source of truth for single-use invitations. KV is
eventually consistent and is not designed for atomic read-write transactions.
D1 supports transactional batches and is the simpler fit for invitation state.

Sources:

- [Cloudflare D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Workers KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/)

### Mainnet enforcement boundary

Cloudflare controls access to the website, not access to public smart
contracts. An invite-only real-funds beta must enforce eligible wallets and
account caps at the contract layer, in addition to the legal, audit, and launch
gates in [`ROAD_TO_MAINNET.md`](ROAD_TO_MAINNET.md). Cloudflare Access is a
preview and operations control, not a protocol security boundary.

## Recommended Next Assets

- One-page pitch memo.
- Ten-slide investor deck.
- Public technical article.
- Short demo video script.
- User interview script.
- Outreach list of 50 target users and 30 target investors.

## Bottom Line

There are likely users for Kettigo, but the first users are not mainstream
banking customers. They are crypto-native USDC savers, Zama ecosystem early
adopters, and privacy-conscious DeFi participants. There are also investors
interested in the broader space, especially around FHE and confidential
blockchain infrastructure.

The go-to-market should start with a narrow credibility wedge: prove that
private prize-linked USDC savings is useful to people who already understand
DeFi, then expand toward consumer fintech only after onboarding, regulation, and
trust are stronger.
