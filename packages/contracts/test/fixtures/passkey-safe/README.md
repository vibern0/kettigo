# Safe runtimes for local passkey tests

`runtimes.json` contains the deployed EVM bytecode for five contracts. The
Hardhat helper installs each runtime at its canonical address so that embedded
immutable values match the deployed contracts. It checks each runtime against
the Keccak-256 hash pinned in [the helper](../../helpers/local-passkey-safe.js).

Each verified Sourcify record below provides the bytecode under
`runtimeBytecode.onchainBytecode` and the corresponding Solidity source under
`sources`. To reproduce a fixture, copy the bytecode verbatim into the JSON
entry keyed by its checksummed address.

| Contract | Version | Verified record |
| --- | --- | --- |
| SafeL2 | Safe 1.4.1 | [Sepolia](https://sourcify.dev/server/v2/contract/11155111/0x29fcB43b46531BcA003ddC8FCB67FFE91900C762?fields=runtimeBytecode.onchainBytecode,sources) |
| SafeProxyFactory | Safe 1.4.1 | [Sepolia](https://sourcify.dev/server/v2/contract/11155111/0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67?fields=runtimeBytecode.onchainBytecode,sources) |
| MultiSendCallOnly | Safe 1.4.1 | [Sepolia](https://sourcify.dev/server/v2/contract/11155111/0x9641d764fc13c8B624c04430C7356C1C7C8102e2?fields=runtimeBytecode.onchainBytecode,sources) |
| SafeWebAuthnSharedSigner | Safe passkey module 0.2.1 | [Sepolia](https://sourcify.dev/server/v2/contract/11155111/0x94a4F6affBd8975951142c3999aEAB7ecee555c2?fields=runtimeBytecode.onchainBytecode,sources) |
| Daimo P256Verifier | Safe passkey module 0.2.1 deployment | [Ethereum](https://sourcify.dev/server/v2/contract/1/0xc2b78104907F722DABAc4C69f826a522B2754De4?fields=runtimeBytecode.onchainBytecode,sources) |

The four Safe contracts are distributed under [LGPL-3.0-only](LICENSE-LGPL-3.0.txt),
which incorporates the [GPL-3.0 terms](LICENSE-GPL-3.0.txt). The Daimo verifier
is distributed under the [MIT license](LICENSE-P256-MIT.txt).
