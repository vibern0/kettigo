const steps = [
  {
    title: "Deposit USDC",
    body: "Add savings when you are ready. Your balance remains the base for prize eligibility.",
  },
  {
    title: "Stay eligible",
    body: "Your balance when the winner is selected sets your chances.",
  },
  {
    title: "Check and claim",
    body: "Check your result. If you’ve won, claim your winnings or keep playing.",
  },
];

export function HowItWorks() {
  return (
    <section className="section-band" id="how-it-works" aria-labelledby="how-it-works-title">
      <div className="section-inner">
        <div className="section-copy">
          <p className="eyebrow">How it works</p>
          <h2 id="how-it-works-title">Deposit once. Keep playing.</h2>
        </div>
        <ol className="step-grid">
          {steps.map((step) => (
            <li className="step-card" key={step.title}>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
