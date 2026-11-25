# Merkle v2 review disposition

This records local review evidence, not Codacy Cloud approval. The Cloud CLI
returned `Unauthorized`; the user requested continued work with that gate
reported as blocked. No Cloud issue is represented as ignored or resolved.

## Framework mismatch requiring Cloud disposition

The committed analyzer configuration applies `ESLint9_@vitest_*` patterns to
`packages/contracts/test/**/*.ts`. These are Hardhat/Mocha suites using Chai,
not Vitest suites. Local findings include importing globals from Vitest,
Vitest-only assertion accounting, and prohibiting Mocha hooks. Replacing these
with Vitest APIs would break the actual Hardhat runner. A local scan reported
229 such findings across the then-changed tests; counts change as tests grow.

Proposed disposition: `FalsePositive`, with the explanation above, for the
specific Cloud issues in Hardhat/Mocha files after an authenticated Cloud PR
report is available. Do not disable these rules for the web/landing Vitest
suites or pretend an ignore was recorded while authentication is unavailable.

## Analysis limitations

The local ESLint 9 adapter skipped type-aware TypeScript patterns because it
could not discover a root `tsconfig.json` in this monorepo, and skipped Tailwind
patterns while examining contract tests without Tailwind in that package.
Package compilation/typechecks and functional tests are separate evidence;
they do not establish that the skipped analyzer rules executed.

Two unstaged Codacy configuration files predated this task. They select a
different analyzer set and remain outside this change. Release analysis uses
an exact copy of the committed configuration so the user's in-progress edits
are preserved. Reports state which configuration and tools actually ran.

## Findings handled in source/artifacts

Intentional Ethers overloaded-method calls were rewritten with clear local
contract aliases to avoid ambiguous multiline property access. Overlong test
setup is extracted into coherent helpers while preserving assertions. Public
contract addresses in the legacy inventory are labeled `wrapperAddress`,
clarifying that they are onchain addresses rather than credential tokens.
