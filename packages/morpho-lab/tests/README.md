# Workbench Regression Checks

Run commands from the repository root. These checks use disposable local state;
they do not access a wallet extension or send transactions to a live network.

## Component Browser Check

Requires Playwright with Chromium installed. If Playwright is installed outside
this workspace, set `PLAYWRIGHT_MODULE` to its absolute `index.mjs` path.

```sh
node packages/morpho-lab/tests/workbench-fix.browser.mjs
```

The script starts and closes its own Vite server. It renders the real components
and calls the real action runners with controlled transaction boundaries. It
checks the collateral-to-borrow refresh transition on success and failure, plus
the accrued repayment estimate and explicit approval-limit review.

The final-review browser regression also checks desktop/mobile funding layout,
the disconnected funding guard, configuration-error mounting, clipboard-denial
feedback, and initialization of the Zama SDK's WASM assets under the lab's Vite
configuration:

```sh
node packages/morpho-lab/tests/final-fix.browser.mjs
```

It writes desktop/mobile screenshots into the local final-review report
directory under `.superpowers/sdd/2026-09-17-morpho-lab/`. It does not generate a
live Zama proof or submit funding.

## Local Morpho EVM Check

Requires solc **0.8.19** and the official Morpho Blue source checkout at commit
`8e26ca6a8dbc5089edcd67fb576248810fd2870a`. Set `SOLC_MODULE` to the compiler's
absolute `index.js` path if it is not the workspace's compiler.

```sh
git clone https://github.com/morpho-org/morpho-blue.git /tmp/morpho-blue-reference
git -C /tmp/morpho-blue-reference checkout 8e26ca6a8dbc5089edcd67fb576248810fd2870a
MORPHO_SOURCE=/tmp/morpho-blue-reference node packages/morpho-lab/tests/repay-all.evm.mjs
```

The script compiles the unmodified official Morpho contract with small token,
rate, and oracle fixtures. It runs an in-memory Hardhat chain with ID `11155111`,
creates a market, supplies collateral, and borrows. It advances time while stored
totals remain unchanged, checks the accrued borrow and collateral withdrawal
limits, and proves protocol simulation alone accepts borrowing above the lab's
80% margin. It proves a stored-debt-only approval fails, then executes
the production repayment runner with a fixed reviewed allowance. More time
advances between review, approval, and repayment. The final assertions require
zero borrow shares, an actual payment above stored debt but below the reviewed
limit, and the correctly decremented residual allowance.

The fixed-rate fixture makes the accrual regression deterministic. Wallet
extension interaction and the deployed market are covered separately.
