const trustItems = [
  {
    title: "Clear prize rules",
    body: "Your balance sets your chances, with eligibility checked when a winner is selected.",
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
