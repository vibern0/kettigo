# Kettigo Bounty Roadmap

This roadmap targets the Zama Developer Program Mainnet Season 4 bounty. See
[`BOUNTY_SCOPE.md`](BOUNTY_SCOPE.md) for the binding scope decision.

## Phase 0: Freeze the bounty architecture

**Goal:** remove avoidable protocol and wallet complexity before implementation.

- Keep Ethereum Sepolia as the only deployment network.
- Use Circle's official Sepolia USDC as the deployed underlying token:
  `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`. Keep `MockUSDC` only for local
  Hardhat tests and fallback demos.
- Replace the plaintext ERC-4626 `Vault` and `PrizePool` with a confidential
  pool built from Zama/OpenZeppelin confidential-token primitives.
- Use an admin-funded, public global prize as the documented mock yield source.
- Use a passkey-owned Safe and Pimlico as the single account-abstraction path
  for Zama signing and judge testing.
- Defer real yield and mainnet until the required flow works end to end.

**Exit gate:** architecture note names contracts, token flow, encrypted state,
public leakage, draw trigger, and withdrawal invariant.

## Phase 1: Prove the Zama primitives locally

**Goal:** validate the hardest dependencies before rewriting the app.

- Add Zama's Hardhat tooling and Solidity libraries using the official template.
- Implement a minimal contract and tests for encrypted input, ACL permissions,
  confidential transfer/accounting, and FHE randomness.
- Implement a minimal browser page that connects a wallet and performs Zama's
  EIP-712 user-decryption flow.
- Confirm Solidity/compiler versions and frontend SDK versions work together.
- Normalize every wallet, contract, and handle-pair contract address passed to
  the Zama SDK with checksum formatting. Lowercase addresses caused the browser
  spike to fail with `User address is not a valid address`.
- Keep Zama EIP-712 typed data compatible with the smart account signer,
  including bigint-safe handling.

**Exit gate:** two local users can submit encrypted values; each can decrypt
only their own value; an FHE random value is consumed onchain.

## Phase 2: Confidential deposit and withdrawal

**Goal:** establish the no-loss principal lifecycle.

- Implement test-token faucet and ERC-20 approval/wrap flow. **Current:**
  `ConfidentialUSDC` wraps Circle Sepolia USDC in deployment and `MockUSDC`
  locally.
- Deposit confidential tokens or encrypted amounts into the pool. **Current:**
  `ConfidentialPrizePool` accepts ERC-7984 `confidentialTransferAndCall`
  deposits.
- Store user balance and pool shares as encrypted values. **Current:** user
  principal and total principal are stored as `euint64`.
- Withdraw full or partial principal without exposing the stored balance.
  **Current:** users submit encrypted withdraw amounts; pool caps the transfer
  with `FHE.min(requested, principal)`.
- Add invariant and permission tests: total principal remains backed, one user
  cannot decrypt or spend another user's balance, and withdrawal never consumes
  prize funds.

**Exit gate:** Alice and Bob can deposit different amounts, decrypt only their
own balances, and withdraw their exact principal.

## Phase 3: Confidential weighted draws and prizes

**Goal:** complete the bounty's defining FHE mechanic.

- Maintain a bounded participant set suitable for Sepolia FHE/gas limits.
- Generate randomness onchain with Zama FHE. **Current:** `closeDraw` uses
  `FHE.randEuint64()` and scales the encrypted random word by encrypted total
  principal with 128-bit FHE arithmetic.
- Select a winner deposit-weighted over encrypted balances without plaintext
  balances, offchain RNG, or public winner disclosure. **Current:** selection
  scans a bounded participant set and credits encrypted winnings with
  `FHE.select`.
- Credit encrypted winnings and grant only the relevant user decryption access.
  **Current:** `encryptedWinningsOf` is decryptable by the account, and
  `claimPrize` transfers encrypted cUSDC to the winner.
