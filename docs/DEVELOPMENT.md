# Smokescreen Development

This guide covers building, testing, modifying, and contributing to
Smokescreen. No Google Cloud project is required for normal application
development unless you are testing infrastructure changes, publishing Docker
images from a fork, or exercising Vertex AI Gemini against a real GCP project.

## Clone the Repository

```bash
git clone https://github.com/YOUR_GITHUB_OWNER/YOUR_REPO.git
cd smokescreen
```

If you are contributing to the upstream repository, use the maintainer-provided
remote and branch workflow for your change.

## Install Dependencies

Install Python dependencies with `uv`:

```bash
uv sync --extra dev
```

Install React dashboard dependencies with npm:

```bash
npm --prefix web install
```

## Run Smokescreen Locally

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

## Run Tests and Linters

Run the Python test suite:

```bash
uv run pytest tests/ -v
```

Run Ruff:

```bash
uv run ruff check .
```

Build the web dashboard:

```bash
npm --prefix web run build
```

For navbar UI changes, verify Windows Chrome and Firefox, or force native
scrollbar visibility in browser tooling, to check that horizontal tab scrolling
does not introduce vertical scroll artifacts.

### Regenerating the hero banner

The README hero banner is regenerated manually, not in CI. After editing
`docs/assets/_hero.html` or related image assets, run:

```bash
uv run python scripts/render_hero.py
```

For the full local quality gate used by this repository when Docker is
available, run:

```bash
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

If you are touching Terraform, also validate the infrastructure configuration:

```bash
terraform -chdir=infra validate
```

## Refresh the Broker Registry

The bundled broker registry lives at
`src/smokescreen/brokers/brokers.yaml`. It currently contains 596 brokers from
the California Attorney General 2026 data broker registry plus curated entries.
To regenerate it from a California
Attorney General data broker registry CSV, keep the CSV as a local ignored input
and run:

```bash
uv run python scripts/import_ca_registry.py "/path/to/California Data Broker Registry 2026.csv"
```

The importer requires a primary contact email for each row, derives deterministic
broker IDs from broker names, reports skipped missing-email rows and duplicate
slug resolutions, and preserves hand-curated brokers that are not represented in
the CSV. The CSV itself should not be committed.

## Gmail Poll Label Flow

Outreach applies the configured `poll_label` setting, default `smokescreen`, to
each successfully sent outbound Gmail thread. The Gmail client looks up the
label ID once, creates the label if it does not already exist, caches the ID for
later sends in the same process, and applies it with `users.threads.modify`.
Applying the same label again is safe on retries.

The poll job uses `label:<poll_label>` as its Gmail discovery query before
processing tracked broker threads. If `poll_label` is blank, label scoping is
disabled and outreach does not label outbound threads.

Labeling is intentionally best effort. If Gmail accepts the send but label
application fails, outreach logs `label_apply_failed`, records the email as
sent, and leaves the opt-out record usable for manual recovery.

Existing outbound threads sent before this behavior was added need manual
recovery: find the known Gmail thread by broker, subject, or stored `thread_id`,
apply the configured Gmail label manually, and rerun poll so replies appear in
the label-scoped search.

Label creation and thread modification require OAuth tokens with
`https://www.googleapis.com/auth/gmail.modify` in addition to Gmail send
permission. Re-run the local OAuth flow and refresh deployed token secrets after
changing scopes.

## Manual Poll Now

Deployed scheduled polling runs hourly because real broker replies usually
arrive over days or weeks. For faster feedback during manual review or broker
debugging, the dashboard exposes **Poll now** on Overview and in the inspect
modal. It calls `POST /api/poll`, which queues the `smokescreen-poll` Cloud Run
Job and returns `202` immediately with:

```json
{"status": "queued", "message": "Poll run queued"}
```

The endpoint is limited to one trigger per minute and returns `429` with a
`Retry-After` header when throttled. Retry classification does not auto-trigger
the Cloud Run job because Retry only updates local record state while poll
execution depends on deployed Cloud Run project, region, and IAM configuration.
After using Retry, click **Poll now** when you want immediate reclassification.

## End-to-End Synthetic Broker Testing

