export function Header() {
  return (
    <header className="site-header">
      <a className="brand" href="#top" aria-label="Kettigo home">
        <img className="brand-mark" src="/kettigo-mark-header.svg" alt="" aria-hidden="true" />
        <span>Kettigo</span>
      </a>
      <nav className="site-nav" aria-label="Primary navigation">
        <a href="#how-it-works">How it works</a>
        <a href="#why-kettigo">Why Kettigo</a>
      </nav>
      <a className="button button-small" href="https://app.kettigo.xyz/">
        Open Kettigo
      </a>
    </header>
  );
}
