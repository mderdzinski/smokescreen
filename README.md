# Smokescreen

Automated data broker opt-out system. Sends CCPA/privacy deletion requests to data brokers via email, classifies their replies using Claude or Vertex AI Gemini, and handles the back-and-forth (identity verification, follow-ups) until completion.

## How it works

1. **Outreach** — Sends templated opt-out emails to all known data brokers
2. **Poll** — Checks inbox for replies, classifies them with the configured AI provider (acknowledgment, identity request, completed, rejected, needs manual review), and responds automatically
3. **State machine** — Tracks each broker through: `PENDING → INITIAL_SENT → AWAITING_RESPONSE → COMPLETED/REJECTED/FAILED`

## Quick start

```bash
# Install
uv sync

# Configure (minimum required)
export SMOKESCREEN_SENDER_EMAIL="YOUR_EMAIL"
export SMOKESCREEN_SENDER_NAME="Your Legal Name"
export SMOKESCREEN_ANTHROPIC_API_KEY="sk-ant-..."

# Optional: use Vertex AI Gemini instead of Anthropic
# export SMOKESCREEN_AI_PROVIDER="gemini"
# export SMOKESCREEN_GEMINI_PROJECT="your-gcp-project"
# export SMOKESCREEN_GEMINI_LOCATION="global"

# Set up Gmail OAuth (one-time — opens browser)
# Place your Google Cloud OAuth client credentials at ./credentials.json
# See "Gmail setup" below

# Dry run — simulate outreach without sending email
smokescreen --dry-run outreach

# Send opt-out emails
smokescreen outreach

# Check for and process replies
smokescreen poll

# View status of all brokers
smokescreen status

# Reset a broker to try again
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

Required scopes: `gmail.send` + `gmail.readonly`

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

```bash
smokescreen serve                    # default: http://127.0.0.1:8000
smokescreen serve --host 0.0.0.0 --port 9000
```

**Tabs:**

- **Broker Status** — Overview of all opt-out records with status, retries, and reset actions
- **Manual Queue** — Brokers flagged as `NEEDS_MANUAL` for human intervention
- **Broker Registry** — Add, edit, or delete data brokers
- **Email Whitelist** — Manage whitelisted email addresses (auto-synced from broker registry)
- **Pending Whitelist** — Approve or reject new whitelist requests detected from incoming mail
- **Settings** — Configure all settings via the UI (persisted to a JSON file)

## Configuration

All settings use the `SMOKESCREEN_` env prefix. They can be set via environment variables, the settings JSON file, or the dashboard Settings tab.

**Precedence:** Environment variables > JSON file > Pydantic defaults

| Variable | Default | Description |
|----------|---------|-------------|
| `SMOKESCREEN_SENDER_EMAIL` | `""` | Gmail address to send from |
| `SMOKESCREEN_SENDER_NAME` | `""` | Full legal name for requests |
| `SMOKESCREEN_AI_PROVIDER` | `anthropic` | Reply classifier provider: `anthropic` or `gemini` |
| `SMOKESCREEN_ANTHROPIC_API_KEY` | `""` | Claude API key |
| `SMOKESCREEN_ANTHROPIC_MODEL` | `claude-sonnet-4-20250514` | Claude model |
| `SMOKESCREEN_GEMINI_MODEL` | `gemini-3.1-flash-lite` | Vertex AI Gemini model for reply classification |
| `SMOKESCREEN_GEMINI_PROJECT` | `""` | GCP project for Vertex AI; defaults to Firestore project or ADC environment |
| `SMOKESCREEN_GEMINI_LOCATION` | `global` | Vertex AI location for Gemini |
| `SMOKESCREEN_STATE_BACKEND` | `sqlite` | `sqlite` or `firestore` |
| `SMOKESCREEN_SQLITE_PATH` | `smokescreen.db` | SQLite database path |
| `SMOKESCREEN_FIRESTORE_PROJECT` | `""` | GCP project for Firestore |
| `SMOKESCREEN_FIRESTORE_COLLECTION` | `opt_outs` | Firestore collection name |
| `SMOKESCREEN_GMAIL_CREDENTIALS_PATH` | `credentials.json` | OAuth client credentials |
| `SMOKESCREEN_GMAIL_TOKEN_PATH` | `token.json` | Cached OAuth token |
| `SMOKESCREEN_GMAIL_CREDENTIALS_JSON` | `""` | OAuth client credentials JSON from Secret Manager |
| `SMOKESCREEN_GMAIL_TOKEN_JSON` | `""` | Authorized-user OAuth token JSON from Secret Manager |
| `SMOKESCREEN_GMAIL_OAUTH_INTERACTIVE` | `true` | Allow browser OAuth when no reusable token is available |
| `SMOKESCREEN_IDENTITY_DOCS_DIR` | `identity/` | Pre-redacted ID documents |
| `SMOKESCREEN_MAX_RETRIES` | `5` | Max retries before FAILED |
| `SMOKESCREEN_POLL_LABEL` | `smokescreen` | Gmail label used to select active stored threads during polling; set blank to poll all active stored threads |
| `SMOKESCREEN_DRY_RUN` | `false` | Skip actual sends |
| `SMOKESCREEN_SETTINGS_FILE` | `settings.json` | Path to the settings JSON file |

### AI provider

Anthropic is the default provider and preserves existing deployments: set
`SMOKESCREEN_ANTHROPIC_API_KEY` and optionally `SMOKESCREEN_ANTHROPIC_MODEL`.
This has minimal GCP AI setup, but requires a separate Anthropic account and API
key.

Gemini uses Vertex AI through the official Google Gen AI SDK and Application
Default Credentials. Set `SMOKESCREEN_AI_PROVIDER=gemini`; local development can
authenticate with `gcloud auth application-default login`, and Cloud Run uses
its service account. Gemini does not use a separate API key, but the project must
have `aiplatform.googleapis.com` enabled and the runtime service account must
have `roles/aiplatform.user`.

The default Gemini model is `gemini-3.1-flash-lite`. Google Cloud's
[Gemini 3.1 Flash-Lite model page](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-1-flash-lite)
lists `gemini-3.1-flash-lite` as the GA model ID, and the
[Provisioned Throughput supported-models page](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/provisioned-throughput/supported-models)
lists it as the latest supported version for Gemini 3.1 Flash-Lite.

### Settings file

Settings can be persisted to a JSON file (default: `settings.json`) via the dashboard Settings tab or the `PUT /api/settings` endpoint. Environment variables always take precedence over file-based settings. Changes to identity, email, or state backend settings require a server restart.

## State machine

```
PENDING
  → INITIAL_SENT
    → AWAITING_RESPONSE
      → IDENTITY_REQUESTED → IDENTITY_SENT → AWAITING_RESPONSE (cycle)
      → COMPLETED
      → REJECTED
      → NEEDS_MANUAL
      → FAILED

