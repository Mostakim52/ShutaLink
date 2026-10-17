import { getSessionUser } from "../lib/session";

export default async function HomePage() {
  const user = await getSessionUser();

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="/">
          SHUTALINK <span className="brand-mark">///</span>
        </a>
        <nav className="topnav">
          <a className="topnav-link topnav-link--strong" href={user ? "/onboarding" : "/signin"}>
            {user ? "Open setup" : "Sign in"}
          </a>
        </nav>
      </header>

      <section className="hero">
        <p className="eyebrow">
          <span className="eyebrow-rule">///</span> GitHub issue triage, automated
        </p>
        <h1 className="hero-title">
          Every new issue: summarized, rated, filed.
        </h1>
        <p className="hero-lede">
          The moment an issue is opened, ShutaLink reads it, stamps a severity,
          archives a note to Notion, and pings Slack. Roughly twenty seconds, start
          to finish.
        </p>
        <div className="hero-actions">
          <a className="btn btn-primary" href={user ? "/onboarding" : "/signin"}>
            {user ? "Open setup" : "Install the GitHub App"}
          </a>
          <span className="hero-note">Free while in beta · daily run caps apply</span>
        </div>
      </section>

      <section className="redline" aria-label="Example triage">
        <div className="redline-head">
          <span className="redline-repo">mostakim52/storefront</span>
          <span>Issue #412</span>
          <span className="redline-state">
            Opened 30s ago → <span className="redline-state-done">Triaged</span>
          </span>
        </div>
        <h2 className="redline-title">&ldquo;Checkout button crashes on submit&rdquo;</h2>
        <div className="redline-grid">
          <div className="redline-severity">
            <span className="severity-label">Severity</span>
            <span className="severity-value">HIGH</span>
            <svg className="redline-circle" viewBox="0 0 240 120" aria-hidden="true">
              <path d="M 40 78 C 22 48 62 14 122 11 C 184 8 226 32 227 60 C 228 90 180 108 120 108 C 68 108 34 96 36 72 C 38 50 66 34 96 28" />
              <path d="M 84 18 C 130 6 196 14 216 40" />
            </svg>
          </div>
          <p className="redline-summary">
            Submit handler throws an uncaught TypeError during the payment step;
            every checkout attempt on current main is affected. Likely a
            regression from last week&rsquo;s form refactor.
          </p>
          <ul className="redline-routes">
            <li className="redline-route">
              <span className="route-arrow">→</span> Notion · archive page created
            </li>
            <li className="redline-route">
              <span className="route-arrow route-arrow--red">→</span> Slack ·
              #incident-alerts · paged first
            </li>
          </ul>
        </div>
        <div className="redline-stamp">Triaged in 21s</div>
      </section>

      <section className="pipeline">
        <h2 className="section-label">What happens, in order</h2>
        <ol className="steps">
          <li className="step">
            <span className="step-num">01</span>
            <h3 className="step-title">Read</h3>
            <p className="step-copy">
              The issue body, title, and reporter are summarized by a fast model —
              what broke, how bad, and what probably caused it.
            </p>
          </li>
          <li className="step">
            <span className="step-num">02</span>
            <h3 className="step-title">Rate</h3>
            <p className="step-copy">
              Severity lands as low, medium, or high. High severities alert Slack
              before anything else moves.
            </p>
          </li>
          <li className="step">
            <span className="step-num">03</span>
            <h3 className="step-title">File</h3>
            <p className="step-copy">
              A formatted Notion page lands in your workspace, and a Slack note
              lands in your channel — both linked back to the issue.
            </p>
          </li>
        </ol>
      </section>

      <footer className="footer">
        <span>shutalink · GitHub issue triage</span>
        <span>Trigger.dev · Composio · Groq</span>
      </footer>
    </main>
  );
}
