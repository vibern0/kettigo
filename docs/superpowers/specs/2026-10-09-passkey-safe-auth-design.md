# Passkey-Owned Safe Authentication Design

## Purpose

Replace Web3Auth social login with browser-native passkeys while preserving
Kettigo's Safe smart accounts, sponsored ERC-4337 transactions, Ethereum
Sepolia deployment, and Zama user-decryption flow.

Success means a new user can pass the existing email access check, create a
passkey, receive a deterministic Safe address, complete every Kettigo action,
reload the application, and return to the same account without Web3Auth. The
application backend must not store or bind a wallet address to the submitted
email.

This is a testnet-first design. Losing the passkey or its local metadata may
make the account inaccessible. Account recovery, multi-device restoration,
and migration of existing Web3Auth-derived accounts are explicitly deferred.

## Product Decisions

- Passkeys are the only wallet onboarding method. Google, Apple, injected
  wallets, seed phrases, and password login are not fallbacks.
- The existing email gate remains a lightweight invitation screen. It checks
  whether an email is approved but does not prove email ownership or enforce
  one person per email.
- An approved email may be used by multiple people. This is an accepted
  limitation for the current testnet application.
- Email access and wallet ownership are independent. Kettigo does not store an
  email-to-wallet mapping.
- A passkey is the sole owner of a 1-of-1 Safe for this phase.
- Pimlico remains the ERC-4337 bundler and sponsored paymaster. Removing
  Web3Auth does not imply operating a bundler or paymaster.
- Ethereum Sepolia remains the application chain. No contract or deployment
  moves to Ethereum mainnet.

## Feasibility Gate: Zama Compatibility Spike

The migration must begin with a browser spike rather than removal of the
working Web3Auth path. The spike proves this exact lifecycle on Ethereum
Sepolia:

```text
create passkey
  -> derive passkey-owned Safe 1.4.1 address
  -> submit a sponsored ERC-4337 UserOperation
  -> grant the Safe FHE access to a value
  -> sign Zama EIP-712 typed data through the passkey-owned Safe
  -> decrypt the value through the Zama relayer
```

The spike uses Safe's supported WebAuthn signer contracts, Safe 1.4.1, the
Safe ERC-4337 module compatible with EntryPoint 0.7, and the deployed Sepolia
contracts. It must test both a newly counterfactual Safe and the same Safe
after deployment.

The gate passes only if the passkey-owned Safe can:

1. Sign and submit an ordinary Kettigo transaction.
2. Sign the EIP-712 authorization used by Zama user decryption.
3. Decrypt a value whose ACL permission belongs to the Safe address.
4. Repeat the operation after a page reload using persisted public passkey
   metadata.

If Zama or the selected Safe SDK path rejects the WebAuthn-backed Safe
signature, implementation stops at the spike. The fallback is an explicit
architecture decision; the project must not add custom signature
cryptography, silently restore Web3Auth, or partially migrate users.

## Architecture

The browser owns passkey registration, Safe derivation, and transaction
signing. Kettigo's Worker owns only the existing email approval lookup. Safe's
audited contracts validate WebAuthn signatures onchain, and Pimlico transports
and sponsors UserOperations.

```text
Browser
  |-- email -----------------------> Kettigo Worker -> D1 approval lookup
  |<------------------------------- approved / pending
  |
  |-- WebAuthn create/get ---------> device authenticator
  |<------------------------------- passkey signature
  |
  |-- signed UserOperation --------> Pimlico bundler/paymaster
  |                                  |
  |                                  v
  |                            Safe 1.4.1 on Sepolia
  |                                  |
  |                                  v
  |                            Kettigo contracts
  |
  `-- Safe EIP-712 signature ------> Zama relayer