For solo testing without a second email account, deploy the synthetic broker
with Terraform and set `allow_self_reply=true` so poll can process replies from
`SMOKESCREEN_SENDER_EMAIL`:

```bash
terraform apply \
  -var="test_broker_email=your.email+testbroker@gmail.com" \
  -var="allow_self_reply=true"
```

`allow_self_reply` is manually applied like `test_broker_email`. It is not wired
into automated CI deploy variables, so auto-deploys reset
`SMOKESCREEN_ALLOW_SELF_REPLY` to `false`; that safety behavior is deliberate.

The operator must also add their `sender_email` or the exact plus-alias sender
to Trusted Senders in dashboard Settings. The self-reply bypass only disables
the sender-email exclusion in poll; it does not bypass Trusted Senders.

Broker enablement is controlled by the dashboard's Broker Registry toggles.
The persisted broker selections document is authoritative for scheduled
outreach: disabled brokers stay out of the queue until a user enables them
again. Code-level defaults, including `SMOKESCREEN_TEST_BROKER_ENABLED`, only
seed the initial selections document when it does not exist yet. After a user
explicitly disables a broker, that disabled state survives restarts, redeploys,
and continued presence of test broker environment variables.

Every poll run that uses the bypass for a message logs a WARNING named
`self_reply_bypass_active`. Do not enable this setting in production.

## Firestore Indexes

Firestore composite indexes are Terraform-managed in `infra/main.tf`. Any new
compound query in `src/smokescreen/state/` or `src/smokescreen/jobs/` needs a
matching `google_firestore_index` resource before it ships.

PR checklist for Firestore changes:

- [ ] Grep the changed query path for multiple `.where(...)` calls or
      `.where(...).order_by(...)` combinations.
- [ ] Add or update the matching `google_firestore_index` resource in
      `infra/main.tf`.
- [ ] Run `terraform -chdir=infra validate`.
- [ ] Do not rely on a Console-created index for permanent production use.

## Profile Gap Ledger

Smokescreen tracks verification profile fields that brokers requested while the
field was not populated in Settings. The poll job writes one
`profile_gap_ledger` Firestore document per broker and profile field when an
`INFO_REQUEST` reply transitions to `NEEDS_MANUAL` because known requested
fields are missing. Freeform `other_details` is intentionally not parsed into
this ledger.

`GET /api/settings/profile-gaps` reads the ledger, filters out fields now
present in the current Verification Profile, aggregates by field across
brokers, and sorts by total request count. The dashboard renders the result as
a quiet advisory only in Settings -> Verification Profile; empty responses hide
the panel.

## Semantic Release

Pushes to `main` run semantic-release with Conventional Commits to update
`pyproject.toml`, maintain `CHANGELOG.md`, and create `vX.Y.Z` tags.

Use Conventional Commit prefixes intentionally:

| Prefix | Release effect |
| --- | --- |
| `feat:` | Creates a minor version bump. |
| `fix:` | Creates a patch version bump. |
| `chore:` | Usually no release unless configured otherwise. |
| `docs:` | No release for documentation-only changes. |

Use `[skip ci]` only for generated or automation commits that should not trigger
CI. Release commits in this repository use the `[skip ci]` pattern.

## GitHub Actions Workflows

[`release.yml`](../.github/workflows/release.yml) runs on pushes to `main`. It
checks out the full git history, installs semantic-release, runs the release
process, resolves the release tag created at `HEAD`, and then calls the Docker
publish workflow when a new release tag exists.

[`docker-publish.yml`](../.github/workflows/docker-publish.yml) runs on `v*`
tags and can also be called by `release.yml` through `workflow_call`. It checks
out the release tag, authenticates to Google Cloud using Workload Identity
Federation, logs in to Artifact Registry, and builds and pushes `linux/amd64`
Docker images for both the release tag and `latest`.

If your fork publishes to its own Artifact Registry repository, make sure the
workflow image target points at your `YOUR_PROJECT_ID` image path.

## Setting Up CI for a Fork

Deployers using published upstream images do not need Workload Identity
Federation. You need this section only if your fork's GitHub Actions should
publish Docker images to your Artifact Registry repository.

This setup requires `gcloud` and GitHub CLI (`gh`) if you want to set repository
variables from the shell.

Set placeholders:

