export function Hero() {
  return (
    <section className="hero" id="top" aria-labelledby="hero-title">
      <div className="section-inner hero-layout">
        <div className="hero-copy">
          <p className="eyebrow">Prize draws funded by interest</p>
          <h1 id="hero-title">Enter the draw. Keep your deposit.</h1>
          <p>Your deposit is your entry.</p>
          <div className="hero-actions" aria-label="Landing actions">
            <a className="button button-primary" href="https://app.kettigo.xyz/">
              Open Kettigo
            </a>
            <a className="button button-secondary" href="#how-it-works">
              See how it works
            </a>
          </div>
        </div>

        <div className="prize-panel" aria-label="Prize draw overview">
          <div className="prize-orbit" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <dl className="prize-list">
            <div>
              <dt>Next draw</dt>
              <dd>Open to everyone</dd>
            </div>
            <div>
              <dt>Your savings set your chances</dt>
              <dd>Eligibility is checked at the end of each draw.</dd>
            </div>
            <div>
              <dt>Your money stays yours</dt>
              <dd>Request a withdrawal when you want to step out.</dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}
