# Smokescreen

Automated data broker opt-out system. Sends CCPA/privacy deletion requests to data brokers via email, classifies replies with the configured AI provider (Vertex AI Gemini by default, Anthropic Claude optionally), and handles broker acknowledgments, information requests, follow-ups, and manual-review cases until completion.

## How it works

1. **Outreach** — Sends templated opt-out emails to the brokers explicitly enabled in the persisted broker selection
2. **Poll** — Checks inbox for replies, classifies them with the configured AI provider (acknowledgment, information request, completed, rejected, needs manual review), and responds automatically
3. **State machine** — Tracks each broker through request, ping, follow-up, completion, rejection, failure, and manual-review states

## Quick start

Install dependencies:

```bash
uv sync
```

Set the minimum sender identity used in broker requests:

```bash
export SMOKESCREEN_SENDER_EMAIL="YOUR_EMAIL"
export SMOKESCREEN_SENDER_NAME="Your Legal Name"
```

Smokescreen uses Vertex AI Gemini by default. Authenticate local development
with Google Application Default Credentials:

```bash
gcloud auth application-default login
```

If ADC does not infer the intended Vertex AI project or location, pin them:

```bash
export SMOKESCREEN_GEMINI_PROJECT="your-gcp-project"
export SMOKESCREEN_GEMINI_LOCATION="global"
```

To use Anthropic Claude instead of Gemini, set the provider and API key:

```bash
export SMOKESCREEN_AI_PROVIDER="anthropic"
export SMOKESCREEN_ANTHROPIC_API_KEY="sk-ant-..."
```

Place your Google Cloud OAuth client credentials at `./credentials.json`. See
[Gmail setup](#gmail-setup), then trigger the one-time OAuth flow:

```bash
smokescreen poll
```

`smokescreen poll` initializes the Gmail client, opens the browser OAuth flow
the first time, and writes `token.json` next to `credentials.json`. Do not use
`smokescreen --dry-run outreach` to trigger OAuth because dry-run exits before
Gmail client initialization. Verify that the token has a refresh token:

```bash
python3 -c "import json; d=json.load(open('token.json')); print('has refresh_token:', 'refresh_token' in d)"
```

Enable at least one broker before outreach. Use the dashboard Setup flow or
Brokers page toggles, or call `PUT /api/brokers/selections` against a running
dashboard API.

Simulate outreach without sending email:

```bash
smokescreen --dry-run outreach
```

Send opt-out emails:

```bash
smokescreen outreach
```

Check for and process replies:

```bash
smokescreen poll
```

View status of all brokers:

```bash
smokescreen status
```

Reset a broker to try again:

```bash
smokescreen reset spokeo
```

## Local dashboard

Install both the Python app and React dashboard dependencies before launching
locally:

```bash
uv sync
npm --prefix web install
```

Use split dev mode for day-to-day React work. This starts FastAPI on
`http://127.0.0.1:8000` and Vite on `http://127.0.0.1:5173`; open the React app
at the Vite URL. Vite proxies `/api` to FastAPI.

```bash
./scripts/dev.sh
```

Use production-style local mode to verify the built React bundle served by the
FastAPI app. Open `http://127.0.0.1:8000` after the server starts.

```bash
npm --prefix web run build
smokescreen serve
```

The React dashboard is the default UI at `/`, and the former `/app` mount
redirects to `/`.

For verification, run the full project check before handing off changes when
Docker is available:

```bash
./scripts/check
```

For a lighter local check while iterating on the dashboard, run:

```bash
uv run --extra dev ruff check src/ tests/
uv run --extra dev pytest tests/ -v
npm --prefix web run build
```

## Gmail setup

### Local development

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/)
2. Enable the Gmail API
3. Create OAuth 2.0 credentials (Desktop app type)
4. Download as `credentials.json` in the project root
5. On first run, a browser window opens for consent. The token is cached to `token.json`

Required scopes: `gmail.send` + `gmail.modify`

### Cloud Run

Cloud Run Jobs run non-interactively, so they use Secret Manager-backed JSON
environment variables instead of opening the installed-app browser flow.

1. Complete the local OAuth flow once to create `token.json`.
2. Store the OAuth client credentials JSON and authorized-user token JSON in
   Secret Manager:

   ```bash
   gcloud secrets versions add smokescreen-gmail-credentials \
     --data-file=credentials.json
   gcloud secrets versions add smokescreen-gmail-token \
     --data-file=token.json
   ```

