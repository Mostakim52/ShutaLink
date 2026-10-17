import { prisma } from "../../lib/prisma";
import { requireUser } from "../../lib/session";
import { signInstallState } from "../../lib/installState";
import { signOut } from "../../auth";
import {
  refreshConnection,
  saveIntegrationSettings,
  startConnect,
} from "./actions";

export const metadata = {
  title: "Setup — ShutaLink",
};

interface NotionMetadata {
  notionParentPageId?: string;
}

interface SlackMetadata {
  slackChannel?: string;
  slackAlertChannel?: string;
}

export default async function OnboardingPage() {
  const user = await requireUser();

  const [installation, notion, slack, workflow] = await Promise.all([
    prisma.githubInstallation.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
    }),
    prisma.integrationConfig.findUnique({
      where: { userId_provider: { userId: user.id, provider: "NOTION" } },
    }),
    prisma.integrationConfig.findUnique({
      where: { userId_provider: { userId: user.id, provider: "SLACK" } },
    }),
    prisma.workflow.findFirst({ where: { userId: user.id } }),
  ]);

  const appSlug = process.env.GITHUB_APP_SLUG;
  const installUrl = appSlug
    ? `https://github.com/apps/${appSlug}/installations/new?state=${encodeURIComponent(
        signInstallState(user.id)
      )}`
    : null;

  const notionConnected = Boolean(notion?.isActive);
  const slackConnected = Boolean(slack?.isActive);
  const githubInstalled = Boolean(installation);
  const allSet = githubInstalled && notionConnected && slackConnected && Boolean(workflow);

  const notionMeta = (notion?.metadata ?? {}) as NotionMetadata;
  const slackMeta = (slack?.metadata ?? {}) as SlackMetadata;

  return (
    <main className="shell shell--narrow">
      <header className="topbar">
        <a className="brand" href="/">
          SHUTALINK <span className="brand-mark">///</span>
        </a>
        <nav className="topnav">
          <span className="topbar-email">{user.email}</span>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/" });
            }}
          >
            <button className="linklike" type="submit">
              Sign out
            </button>
          </form>
        </nav>
      </header>

      <section className="hero hero--compact">
        <p className="eyebrow">
          <span className="eyebrow-rule">///</span> Setup
        </p>
        <h1 className="hero-title">Three connections, then triage runs itself.</h1>
        <p className="hero-lede">
          Install the app, point ShutaLink at a Notion page and a Slack
          channel, and every new issue gets read, rated, and filed.
        </p>
      </section>

      {allSet ? (
        <section className="allset">
          <div>
            <h2 className="allset-title">Triage is live.</h2>
            <p className="allset-copy">
              Open an issue on an installed repository and the run shows up
              here in about twenty seconds.
            </p>
          </div>
          <span className="stamp stamp--done">All connected</span>
        </section>
      ) : null}

      <ol className="workorder">
        <li className="workorder-step">
          <span className="step-num">01</span>
          <div className="step-body">
            <h3 className="step-title">GitHub account</h3>
            <p className="step-detail">
              Signed in as {user.email}. This is the account that owns your
              setup.
            </p>
          </div>
          <div className="workorder-stamp-cell">
            <span className="stamp stamp--done">Signed in</span>
          </div>
        </li>

        <li className="workorder-step">
          <span className="step-num">02</span>
          <div className="step-body">
            <h3 className="step-title">Install the GitHub App</h3>
            <p className="step-detail">
              Pick the repositories ShutaLink may watch. Issues from those
              repos trigger triage; nothing else is read.
            </p>
            {!githubInstalled && installUrl ? (
              <div className="step-actions">
                <a className="btn btn-primary btn-small" href={installUrl}>
                  Choose repositories
                </a>
              </div>
            ) : null}
            {!githubInstalled && !installUrl ? (
              <p className="step-hint">
                The GitHub App has not been registered yet, so this step is
                unavailable.
              </p>
            ) : null}
          </div>
          <div className="workorder-stamp-cell">
            {githubInstalled ? (
              <span className="stamp stamp--done">
                {installation?.accountLogin
                  ? `Installed · @${installation.accountLogin}`
                  : "Installed"}
              </span>
            ) : (
              <span className="stamp stamp--pending">Pending</span>
            )}
          </div>
        </li>

        <li className="workorder-step">
          <span className="step-num">03</span>
          <div className="step-body">
            <h3 className="step-title">Connect Notion</h3>
            <p className="step-detail">
              Issue summaries are archived as pages in your workspace. Paste a
              page link below and ShutaLink files everything under it.
            </p>

            {notionConnected ? (
              <>
                <form className="field-row" action={saveIntegrationSettings}>
                  <input type="hidden" name="toolkit" value="notion" />
                  <label className="field">
                    <span className="field-label">Parent page ID</span>
                    <input
                      className="field-input"
                      type="text"
                      name="notionParentPageId"
                      defaultValue={notionMeta.notionParentPageId ?? ""}
                      placeholder="e725d53b27fd4540ab2cde72b0bd8194"
                    />
                  </label>
                  <div className="field-row-actions">
                    <button className="btn btn-quiet btn-small" type="submit">
                      Save
                    </button>
                  </div>
                </form>
                <p className="step-hint">
                  Find it in the page URL after the workspace name — the 32
                  character code.
                </p>
              </>
            ) : (
              <div className="step-actions">
                <form action={startConnect}>
                  <input type="hidden" name="toolkit" value="notion" />
                  <button className="btn btn-primary btn-small" type="submit">
                    Connect Notion
                  </button>
                </form>
                <form action={refreshConnection}>
                  <input type="hidden" name="toolkit" value="notion" />
                  <button className="linklike" type="submit">
                    Finished authorizing? Refresh status
                  </button>
                </form>
              </div>
            )}
          </div>
          <div className="workorder-stamp-cell">
            {notionConnected ? (
              <span className="stamp stamp--done">Connected</span>
            ) : (
              <span className="stamp stamp--pending">Pending</span>
            )}
          </div>
        </li>

        <li className="workorder-step">
          <span className="step-num">04</span>
          <div className="step-body">
            <h3 className="step-title">Connect Slack</h3>
            <p className="step-detail">
              Low and medium severities post to your notifications channel;
              high severities page the alerts channel first.
            </p>

            {slackConnected ? (
              <form className="field-row" action={saveIntegrationSettings}>
                <input type="hidden" name="toolkit" value="slack" />
                <label className="field">
                  <span className="field-label">Notifications channel</span>
                  <input
                    className="field-input"
                    type="text"
                    name="slackChannel"
                    defaultValue={slackMeta.slackChannel ?? "#general"}
                  />
                </label>
                <label className="field">
                  <span className="field-label">Alerts channel</span>
                  <input
                    className="field-input"
                    type="text"
                    name="slackAlertChannel"
                    defaultValue={slackMeta.slackAlertChannel ?? "#incident-alerts"}
                  />
                </label>
                <div className="field-row-actions">
                  <button className="btn btn-quiet btn-small" type="submit">
                    Save
                  </button>
                </div>
              </form>
            ) : (
              <div className="step-actions">
                <form action={startConnect}>
                  <input type="hidden" name="toolkit" value="slack" />
                  <button className="btn btn-primary btn-small" type="submit">
                    Connect Slack
                  </button>
                </form>
                <form action={refreshConnection}>
                  <input type="hidden" name="toolkit" value="slack" />
                  <button className="linklike" type="submit">
                    Finished authorizing? Refresh status
                  </button>
                </form>
              </div>
            )}
          </div>
          <div className="workorder-stamp-cell">
            {slackConnected ? (
              <span className="stamp stamp--done">Connected</span>
            ) : (
              <span className="stamp stamp--pending">Pending</span>
            )}
          </div>
        </li>
      </ol>

      <p className="caps-note">
        Free plan · 15 runs per day per workspace · resets at 00:00 UTC. When
        the cap is reached, issues stay untouched in GitHub and triage resumes
        the next day.
      </p>
    </main>
  );
}
