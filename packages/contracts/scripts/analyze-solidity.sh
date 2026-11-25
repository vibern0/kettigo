#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
pnpm exec hardhat compile --force

# The FHE plugin rewrites ZamaConfig.sol for the compiler. Starting Slither
# here lets it resolve that generated source while reading the Hardhat build.
reports=$(mktemp -d "$PWD/cache/slither-report.XXXXXXXX")
echo "Slither reports: $reports"
cd fhevmTemp
DOTENV_CONFIG_QUIET=true uvx --python 3.12 --from slither-analyzer==0.11.6 slither .. \
  --hardhat-ignore-compile \
  --include-paths 'packages/contracts/contracts/' \
  --fail-low \
  --json "$reports/slither.json" \
  --sarif "$reports/slither.sarif" \
  --checklist > "$reports/slither.md"