Any active state → FAILED (after max retries)
NEEDS_MANUAL → PENDING (manual reset)
```

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

- Gmail scopes restricted to `gmail.send` + `gmail.readonly`
- Identity documents are never sent to the AI classifier; only email text is used
- Pre-redacted docs stored locally or in GCS
- Cloud Run SA has least-privilege IAM roles
- Credentials, tokens, and databases are gitignored

## Development

```bash
uv sync --extra dev
./scripts/check
```

The quality gate runs Ruff, the test suite, and a Docker image smoke check:

```bash
uv run --extra dev ruff check src/ tests/
uv run --extra dev pytest tests/ -v
docker_image="${SMOKESCREEN_DOCKER_IMAGE:-smokescreen:check}"
docker build -t "$docker_image" .
docker run --rm "$docker_image" --help
```

## API endpoints

The dashboard server exposes a REST API:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | React dashboard |
| `GET` | `/api/brokers` | List all brokers |
| `POST` | `/api/brokers` | Add a broker |
| `PUT` | `/api/brokers/{id}` | Update a broker |
| `DELETE` | `/api/brokers/{id}` | Delete a broker |
| `GET` | `/api/optouts` | List opt-out records (optional `?status=` filter) |
| `POST` | `/api/optouts/{id}/reset` | Reset a broker to PENDING |
| `GET` | `/api/stats` | Completion stats |
| `GET` | `/api/whitelist` | List whitelisted emails |
| `POST` | `/api/whitelist` | Add an email to the whitelist |
| `DELETE` | `/api/whitelist/{id}` | Remove a whitelist entry |
| `GET` | `/api/whitelist/pending` | List pending whitelist requests |
| `POST` | `/api/whitelist/pending/{id}/approve` | Approve a pending request |
| `POST` | `/api/whitelist/pending/{id}/reject` | Reject a pending request |
| `GET` | `/api/settings` | Get current settings (sensitive fields masked) |
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
tests/                  # 78 unit tests
```