```

The frontend uses Safe's official Protocol Kit and ERC-4337 integration for
the passkey owner. The implementation must pin mutually compatible versions
after the spike instead of copying unpinned tutorial dependencies. It keeps
the existing EntryPoint 0.7 and Safe 1.4.1 choices unless the spike proves an
officially supported version change is required.

No new Kettigo smart-account contract, P-256 verifier, custom Safe module, or
signature encoder is introduced. Canonical Safe WebAuthn and ERC-4337
contracts are reused.

## Access-Gate Flow

The email gate is deliberately a soft product gate rather than wallet
identity verification:

1. The user enters an email.
2. The client calls the existing access-status endpoint.
3. A pending or unknown email retains the existing waitlist behavior.
4. An approved email unlocks passkey creation or sign-in in that browser.
5. The approved gate state is cached locally so ordinary reloads do not repeat
   the form.
6. Passkey authentication creates the wallet session independently of the
   email.

The access claim endpoint and its `walletAddress`, `joinedMessage`, and
`signature` payload are removed from the active flow. The Worker no longer
writes wallet addresses or signatures into `waitlist_entries`. Existing
nullable columns may remain during the first reversible migration, but new
passkey sessions never populate them.

Signing an email string or storing a signature hash is explicitly rejected.
Such a signature would prove only that a credential signed supplied text; it
would not prove control of the email address. A static signed message would
also be replayable and would create the email-to-wallet association this
design avoids.

The gate does not protect the public smart contracts. Anyone may interact
with those contracts directly. Its purpose is staged access to Kettigo's user
interface.

## Passkey and Session Lifecycle

### Registration

On an approved browser with no Kettigo credential, the user selects “Create
account.” The browser requests a discoverable WebAuthn credential scoped to
the production relying-party ID. User verification is required. The resulting
credential ID and P-256 public coordinates initialize the Safe passkey signer
and deterministically derive the counterfactual Safe address.

The private key never leaves the platform authenticator. The application
persists only the public metadata required by Safe to reconstruct the signer.
That metadata is not a secret, but it is integrity-sensitive: malformed or
unexpected records are rejected rather than coerced.

### Restoration

On reload, the frontend reads the locally stored credential metadata,
reconstructs the same Safe configuration, derives the expected checksum
address, and requires a WebAuthn assertion before signing an operation or
decryption authorization. Merely finding local metadata does not authorize a
transaction.

If metadata is absent or invalid, the user creates a new test account. No
recovery promise is shown. The implementation must not imply that a passkey
synced by the operating system is sufficient if Kettigo's required public
metadata is unavailable.

### Sign-out

Sign-out clears the in-memory wallet session and confidential balance state.
It does not delete the platform passkey. A separate destructive “Forget this
account on this browser” action may clear Kettigo's local public metadata, but
is not required in the initial migration.

## Smart-Account Session Contract

The frontend wallet abstraction becomes provider-neutral and must no longer
expose Web3Auth concepts. Its session contains:

```ts
type PasskeySmartSession = {
  address: Address;
  smartAccountClient: SmartAccountClient;
  signTypedData: (typedData: EIP712TypedData) => Promise<Hex>;
  sendTransaction: (calls: SmartAccountCall[]) => Promise<Hex>;
};
```

`ownerAddress`, `email`, `signOwnerTypedData`, and Web3Auth logout are removed.
Components consume the Safe address and transaction methods without knowing
how the passkey is represented.

The wallet provider distinguishes these states:

- checking local account metadata;
- no passkey account;
- creating a passkey;
- awaiting user verification;
- ready;
- unsupported browser;
- cancelled user verification;
- invalid local metadata;
- bundler or paymaster unavailable.

Unknown exceptions are retained for diagnostics while user-facing messages
remain short and actionable.

## Zama Authorization Model

The Safe address is the user address for encrypted input, contract calls, ACL
ownership, and decryption. Every address passed to the Zama SDK remains
checksum-normalized.

The current separate Web3Auth owner-delegate route is removed after the
compatibility gate passes:

- Deposits no longer encode `ownerAddress` as callback data.
- New principal and winnings permissions remain on the Safe account.
- Balance and principal decryption both use the Safe-backed Zama signer.
- `createOwnerZamaSDK`, `OwnerZamaSigner`, and owner-only typed-data signing are
  removed.

The onchain decrypt-delegate capability may remain for backward compatibility
with already deployed contracts, but the passkey frontend neither sets nor
depends on it. A contract deployment is not required solely to stop using the
delegate.

Zama EIP-712 objects continue to use bigint-safe serialization wherever an SDK
boundary requires JSON. Address checksum invariants remain unchanged.

## Data and Privacy

The D1 waitlist continues storing the normalized email because it is the
existing approval and communication record. This design does not attempt to
hide that email.

The backend stores none of the following for new passkey sessions:

- Safe address;
- passkey credential ID or public key;
- wallet signature;
- signed-message hash;
- email-to-wallet association.

The browser stores the approved-gate marker and public passkey signer metadata
locally. The Safe address is public on Ethereum once used. Avoiding backend
storage prevents a Kettigo database leak from directly correlating the
waitlist email with that address; it does not provide transaction-graph
privacy onchain.

## Migration and Compatibility

The change is intentionally forward-only for test accounts:

- Existing Web3Auth-derived Safe accounts do not become passkey-owned.
- No assets, ACL permissions, or local sessions are migrated automatically.
- The rollout must clearly state that creating a passkey creates a new account
  address.
- Web3Auth code and dependency removal occurs only after the spike and the
  complete passkey lifecycle pass tests.
- The D1 schema change is additive or nullable first; destructive column
  removal is deferred until rollback is no longer needed.

During development, the old and new implementations may coexist behind a
developer-only build switch. Production presents only one login method; it
must not offer users two account derivation paths for the same product state.

## Error Handling

- Unsupported WebAuthn: explain that the browser or device cannot create the
  account; do not fall back to an exported private key.
- User cancellation: return to the ready state without treating cancellation
  as a system outage.
- Invalid local metadata: discard no data automatically; offer creation of a
  new test account after explaining that its address will differ.
- Safe derivation mismatch: block use and record diagnostics. Never continue
  with an unexpected address.
- Pimlico failure: preserve the session and transaction intent for an explicit
  retry.
- Zama signing or decryption failure: preserve the Safe session, distinguish
  authorization failures from transient relayer failures, and never replace
  the signer silently.
- Email-status failure: retain the entered email for retry and do not begin
  passkey creation.

## Testing and Acceptance

### Compatibility spike

- Register a real passkey in a secure browser context.
- Derive and deploy a Safe 1.4.1 account through EntryPoint 0.7.
- Submit a sponsored transaction through the configured Pimlico service.
- Encrypt, store, and decrypt a Zama value authorized to the Safe.
- Reload and repeat decryption with reconstructed local metadata.

### Automated frontend tests

- Approved email exposes passkey onboarding; pending email does not.
- No access request contains a wallet address or signature.
- Registration persists only the expected public signer metadata.
- Reload derives the same checksummed Safe address.
- Cancellation, unsupported WebAuthn, corrupted metadata, and Pimlico errors
  enter distinct states.
- All transaction builders continue targeting the derived Safe address.
- Zama signer adapters serialize bigint typed data safely and normalize every
  address with `getAddress()`.

### Worker and data tests

- Access status retains approved and pending behavior.
- The passkey flow never updates `wallet_address`, `joined_message`, or
  `joined_signature`.
- Multiple clients may proceed after entering the same approved email, as
  explicitly allowed by this phase.

### End-to-end acceptance

Using a fresh browser profile on `app.kettigo.xyz`, a user can enter an
approved email, create a passkey, obtain a new Safe address, wrap and deposit
USDC, decrypt balances and principal, participate in a draw, claim an eligible
prize, request withdrawal, reload, and return to the same account. The D1
record for the email contains no new wallet address or signature.

## Explicit Non-Goals

- Email ownership verification, OTPs, and magic links.
- Enforcing one account or person per approved email.
- Passkey recovery, additional owners, guardians, or social recovery.
- Cross-device reconstruction beyond what is proven by the local metadata
  flow.
- Migration of Web3Auth-derived accounts or funds.
- Self-hosting an ERC-4337 bundler or paymaster.
- Creating custom P-256, WebAuthn, Safe, or signature-verification contracts.
- Hiding Safe addresses or transaction relationships from Ethereum.
- Moving Kettigo from Ethereum Sepolia.
