# Kettigo Morpho Lab

This is a local technical playground for inspecting the Kettigo Morpho
integration against one fixed Ethereum Sepolia deployment. It is not part of
the hosted consumer app and is not a deployed or hosted operator service.

## Start locally

From the repository root:

```bash
npm run lab:dev
# open http://localhost:3001
```

The Vite server binds to `127.0.0.1` and uses port `3001`. It intentionally
does not share the consumer app's port.

## Wallet and network

The lab supports MetaMask only. Install MetaMask, select Ethereum Sepolia
(`11155111`), and connect an account when prompted. The dashboard can read
the configured deployment without a wallet; connecting a wallet adds the
account position and enables the workbench. When MetaMask is on another chain,
the lab offers a switch to Sepolia before actions can run.

Before confirming any action in MetaMask, review its recipient, calldata, and
amount. A simulation runs before the confirmation prompt, but a successful
simulation is not a guarantee that a later submitted transaction will succeed.

## Fixed deployment

The lab defaults to the current Sepolia deployment. These addresses are shown
in the dashboard and checked against the adapter and Morpho market parameters:

| Component | Address or value |
| --- | --- |
| Chain | Ethereum Sepolia (`11155111`) |
| USDC | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| WETH | `0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9` |
| ConfidentialUSDC wrapper | `0xe64c1836b96253104a753E60188f691173Ded624` |
| ConfidentialPrizePool | `0x30530991e296a663a32567C170b290fB88578408` |
| MorphoYieldAdapter | `0x6c180a345F6eA433AfE59c35c2a611B0d15d1c09` |
| Morpho Blue | `0xd011EE229E7459ba1ddd22631eF7bF528d424A14` |
| Morpho market ID | `0x8c561f0929c3a3e2b20fba99c2ae15fc57b4d0599e4371b67c9a58388a27b9d2` |

It is deliberately local-only and fixed to this deployment. Do not treat an
environment override as a general deployment configuration or as evidence
that another contract set is supported.

## Environment overrides

Create `packages/morpho-lab/.env.local` only when a controlled local check
needs a different RPC endpoint or the same deployment values supplied
explicitly. Vite exposes only the following variables:

```bash
VITE_SEPOLIA_RPC_URL=https://your-sepolia-rpc.example
VITE_USDC_ADDRESS=0x...
VITE_WETH_ADDRESS=0x...
VITE_WRAPPER_ADDRESS=0x...
VITE_POOL_ADDRESS=0x...
VITE_ADAPTER_ADDRESS=0x...
VITE_MORPHO_ADDRESS=0x...
VITE_MORPHO_MARKET_ID=0x...
```

All addresses must be valid Ethereum addresses and the market ID must be a
32-byte hex value. The lab always uses chain ID `11155111`; it cannot be
pointed at another network.

## Dashboard and actions

The dashboard reads the configured deployment, pool, adapter, Morpho market,
and connected-account position at one block. It exposes direct links and copy
controls for the addresses and market ID so an operator can compare them with
an RPC or explorer read.

The workbench can prepare these actions:

- Wrap or unwrap ETH and WETH.
- Supply or withdraw USDC liquidity.
- Supply or withdraw WETH collateral.
- Borrow USDC, repay a chosen amount, or prepare a repay-all review.
- Prepare a paired collateral-and-borrow utilization increase.
- Close a draw only when the configured pool reports it is due.
- Sponsor the prize with USDC through the round controls.

Prize funding reviews an exact USDC amount, approves only that amount to the
wrapper when its allowance is insufficient, then wraps and transfers it to the
pool in one atomic wrapper multicall. The transfer uses the pool's
`PRIZE_FUNDING_DATA` selector followed by the ABI-encoded `uint64` amount,
and a Zama input proof bound to the checksummed wrapper and MetaMask account.
Both approval and funding are simulated before MetaMask submission. A stopped
sequence may leave its confirmed approval in place, but wrapping and funding
cannot complete separately. Funding requires the Zama relayer to be available.

Debt, account supplied assets, utilization, borrowing capacity, and collateral
withdrawal limits include interest accrued through the snapshot's block time.
Supplier APR is a simple annualized estimate after the market fee, not an APY.
Remaining LLTV capacity is the protocol limit; the workbench additionally caps
borrowing at 80% of that limit and available liquidity. If the borrow rate
cannot be read, interest-dependent values are unavailable and actions that
need those estimates stop. Snapshot estimates cannot include time after the
snapshot or later oracle changes.

Market totals and adapter `suppliedAssets` remain the contract's stored/view
values. The adapter backing difference is `suppliedAssets - suppliedPrincipal`,
including its idle rounding reserve once; USDC awaiting supply is shown
separately. It is a signed accounting difference, not an assertion that all
backing can be withdrawn immediately. Allowances identify their spender:
wrapper for prize funding, Morpho for lending and collateral. ETH balances are
from the same block-pinned snapshot and refresh with the dashboard.

Each workbench write is simulated first, then requires an explicit MetaMask
confirmation. The lab rejects values outside its calculated balance,
liquidity, and health limits before it asks MetaMask to submit them. A failed
or rejected confirmation is shown as a recoverable error; confirmed earlier
steps in a multi-step sequence remain confirmed.
Wallet cancellation or replacement with different calldata, value, or recipient
stops the sequence. A gas-only speed-up retains the action and updates its
transaction link to the replacement hash.

Borrowing and collateral withdrawal can make an account liquidatable. Market
price, accrued interest, liquidity, and the liquidation threshold can change
between a dashboard read, simulation, and transaction confirmation. Use only
amounts you are authorized to risk, leave a material health margin, and verify
the refreshed position after every confirmed action.

## Checks

From the repository root, the lab's focused checks are:

```bash
npm run lab:test -- --run
npm run lab:typecheck
npm run lab:build
```

`tests/README.md` documents the optional controlled browser regression check
and local Morpho EVM fixture check. Those checks use controlled providers and
disposable state; they do not require or submit a MetaMask transaction.