3. Deploy with Terraform. The Cloud Run jobs receive
   `SMOKESCREEN_GMAIL_CREDENTIALS_JSON` and `SMOKESCREEN_GMAIL_TOKEN_JSON` from
   those secrets, and `SMOKESCREEN_GMAIL_OAUTH_INTERACTIVE=false` prevents any
   browser-based OAuth attempt in production.

The token JSON must include a `refresh_token`. If consent was granted without a
refresh token, revoke the app grant in the Google account and repeat the local
flow. `SMOKESCREEN_GMAIL_CREDENTIALS_JSON` and
`SMOKESCREEN_GMAIL_TOKEN_JSON` take precedence over the local file path settings
when present.

### Polling scope

`smokescreen poll` only processes active broker records with stored Gmail
thread IDs. When `SMOKESCREEN_POLL_LABEL` is non-empty, polling first searches
Gmail for messages with that label and then only fetches active records whose
stored thread ID appears in the labeled search results. Set
`SMOKESCREEN_POLL_LABEL=""` to disable label filtering and poll every active
stored thread.

## Dashboard

The web dashboard provides a UI for monitoring and managing the opt-out process:

By default, `smokescreen serve` listens on `http://127.0.0.1:8000`.

```bash
smokescreen serve
smokescreen serve --host 0.0.0.0 --port 9000
```

**Tabs:**

- **Status** — Overview route at `/` with working, removed, and needs-attention broker records
- **Brokers** — Broker registry route at `/brokers`; add, edit, delete, enable, disable, import, and run outreach for selected brokers
- **Needs Attention** — Manual-review route at `/needs-attention` for `NEEDS_MANUAL`, `FAILED`, and `REJECTED` records
- **Settings** — Configure identity, verification profile, Gmail status, AI provider, cadence, and trusted senders

The onboarding flow is available at `/setup` and `/onboarding`. It persists
the enabled broker selection used by scheduled outreach. The `/trusted-senders`
route remains available for direct trusted-sender management, but trusted
sender controls are also embedded in Settings.

### Outreach broker selection gate

Smokescreen outreach uses a safety gate: scheduled outreach and the
`smokescreen outreach` CLI only contact brokers from the persisted enabled
broker selection. A fresh install has no enabled brokers, so the CLI exits with
an error and the scheduled Cloud Run job skips without sending. Enable brokers
from the dashboard Setup flow or Brokers page before running outreach.

`POST /api/outreach` follows the same gate when `broker_ids` is omitted. The
one-shot onboarding and Brokers-page flows pass explicit `broker_ids`, which
run only that selected subset.

**Signing out (deployed dashboard):**

The deployed dashboard sits behind Identity-Aware Proxy (IAP), which maintains
its own session cookie separate from your Google account session. The header's
**Sign out** button clears local dashboard state and then redirects to IAP's
documented clear-cookie endpoint (`?gcp-iap-mode=CLEAR_LOGIN_COOKIE`),
dropping the IAP session for Smokescreen.

