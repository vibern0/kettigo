const trustItems = [
  {
    title: "Clear prize rules",
    body: "Your balance sets your chances, and each draw explains exactly how eligibility is checked.",
  },
  {
    title: "USDC for deposits and payouts.",
    body: "You enter with USDC. Withdrawals and prizes use the same asset, with your deposit accounted for separately from winnings.",
  },
  {
    title: "Zama runs the draw calculations.",
    body: "Zama generates a random value and calculates the winner onchain. Each balance supplies its share of the selection weight.",
  },
  {
    title: "Yield powered by Morpho",
    body: "The prize pool is designed to be funded by established lending markets without promising a fixed return.",
  },
];

export function TrustSection() {
  return (
    <section className="section-band trust-section" id="why-kettigo" aria-labelledby="why-kettigo-title">
      <div className="section-inner trust-layout">
        <div className="section-copy">
          <p className="eyebrow">Why Kettigo</p>
          <h2 id="why-kettigo-title">Built for people who like upside without losing.</h2>
        </div>
        <div className="trust-grid">
          {trustItems.map((item) => (
            <article className="trust-card" key={item.title}>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
