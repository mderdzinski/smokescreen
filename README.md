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

# Dry run — preview what would be sent
smokescreen --dry-run outreach

# Send opt-out emails
smokescreen outreach

# Check for and process replies
smokescreen poll

# View status of all brokers
smokescreen status

# Reset a broker to try again
smokescreen reset spokeo

# Start the web dashboard
smokescreen serve
# Opens at http://127.0.0.1:8000
```

## Gmail setup

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/)
2. Enable the Gmail API
3. Create OAuth 2.0 credentials (Desktop app type)
4. Download as `credentials.json` in the project root
5. On first run, a browser window opens for consent. The token is cached to `token.json`

Required scopes: `gmail.send` + `gmail.readonly`

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
| `SMOKESCREEN_IDENTITY_DOCS_DIR` | `identity/` | Pre-redacted ID documents |
| `SMOKESCREEN_MAX_RETRIES` | `5` | Max retries before FAILED |
| `SMOKESCREEN_POLL_LABEL` | `smokescreen` | Gmail label to filter poll results |
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

## Cloud deployment

The `infra/` directory contains Terraform for deploying to GCP:

- **Cloud Run Jobs**: `smokescreen-poll` (every 10 min) and `smokescreen-outreach` (daily 9am)
- **Firestore**: Serverless state storage
- **Secret Manager**: Gmail OAuth tokens and Anthropic API key
- **IAM**: Least-privilege service account

```bash
cd infra
terraform init
terraform plan -var="project_id=your-project" \
               -var="sender_email=you@gmail.com" \
               -var="sender_name=Your Name" \
               -var="image=gcr.io/your-project/smokescreen:latest"
terraform apply
```

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
uv run pytest tests/ -v
uv run ruff check src/ tests/
```

## API endpoints

The dashboard server exposes a REST API:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Dashboard HTML |
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
    api.py              # FastAPI REST API + dashboard
    dashboard.html      # Single-page dashboard UI
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
