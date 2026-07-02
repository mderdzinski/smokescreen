# Smokescreen

Automated data broker opt-out system. Sends CCPA/privacy deletion requests to data brokers via email, classifies their replies using Claude, and handles the back-and-forth (identity verification, follow-ups) until completion.

## How it works

1. **Outreach** — Sends templated opt-out emails to all known data brokers
2. **Poll** — Checks inbox for replies, classifies them with Claude (acknowledgment, identity request, completed, rejected, needs manual review), and responds automatically
3. **State machine** — Tracks each broker through: `PENDING → INITIAL_SENT → AWAITING_RESPONSE → COMPLETED/REJECTED/FAILED`

## Quick start

```bash
# Install
uv sync

# Configure (minimum required)
export SMOKESCREEN_SENDER_EMAIL="you@gmail.com"
export SMOKESCREEN_SENDER_NAME="Your Legal Name"
export SMOKESCREEN_ANTHROPIC_API_KEY="sk-ant-..."

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
| `SMOKESCREEN_ANTHROPIC_API_KEY` | `""` | Claude API key |
| `SMOKESCREEN_ANTHROPIC_MODEL` | `claude-sonnet-4-20250514` | Claude model |
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
See [`docs/CI_SETUP.md`](docs/CI_SETUP.md) for the one-time Google Cloud and
GitHub Actions setup.

## Cloud deployment

The `infra/` directory contains Terraform for deploying to GCP:

- **Cloud Run Jobs**: `smokescreen-poll` (every 10 min) and `smokescreen-outreach` (daily 9am)
- **Cloud Run Dashboard**: `smokescreen-dashboard`, running `serve --host 0.0.0.0 --port 8080` behind IAP with scale-to-zero and a single maximum instance
- **Firestore**: Serverless state storage
- **Secret Manager**: Gmail OAuth credentials/token and Anthropic API key
- **IAM**: A Smokescreen jobs service account with Firestore, Secret Manager, and per-job Cloud Run invoker access; a dashboard service account with Firestore write access and access only to the Smokescreen secrets; and IAP dashboard access for `dashboard_allowed_user`

Enable the required project APIs before applying:

```bash
gcloud services enable \
  run.googleapis.com \
  cloudscheduler.googleapis.com \
  firestore.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com
```

Use a named gcloud configuration for this project so Smokescreen project and
account settings stay isolated from other local Google Cloud work:

```bash
gcloud config configurations create smokescreen
gcloud config configurations activate smokescreen
gcloud config set project smokescreen-app
gcloud config set run/region us-central1
```

Required Terraform variables:

| Variable | Description |
|----------|-------------|
| `project_id` | GCP project ID that owns Firestore, Secret Manager, Cloud Run, and Scheduler |
| `region` | Region for Cloud Run Jobs, Firestore, and Cloud Scheduler; defaults to `us-central1` |
| `sender_email` | Gmail address used in opt-out email headers and replies |
| `sender_name` | Full legal name used in opt-out requests |
| `image` | Published container image URI for the Cloud Run Jobs and dashboard service |
| `dashboard_allowed_user` | Google account email granted IAP access to the dashboard; defaults to `mark.derdzinski@gmail.com` |

The dashboard uses the default Cloud Run `run.app` URL after deployment. IAP is
enabled on the service, and Terraform grants `roles/iap.httpsResourceAccessor`
to `user:${dashboard_allowed_user}`.

```bash
cd infra
terraform init
terraform plan -var="project_id=your-project" \
               -var="sender_email=you@gmail.com" \
               -var="sender_name=Your Name" \
               -var="image=gcr.io/your-project/smokescreen:latest"
terraform apply
```

Plan validation does not require writing to a project when refresh is disabled.
This sample should produce a create-only plan with the Cloud Run Jobs, Scheduler
jobs, secrets, Firestore database, service account, and IAM bindings:

```bash
terraform fmt -check -recursive
terraform validate
terraform plan -refresh=false -input=false \
  -var="project_id=smokescreen-dev-123456" \
  -var="region=us-central1" \
  -var="sender_email=privacy@example.com" \
  -var="sender_name=Example User" \
  -var="image=us-central1-docker.pkg.dev/smokescreen-dev-123456/smokescreen/smokescreen:latest"
```

Terraform creates the Gmail and Anthropic Secret Manager secret containers. The
secret payload values are populated by hand after the first successful apply so
they do not land in Terraform state. Add secret versions before running the
scheduled jobs or opening the dashboard:

```bash
gcloud secrets versions add smokescreen-gmail-credentials \
  --data-file=credentials.json
gcloud secrets versions add smokescreen-gmail-token \
  --data-file=token.json
printf '%s' "$SMOKESCREEN_ANTHROPIC_API_KEY" | \
  gcloud secrets versions add smokescreen-anthropic-key --data-file=-
```

Required secret payloads:

| Secret | Payload |
|--------|---------|
| `smokescreen-gmail-credentials` | Gmail OAuth client credentials JSON from Google Cloud Console |
| `smokescreen-gmail-token` | Authorized-user token JSON from the one-time local OAuth flow; must include a `refresh_token` |
| `smokescreen-anthropic-key` | Anthropic API key text |

### Cloud Scheduler invocation validation

Terraform configures each Scheduler job to POST to the Cloud Run Jobs Run API:

```text
https://REGION-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/PROJECT_ID/jobs/smokescreen-poll:run
https://REGION-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/PROJECT_ID/jobs/smokescreen-outreach:run
```

The Scheduler HTTP targets use an OAuth access token for
`smokescreen@PROJECT_ID.iam.gserviceaccount.com`, and Terraform grants that
service account `roles/run.invoker` on only the two Smokescreen jobs. Because
the target host is `*.googleapis.com`, Cloud Scheduler should use OAuth rather
than OIDC for this path.

After `terraform apply` and secret-version creation, verify the Scheduler
configuration and force one run:

```bash
export PROJECT_ID="your-project"
export REGION="us-central1"
export SMOKESCREEN_SA="smokescreen@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud scheduler jobs describe smokescreen-poll-schedule \
  --location="$REGION" \
  --format="value(httpTarget.oauthToken.serviceAccountEmail,httpTarget.uri)"

gcloud run jobs get-iam-policy smokescreen-poll \
  --region="$REGION" \
  --flatten="bindings[].members" \
  --filter="bindings.role:roles/run.invoker AND bindings.members:serviceAccount:${SMOKESCREEN_SA}"

gcloud scheduler jobs run smokescreen-poll-schedule --location="$REGION"
gcloud run jobs executions list \
  --job=smokescreen-poll \
  --region="$REGION" \
  --limit=1
```

Repeat the same checks for `smokescreen-outreach-schedule` and
`smokescreen-outreach`. A successful forced Scheduler run creates a new Cloud
Run Job execution; if the execution starts and then fails inside the container,
the invocation path is working and the failure should be debugged from the job
logs and secret payloads.

### Building the container

```bash
docker build -t smokescreen .
docker tag smokescreen gcr.io/your-project/smokescreen:latest
docker push gcr.io/your-project/smokescreen:latest
```

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
- Identity documents are never sent to Claude — only email text
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
