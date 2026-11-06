# Legacy v1 fixture provenance

This local-test-only fixture is copied from the immutable Git object:

```text
commit: 4d1e4a722408814da04947ef04348b36d532465c
path: packages/contracts/contracts/ConfidentialPrizePool.sol
blob: 7aac81942a5d7edb739a7a09f0a16d14bbad759b
source SHA-256: c6db1359ef9c8d095838b85285be321cf593a69e7349af233af964790444f705
```

Extraction was performed from that exact object with:

```sh
git show 4d1e4a722408814da04947ef04348b36d532465c:packages/contracts/contracts/ConfidentialPrizePool.sol
```

The compile-isolation edits are the contract declaration identifier and two
fixture-local interface identifiers with every reference to those interfaces:

```diff
-contract ConfidentialPrizePool is ZamaEthereumConfig, IERC7984Receiver {
+contract LegacyConfidentialPrizePoolV1 is ZamaEthereumConfig, IERC7984Receiver {

-interface IERC7984ERC20WrapperInternalAmount is IERC7984ERC20Wrapper {
+interface LegacyV1IERC7984ERC20WrapperInternalAmount is IERC7984ERC20Wrapper {

-interface IMorphoPrizeYieldAdapter {
+interface LegacyV1IMorphoPrizeYieldAdapter {
```

The source has an unnamed constructor, so no constructor identifier was edited.
The two interface renames are compile-isolation only: Aderyn reports duplicate
contract names when the archived fixture and current pool declare the same
file-local interface names. Their inheritance, function signatures, every
reference, storage behavior, participant cap, draw loop, and withdrawal
lifecycle remain from the pinned object. Prettier also makes one whitespace-only
line-wrap change to `_requireMorphoYieldAdapter`'s return signature; it does
not alter tokens, ABI, or runtime behavior. The resulting fixture blob is
`f3428beb4b346c94ed7f211ecb58a37b291001bf`; its SHA-256 is
`5330e5fd4cb8dcc1c6f3c03c3019ae1bb267858e55cfe5f4b1452bbe942a7df6`.
