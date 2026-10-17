<p align="center"><img align="center" width="320" src="./public/brand/logo-dark.svg#gh-dark-mode-only" alt="ShutaLink"/></p>
<p align="center"><img align="center" width="320" src="./public/brand/logo-light.svg#gh-light-mode-only" alt="ShutaLink"/></p>

<h3 align="center">Every new GitHub issue — read, rated, and filed. About twenty seconds, start to finish.</h3>

<p align="center"><em>Shuta — সুতা — is the Bangla word for thread: one thread from GitHub, through your triage, into Notion and Slack.</em></p>

<p align="center">
  <a href="https://shutalink.vercel.app"><img src="https://img.shields.io/badge/status-beta-ffb020?style=flat-square&amp;labelColor=081a2e" alt="Status: beta"/></a>
  <img src="https://img.shields.io/badge/tests-58%20passing-2ea043?style=flat-square&amp;labelColor=081a2e" alt="Tests: 58 passing"/>
</p>

<p align="center">
  <a href="https://skillicons.dev">
    <img src="https://skillicons.dev/icons?i=nextjs,ts,react,nodejs,prisma,postgres,redis,docker,vercel,vitest" alt="Next.js, TypeScript, React, Node.js, Prisma, PostgreSQL, Redis, Docker, Vercel, Vitest"/>
  </a>
</p>

<hr/>

## What it does

The moment an issue is opened on an installed repository:

- **Read** — a fast model summarizes the issue: what broke, how bad, and what probably caused it.
- **Rate** — severity lands as `low`, `medium`, or `high`. High severities page Slack first.
- **File** — a formatted Notion page lands in your workspace and a Slack note lands in your channel, both linked back to the issue.

Each signed-in user connects their own Notion and Slack accounts from the onboarding work order. Nothing runs on a repository until it is installed.

## How a run flows

```
issue opened on an installed repo
   │  webhook (HMAC signature verified)
   ▼
dedupe + quota check ──── exceeded? ──▶ skipped, owner notified once a day
   │  Redis-backed idempotency, 15 runs/day/workspace
   ▼
Trigger.dev worker  (process-github-issue)
   │  Groq · gpt-oss-120b: summary + severity
   ▼
high severity? ──▶ Slack alerts channel first
   ▼
Notion page  +  Slack note   (both linked to the issue)
```

## Tech stack

| Layer | Technology |
| --- | --- |
| Web app | Next.js 15 (App Router), React 19, TypeScript |
| Auth | Auth.js v5 — GitHub OAuth, Prisma adapter |
| API | Route handlers + server actions (webhook, install, onboarding) |
| Workers | Trigger.dev v4 — long-running task with retries |
| AI | Groq `openai/gpt-oss-120b` via Mastra agent |
| Integrations | Composio — per-user Notion + Slack connections |
| Database | PostgreSQL (Neon) + Prisma 6 |
| Guards | Redis (Upstash in prod) — webhook dedupe + quota counters |
| Tests | Vitest — 7 suites, 58 tests |
| Local infra | Docker Compose (postgres + redis) |
| Deploy | Vercel (app) + Trigger.dev Cloud (workers) |

## Run it locally

```bash
git clone https://github.com/Mostakim52/ShutaLink.git
cd ShutaLink
npm install
docker compose up -d        # postgres + redis
cp .env.example .env        # PowerShell: Copy-Item .env.example .env
npm run db:push
npm run db:seed
npm run dev                 # http://localhost:3000
```

In a second terminal, start the worker:

```bash
npm run trigger:dev
```

With `MOCK_INTEGRATIONS="true"` (the default), the Notion and Slack steps are simulated — you can run the whole pipeline end to end without third-party accounts:

```bash
npm run test:pipeline       # fires a synthetic issue through the full flow
npm test                    # vitest suite
npm run typecheck
```

For the real thing, fill in the values your flow needs:

| Group | Variables |
| --- | --- |
| Database | `DATABASE_URL` |
| Redis | `REDIS_URL` |
| Workers | `TRIGGER_SECRET_KEY` (project ref lives in `trigger.config.ts`) |
| AI | `GROQ_API_KEY` |
| Auth | `AUTH_SECRET` |
| GitHub App | `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_SLUG`, `GITHUB_WEBHOOK_SECRET` |
| Integrations | `COMPOSIO_API_KEY` |
| Caps | `LIMIT_USER_DAILY`, `LIMIT_USER_BURST_PER_MIN`, `LIMIT_GLOBAL_DAILY` |

`.env.example` documents each one and the exact GitHub App URLs and permissions to set.

## Project layout

```
app/
  api/
    auth/[...nextauth]/   GitHub OAuth + sessions
    github/setup/         install callback
    webhooks/github/      signed issue events
  onboarding/             connection work order + server actions
  signin/                 GitHub sign-in card
  icon.svg  layout.tsx  page.tsx
auth.ts                   Auth.js v5 config
components/               brand mark + provider icons
lib/
  composio.ts             per-user tool execution
  connect.ts              Composio connect flow
  limits.ts               daily + burst caps
  prisma.ts  redis.ts  session.ts  installState.ts
mastra/                   Groq summarizer agent
prisma/                   schema + seed
public/brand/             README lockups
scripts/test-pipeline.ts  local end-to-end probe
tests/                    vitest suites
trigger/                  worker task
trigger.config.ts  docker-compose.yml  vitest.config.mts
```

## Free plan caps

Free while in beta: **15 runs/day per workspace** (5/minute burst), 150/day across all workspaces. When a cap is reached, issues are left untouched in GitHub and triage resumes the next day at 00:00 UTC.

<hr/>

<p align="center"><sub>Built with <a href="https://trigger.dev">Trigger.dev</a> · <a href="https://composio.dev">Composio</a> · <a href="https://groq.com">Groq</a> — running on <a href="https://vercel.com">Vercel</a>, <a href="https://neon.tech">Neon</a>, and <a href="https://upstash.com">Upstash</a></sub></p>