Clearing the IAP session does **not** sign you out of Google. If your browser
still has an active Google session, reopening the dashboard URL may sign you
back in automatically or show a Google account picker. To fully sign out of
Google, sign out at [accounts.google.com](https://accounts.google.com/Logout).

## Configuration

All settings use the `SMOKESCREEN_` env prefix. They can be set via environment variables, the settings JSON file, or the dashboard Settings tab.

**Precedence:** Environment variables > JSON file > Pydantic defaults

| Variable | Default | Description |
|----------|---------|-------------|
| `SMOKESCREEN_SENDER_EMAIL` | `""` | Gmail address to send from |
| `SMOKESCREEN_SENDER_NAME` | `""` | Full legal name for requests |
| `SMOKESCREEN_AI_PROVIDER` | `gemini` | Reply classifier provider: `gemini` or `anthropic`. See the AI provider section below. |
| `SMOKESCREEN_ANTHROPIC_API_KEY` | `""` | Claude API key |
| `SMOKESCREEN_ANTHROPIC_MODEL` | `claude-sonnet-4-20250514` | Claude model |
| `SMOKESCREEN_GEMINI_MODEL` | `gemini-3.1-flash-lite` | Vertex AI Gemini model for reply classification |
| `SMOKESCREEN_GEMINI_PROJECT` | `""` | GCP project for Vertex AI; defaults to Firestore project or ADC environment |
| `SMOKESCREEN_GEMINI_LOCATION` | `global` | Vertex AI location for Gemini |
| `SMOKESCREEN_STATE_BACKEND` | `sqlite` | `sqlite` or `firestore` |
| `SMOKESCREEN_SQLITE_PATH` | `~/.smokescreen/data.db` | SQLite database path |
| `SMOKESCREEN_FIRESTORE_PROJECT` | `""` | GCP project for Firestore |
| `SMOKESCREEN_FIRESTORE_COLLECTION` | `opt_outs` | Firestore collection name |
| `SMOKESCREEN_GMAIL_CREDENTIALS_PATH` | `credentials.json` | OAuth client credentials |
| `SMOKESCREEN_GMAIL_TOKEN_PATH` | `token.json` | Cached OAuth token |
| `SMOKESCREEN_GMAIL_CREDENTIALS_JSON` | `""` | OAuth client credentials JSON from Secret Manager |
| `SMOKESCREEN_GMAIL_TOKEN_JSON` | `""` | Authorized-user OAuth token JSON from Secret Manager |
| `SMOKESCREEN_GMAIL_OAUTH_INTERACTIVE` | `true` | Allow browser OAuth when no reusable token is available |
| `SMOKESCREEN_MAX_RETRIES` | `5` | Max retries before FAILED |
| `SMOKESCREEN_POLL_LABEL` | `smokescreen` | Gmail label used to select active stored threads during polling; set blank to poll all active stored threads |
| `SMOKESCREEN_DRY_RUN` | `false` | Skip actual sends |
| `SMOKESCREEN_REREQUEST_INTERVAL_DAYS` | `30` | Days after completion before re-sending a deletion request |
| `SMOKESCREEN_STATE_TIMEOUT_DAYS` | `14` | Days before a waiting record is pinged; a second silent period escalates to `NEEDS_MANUAL` |
| `SMOKESCREEN_SETTINGS_FILE` | `settings.json` | Path to the settings JSON file |

### AI provider

Smokescreen defaults to Vertex AI Gemini everywhere the Pydantic settings
defaults are used. Local development can authenticate Gemini with
`gcloud auth application-default login`; Cloud Run uses its service account.
Gemini does not use a separate API key, but the project must have
`aiplatform.googleapis.com` enabled and the runtime service account must have
`roles/aiplatform.user`.

Anthropic Claude remains supported. Set `SMOKESCREEN_AI_PROVIDER=anthropic`
and provide `SMOKESCREEN_ANTHROPIC_API_KEY` (and optionally
`SMOKESCREEN_ANTHROPIC_MODEL`) to use Claude instead of Gemini. See
[docs/DEPLOY.md](docs/DEPLOY.md) for the Terraform provider modes.

The default Gemini model is `gemini-3.1-flash-lite`. Google Cloud's
[Gemini 3.1 Flash-Lite model page](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-1-flash-lite)
lists `gemini-3.1-flash-lite` as the GA model ID, and the
[Provisioned Throughput supported-models page](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/provisioned-throughput/supported-models)
lists it as the latest supported version for Gemini 3.1 Flash-Lite.

### Settings file

Settings can be persisted to a JSON file (default: `settings.json`) via the dashboard Settings tab or the `PUT /api/settings` endpoint. Environment variables always take precedence over file-based settings. Changes to identity, email, or state backend settings require a server restart.

### Verification profile

The dashboard Settings page includes an optional Verification Profile. It is
persisted in the state backend alongside broker selections, not in environment
variables or the settings JSON file. You can store home addresses, phone
numbers, email aliases, date of birth, last-four SSN, employer name, and
additional notes.

When a broker reply is classified as `INFO_REQUEST`, Smokescreen extracts the
requested fields. If every requested field is available in the Verification
Profile, Smokescreen sends a follow-up containing only those requested fields.
If the broker asks for documents, asks for an unsupported/ambiguous field, or
the profile is missing a requested field, the record moves to `NEEDS_MANUAL`
and Needs Attention shows what the broker asked for and what is missing.

## State machine

```
PENDING
  -> INITIAL_SENT
  -> FAILED

INITIAL_SENT
  -> INITIAL_SENT_PINGED
  -> AWAITING_RESPONSE
  -> INFO_REQUESTED
  -> FAILED

INITIAL_SENT_PINGED
  -> AWAITING_RESPONSE
  -> INFO_REQUESTED
  -> NEEDS_MANUAL
  -> FAILED

AWAITING_RESPONSE
  -> AWAITING_RESPONSE_PINGED
  -> INFO_REQUESTED
  -> COMPLETED
  -> REJECTED
  -> NEEDS_MANUAL
  -> FAILED

AWAITING_RESPONSE_PINGED
  -> INFO_REQUESTED
  -> COMPLETED
  -> REJECTED
  -> NEEDS_MANUAL
  -> FAILED

INFO_REQUESTED
  -> INFO_REQUESTED_PINGED
  -> FOLLOW_UP_SENT
  -> NEEDS_MANUAL
  -> FAILED

INFO_REQUESTED_PINGED
  -> FOLLOW_UP_SENT
  -> NEEDS_MANUAL
  -> FAILED

FOLLOW_UP_SENT
  -> FOLLOW_UP_SENT_PINGED
  -> AWAITING_RESPONSE
  -> NEEDS_MANUAL
  -> FAILED

FOLLOW_UP_SENT_PINGED
  -> AWAITING_RESPONSE
  -> NEEDS_MANUAL
  -> FAILED

COMPLETED -> PENDING (scheduled re-request)
NEEDS_MANUAL -> PENDING | COMPLETED | FAILED
REJECTED and FAILED are terminal
```

The waiting states are `INITIAL_SENT`, `AWAITING_RESPONSE`, `INFO_REQUESTED`,
and `FOLLOW_UP_SENT`. If one remains unchanged for
`SMOKESCREEN_STATE_TIMEOUT_DAYS`, polling sends one status-check ping and moves
the record to the paired `*_PINGED` state. If the pinged state sits through a
second silent timeout, Smokescreen escalates the record to `NEEDS_MANUAL`.
Legacy stored values `IDENTITY_REQUESTED` and `IDENTITY_SENT` are mapped at read
time to `INFO_REQUESTED` and `FOLLOW_UP_SENT`.

## CI and releases

Pushes to `main` run semantic-release with Conventional Commits to update
`pyproject.toml`, maintain `CHANGELOG.md`, and create `vX.Y.Z` tags. Release
tags build and push `linux/amd64` Docker images to Artifact Registry as both
the version tag and `latest` using GitHub Actions Workload Identity Federation.

## Deployment

Smokescreen can be deployed to Google Cloud as a personal cloud tool. The
deployed shape is intentionally single-user: one IAP-gated Cloud Run dashboard,
one Gmail mailbox connected through OAuth, scheduled polling and outreach jobs,
Firestore state, Secret Manager values for Gmail OAuth, and optionally an
Anthropic API key when `SMOKESCREEN_AI_PROVIDER=anthropic`.

The dashboard IAP allowlist should contain the deployer's Google account, and
the connected Gmail account should be the mailbox that sends opt-out requests
and receives broker replies. Multi-tenant support is not currently in scope and
would require separate user auth, per-user Gmail connections, tenant-aware
storage, and stricter authorization boundaries.

Use the deployment docs for the path that matches your goal:

- [docs/SETUP.md](docs/SETUP.md) — one-time GCP project bootstrap: project,
  billing, isolated `gcloud` config, APIs, Artifact Registry, OAuth consent,
  OAuth client credentials, and budget alerts.
- [docs/DEPLOY.md](docs/DEPLOY.md) — repeatable deployment: choose an image,
  run Terraform, generate `token.json`, populate Secret Manager, verify IAP and
  Scheduler, and update or roll back image versions.
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — local development and
  contribution workflow: clone, install, run locally, test, lint, understand
  release automation, configure fork CI, extend AI providers, and get changes
  merged.

## Brokers

20 data brokers are included in `src/smokescreen/brokers/brokers.yaml`. Add more by editing that file. Each broker needs:

```yaml
- id: unique-slug
  name: Human Name
  domain: example.com
  privacy_email: privacy@example.com
  aliases: []        # optional alternative domains
  notes: ""          # optional notes
```

## Security

- Gmail scopes restricted to `gmail.send` + `gmail.modify`
- Verification profile values are never sent to the AI classifier; only email text is used
- Identity document uploads have been removed; document requests move records to manual review
- Cloud Run SA has least-privilege IAM roles
- Credentials, tokens, and databases are gitignored

## Development

```bash
uv sync --extra dev
./scripts/check
```

The quality gate runs the runbook shell guard, Ruff, the Python test suite,
web dependency installation, web tests, the web build, and a Docker image smoke
check:

```bash
uv run python scripts/check_runbook_shell.py
uv run --extra dev ruff check src/ tests/ scripts/check_runbook_shell.py
uv run --extra dev pytest tests/ -v
npm --prefix web ci
npm --prefix web run test
npm --prefix web run build
docker_image="${SMOKESCREEN_DOCKER_IMAGE:-smokescreen:check}"
docker build -t "$docker_image" .
docker run --rm "$docker_image" --help
```

## API endpoints

The dashboard server exposes a REST API:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | React dashboard |
| `GET` | `/app` | Redirect legacy app mount to `/` |
| `GET` | `/app/{path}` | Redirect legacy app routes to root-relative routes |
| `GET` | `/{path}` | React dashboard fallback for non-API paths |
| `GET` | `/api/brokers` | List all brokers |
| `POST` | `/api/brokers` | Add a broker |
| `POST` | `/api/brokers/import` | Import brokers from CSV |
| `GET` | `/api/brokers/selections` | Get enabled broker IDs for outreach |
| `PUT` | `/api/brokers/selections` | Persist enabled broker IDs for outreach |
| `PUT` | `/api/brokers/{broker_id}` | Update a broker |
| `DELETE` | `/api/brokers/{broker_id}` | Delete a broker |
| `GET` | `/api/optouts` | List opt-out records (optional `?status=` filter) |
| `POST` | `/api/optouts/{broker_id}/reset` | Reset a broker to `PENDING` |
| `POST` | `/api/optouts/{broker_id}/handled` | Mark a needs-attention record handled/completed |
| `POST` | `/api/outreach` | Run outreach for enabled brokers or an explicit broker subset |
| `GET` | `/api/version` | Running app version |
| `GET` | `/api/stats` | Completion stats |
| `GET` | `/api/stats/extended` | Extended dashboard metrics and recent activity |
| `GET` | `/api/whitelist` | List whitelisted emails |
| `POST` | `/api/whitelist` | Add an email to the whitelist |
| `DELETE` | `/api/whitelist/{entry_id}` | Remove a whitelist entry |
| `GET` | `/api/whitelist/pending` | List pending whitelist requests |
| `POST` | `/api/whitelist/pending/{entry_id}/approve` | Approve a pending request |
| `POST` | `/api/whitelist/pending/{entry_id}/reject` | Reject a pending request |
| `GET` | `/api/settings` | Get current settings (sensitive fields masked) |
| `GET` | `/api/settings/verification-profile` | Get the persisted verification profile |
| `PUT` | `/api/settings/verification-profile` | Replace the persisted verification profile |
| `GET` | `/api/settings/advanced` | Get advanced settings fields |
| `PUT` | `/api/settings` | Update settings (partial, persisted to JSON file) |

## Project layout

```
src/smokescreen/
    cli.py              # Click CLI (outreach, poll, status, reset, serve)
    config.py           # Pydantic Settings with JSON file persistence
    models.py           # Domain models
    api.py              # FastAPI REST API + React dashboard serving
    brokers/
        registry.py     # Broker lookup
        brokers.yaml    # Broker definitions
    email/
        client.py       # Gmail API wrapper
        oauth.py        # OAuth2 flow
        templates.py    # Jinja2 email templates
    ai/
        classifier.py   # Classify broker replies
        composer.py     # Compose AI replies
        prompts.py      # Prompt templates
    state/
        machine.py      # State transition rules
        store.py        # StateStore protocol
        sqlite.py       # SQLite backend
        firestore.py    # Firestore backend
    jobs/
        outreach.py     # Send initial opt-out emails
        poll.py         # Poll inbox and respond
infra/                  # Terraform (Cloud Run, Scheduler, etc.)
Dockerfile              # Container image
tests/                  # Test suite
```

## License

This project is licensed under the Apache License 2.0. See [LICENSE](LICENSE) for details.