- Add admin/keeper draw triggering, draw state transitions, and mock prize
  funding. **Current:** permissionless `closeDraw`; mock prize funding via
  confidential transfer callback tagged with `PRIZE_FUNDING_DATA`, mirrored as
  a public global prize amount for the active draw.
- Test empty pools, one participant, zero balances, withdrawals near draw time,
  repeated draws, prize conservation, and weighted behavior.
- Document unavoidable leakage such as participant addresses, transaction
  timing, participant count, and draw timing.

**Exit gate:** local multi-user test completes deposit, funded draw, private
winner discovery, claim, and principal withdrawal.

## Phase 4: Complete the judge-facing frontend

**Goal:** make every required action understandable and reliable.

- Connect the passkey-owned Safe smart account on Ethereum Sepolia.
- Add faucet, approval/wrap, deposit, balance decryption, draw, winnings
  decryption, claim, and withdrawal states.
- Show transaction pending/success/failure feedback.
- Handle missing approval, insufficient balance, wrong network, rejected
  signatures, relayer failures, unsupported token, and unavailable draw.
- Keep admin/keeper controls clearly separated from participant actions.
- Remove the legacy account path only after the passkey/Safe/Pimlico signer and
  account model is proven compatible with Zama input proofs and EIP-712 user
  decryption.

**Exit gate:** a new judge can complete every required action from the UI
without using Hardhat or a block explorer.

## Phase 5: Sepolia deployment and end-to-end verification

**Goal:** turn the local implementation into a stable public demo.

- Deploy and verify all contracts on Ethereum Sepolia.
- Configure public RPC, Zama relayer/gateway, contract addresses, and frontend
  environment variables.
- Deploy the frontend to a public HTTPS URL.
- Run the full cycle with at least three independent wallets.
- Test fresh-wallet faucet onboarding and reset/funding procedures.
- Record deployment addresses and transaction examples.

**Exit gate:** public URL survives a clean-browser test of deposit, decrypt,
draw, claim, and withdraw using deployed Sepolia contracts.

## Phase 6: Hardening and submission

**Goal:** make the demo trustworthy, reproducible, and easy to judge.

- Review FHE ACLs, encrypted-handle lifecycle, reentrancy, draw authorization,
  replay protection, backing invariants, participant bounds, and gas usage.
- Add deployment and demo bootstrap scripts.
- Finish README sections: live URL, architecture, confidentiality, leakage,
  mocked prize/yield, faucet, keeper flow, deployments, setup, and limitations.
- Prepare a deterministic 3-minute real-person demo path.
- Publish the X thread/article and add its link to the README.
- Tag the submitted commit and preserve the funded Sepolia demo state.

**Exit gate:** another developer can reproduce deployment; a judge can finish
the complete flow; submission contains every required link.

## Current starting point

- Reuse: app visual design, Sepolia network setup, `MockUSDC` faucet concept,
  basic lifecycle tests, and the product's no-loss UX.
- Replace: plaintext ERC-4626 accounting, `blockhash` randomness, public winner,
  direct plaintext prize payment, and current contract ABIs.
- Defer: account recovery, real yield, fiat on-ramp, mobile wrappers,
  official PoolTogether integration, and mainnet. See [`TODO.md`](TODO.md) for
  the later Morpho USDC/WETH yield adapter notes.

Start with **Phase 1**. Do not begin the full contract rewrite until the local
Zama spike proves encrypted input, ACLs, FHE randomness, and user decryption.

## Post-bounty mainnet program

Future yield simplification is tracked in
[`FUTURE_VAULT_INTEGRATION.md`](FUTURE_VAULT_INTEGRATION.md). Evaluate standard
Morpho vaults and Zama/OpenZeppelin batching after current withdrawals are verified.
This goal does not change the required Sepolia network or authorize mainnet deployment.

Mainnet remains outside this bounty roadmap. The gated real-funds program,
including protocol corrections, withdrawal liquidity, draw automation,
production infrastructure, audit, governance, legal review, and capped rollout,
is maintained in [`ROAD_TO_MAINNET.md`](ROAD_TO_MAINNET.md).