```bash
export PROJECT_ID="YOUR_PROJECT_ID"
export REGION="us-central1"
export GITHUB_REPO="YOUR_GITHUB_OWNER/YOUR_REPO"
export ARTIFACT_REPO="smokescreen"
export PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" \
  --format="value(projectNumber)")"
export WIF_POOL_ID="github"
export WIF_PROVIDER_ID="github"
export GITHUB_ACTIONS_SA_NAME="smokescreen-github-actions"
export GITHUB_ACTIONS_SA_EMAIL="${GITHUB_ACTIONS_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
```

Create a service account for GitHub Actions:

```bash
gcloud iam service-accounts create "$GITHUB_ACTIONS_SA_NAME" \
  --display-name="Smokescreen GitHub Actions"

gcloud artifacts repositories add-iam-policy-binding "$ARTIFACT_REPO" \
  --location="$REGION" \
  --member="serviceAccount:${GITHUB_ACTIONS_SA_EMAIL}" \
  --role="roles/artifactregistry.writer"
```

Create the workload identity pool and GitHub OIDC provider:

```bash
gcloud iam workload-identity-pools create "$WIF_POOL_ID" \
  --project="$PROJECT_ID" \
  --location="global" \
  --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc "$WIF_PROVIDER_ID" \
  --project="$PROJECT_ID" \
  --location="global" \
  --workload-identity-pool="$WIF_POOL_ID" \
  --display-name="GitHub Actions" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition="attribute.repository == '${GITHUB_REPO}'"
```

Allow only your repository to impersonate the GitHub Actions service account:

```bash
gcloud iam service-accounts add-iam-policy-binding "$GITHUB_ACTIONS_SA_EMAIL" \
  --project="$PROJECT_ID" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL_ID}/attribute.repository/${GITHUB_REPO}"
```

Capture the provider resource name and add the GitHub repository variables used
by the workflow:

```bash
export WIF_PROVIDER="$(gcloud iam workload-identity-pools providers describe "$WIF_PROVIDER_ID" \
  --project="$PROJECT_ID" \
  --location="global" \
  --workload-identity-pool="$WIF_POOL_ID" \
  --format="value(name)")"

gh variable set WIF_PROVIDER --repo "$GITHUB_REPO" --body "$WIF_PROVIDER"
gh variable set WIF_SERVICE_ACCOUNT --repo "$GITHUB_REPO" --body "$GITHUB_ACTIONS_SA_EMAIL"
```

GitHub CLI (`gh`) is optional; you can set the same repository variables from
the GitHub web UI.

## Extending AI Providers and Classification

The classifier currently supports Anthropic and Vertex AI Gemini.

To extend classification behavior:

1. Update `src/smokescreen/ai/prompts.py` if the classifier or composer prompt
   needs new instructions.
2. Update `src/smokescreen/ai/classifier.py` for provider-specific response
   parsing or label handling.
3. Update `src/smokescreen/jobs/poll.py` so the poll job initializes the right
   client and calls the right classifier path.
4. Add or update tests in `tests/test_classifier.py` and `tests/test_poll.py`.

To add a new AI provider:

1. Add configuration fields in `src/smokescreen/config.py`.
2. Add any provider dependency to `pyproject.toml`.
3. Add provider client setup and fallback behavior in `src/smokescreen/jobs/poll.py`.
4. Add Terraform variables, environment variables, secrets, and IAM only if the
   deployed runtime needs them.
5. Document local and Cloud Run setup in [DEPLOY.md](DEPLOY.md) and this file.
6. Cover the new provider with unit tests and, where possible, mocked API
   clients.

Verification profile values and attachments should not be sent to AI providers;
the classifier works on broker email text.

## PR and Merge Queue Workflow

Keep changes focused and commit with a Conventional Commit prefix. For
documentation-only work, use `docs:`.

Before opening or submitting work, run the checks that match your change:

```bash
terraform -chdir=infra validate
uv run pytest tests/ -v
uv run ruff check .
npm --prefix web run build
```

Open a pull request or submit through the repository's merge queue process.
Local branches are not considered landed until they are on `main` or accepted
by the queue. Do not merge your own PR unless the repository maintainers
explicitly ask you to.

## Checkpoint

I can make a change and get it merged.
