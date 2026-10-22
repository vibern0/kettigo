export function TestnetWarning() {
  return (
    <aside
      aria-label="Testnet warning"
      className="space-y-1 rounded-2xl border border-warning/40 bg-surface p-4 text-sm leading-relaxed text-text"
    >
      <p className="font-semibold text-warning">Ethereum Sepolia testnet only</p>
      <p>
        This app uses test USDC with no real monetary value. Only send test USDC on
        Ethereum Sepolia. Do not send real money or mainnet tokens to this account;
        they will be lost.
      </p>
    </aside>
  );
}
