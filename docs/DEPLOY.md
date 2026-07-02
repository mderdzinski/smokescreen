# Smokescreen Deploy

This guide covers repeatable deployment of Smokescreen into a Google Cloud
project that has already completed [SETUP.md](SETUP.md). It assumes the project,
billing, APIs, OAuth consent screen, OAuth client, Artifact Registry, and budget
alert already exist.

## Single-User Scope

Smokescreen currently deploys as a single-user personal tool. The deployed
dashboard is protected by Identity-Aware Proxy (IAP), and Terraform grants
dashboard access to one Google account through `dashboard_allowed_user`. The
Gmail OAuth token is also for one mailbox: the same Gmail account that sends
opt-out requests and receives broker replies.

Multi-tenant support is not currently in scope. Supporting multiple users would
require substantial additional work, including per-user authentication,
per-user Gmail connections, tenant-aware storage, separate secret handling, and
authorization checks throughout the dashboard and API.

## Prerequisites

Install and verify these tools before deploying:

- `gcloud` CLI using the named Smokescreen configuration from
  [SETUP.md](SETUP.md).
- Docker Desktop or another Docker engine if you are building your own image.
- `uv` for the one-time local Gmail OAuth token flow.
- Terraform `>= 1.5`.
- A Smokescreen image URI that Cloud Run can pull.

Set local shell variables for the placeholders used below:

```bash
export PROJECT_ID="YOUR_PROJECT_ID"
export REGION="YOUR_REGION"
export DEPLOYER_EMAIL="YOUR_EMAIL"
export DEPLOYER_NAME="YOUR_LEGAL_NAME"
export ARTIFACT_REPO="smokescreen"
export IMAGE_TAG="YOUR_IMAGE_TAG"
export IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPO}/smokescreen:${IMAGE_TAG}"
```

Use `gcloud config configurations activate smokescreen` before running the
commands from a new shell.

## Choose an Image Tag

Deploy a specific immutable image tag whenever possible. Use `latest` only for
local experiments or disposable deployments.

If you are building your own image, build and push it before running Terraform:

```bash
docker build -t "$IMAGE" .
docker push "$IMAGE"
```

If you are using an image published elsewhere, set `IMAGE` to the full image URI
that your Cloud Run services can pull.

## Run the Local OAuth Flow

Cloud Run jobs run non-interactively, so they use Secret Manager-backed JSON
environment variables instead of opening the installed-app browser flow. Create
`token.json` locally once from the desktop OAuth client downloaded during setup.

```bash
uv sync

uv run python - <<'PY'
from smokescreen.config import get_settings
from smokescreen.email.oauth import get_credentials

settings = get_settings()
get_credentials(settings.gmail_credentials_path, settings.gmail_token_path)
print(f"Wrote {settings.gmail_token_path}")
PY
```

The command opens a browser and asks `YOUR_EMAIL` to grant Gmail access. The
resulting `token.json` must contain a `refresh_token`; Cloud Run jobs cannot
complete an interactive OAuth flow.

If Google does not return a refresh token, revoke the app grant from the Google
account security page, delete `token.json`, and run the local OAuth flow again.

## Run Terraform

Terraform provisions:

- Cloud Run dashboard service behind IAP.
- Cloud Run jobs for polling and outreach.
- Cloud Scheduler jobs for scheduled polling and outreach.
- Firestore in native mode for deployed state storage.
- Secret Manager secret containers.
- Service accounts and IAM bindings for Cloud Run, Scheduler, Firestore, Secret
  Manager, Vertex AI, and IAP.

Anthropic is the default reply classifier provider. It requires an Anthropic API
key and stores that key in Secret Manager.

```bash
cd infra
terraform init
terraform plan \
  -var="project_id=${PROJECT_ID}" \
  -var="region=${REGION}" \
  -var="sender_email=${DEPLOYER_EMAIL}" \
  -var="sender_name=${DEPLOYER_NAME}" \
  -var="dashboard_allowed_user=${DEPLOYER_EMAIL}" \
  -var="image=${IMAGE}"

terraform apply \
  -var="project_id=${PROJECT_ID}" \
  -var="region=${REGION}" \
  -var="sender_email=${DEPLOYER_EMAIL}" \
  -var="sender_name=${DEPLOYER_NAME}" \
  -var="dashboard_allowed_user=${DEPLOYER_EMAIL}" \
  -var="image=${IMAGE}"
```

Always pass `dashboard_allowed_user` for your own deployment. That value is the
single Google account allowed through IAP.

To deploy with Vertex AI Gemini instead of Anthropic, add these variables to
both `terraform plan` and `terraform apply`:

```bash
  -var="ai_provider=gemini" \
  -var="gemini_model=gemini-3.1-flash-lite" \
  -var="gemini_location=global"
```

## Populate Secret Manager

Terraform creates the secret containers, but the secret payloads are added
manually so they do not enter Terraform state.

From the repository root, not `infra/`, add the Gmail OAuth client credentials,
authorized user token, and Anthropic API key for the default Anthropic provider:

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
| --- | --- |
| `smokescreen-gmail-credentials` | OAuth client JSON downloaded from Google Cloud Console. |
| `smokescreen-gmail-token` | Authorized-user token JSON from the local OAuth flow. Must include a `refresh_token`. |
| `smokescreen-anthropic-key` | Anthropic API key text. Required only when `ai_provider=anthropic`. |

Gemini uses Vertex AI through Application Default Credentials and does not
require a Gemini API key or Gemini-specific secret.

Restart or redeploy Cloud Run services after adding new secret versions if a
running revision does not pick them up automatically.

## AI Provider Notes

Anthropic preserves the original behavior and is the Terraform default. It uses
`SMOKESCREEN_ANTHROPIC_API_KEY`, stored in the `smokescreen-anthropic-key`
secret, and requires a separate Anthropic account and API key.

Gemini uses Vertex AI through the Google Gen AI SDK and Application Default
Credentials. Terraform sets `SMOKESCREEN_AI_PROVIDER=gemini`,
`SMOKESCREEN_GEMINI_MODEL`, `SMOKESCREEN_GEMINI_PROJECT`, and
`SMOKESCREEN_GEMINI_LOCATION` on the Cloud Run resources when configured with
the variables above. It also grants `roles/aiplatform.user` to the poll/outreach
service account and the dashboard service account. Do not create a Gemini API
key or Gemini-specific secret.

The default Gemini model is `gemini-3.1-flash-lite`. Google Cloud's
[Gemini 3.1 Flash-Lite model page](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-1-flash-lite)
lists `gemini-3.1-flash-lite` as the GA model ID, and the
[Provisioned Throughput supported-models page](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/provisioned-throughput/supported-models)
lists it as the latest supported version for Gemini 3.1 Flash-Lite.

## Verify IAP Dashboard Access

Find the dashboard URL:

```bash
gcloud run services describe smokescreen-dashboard \
  --region="$REGION" \
  --format="value(status.url)"
```

Open the URL in a browser while signed in as `YOUR_EMAIL`. You should pass
through IAP and see the Smokescreen dashboard. A different Google account should
be denied unless you explicitly change `dashboard_allowed_user` and re-apply
Terraform.

## Verify Scheduled Polling

Check the configured polling schedule:

```bash
gcloud scheduler jobs describe smokescreen-poll-schedule \
  --location="$REGION" \
  --format="value(schedule,httpTarget.uri,httpTarget.oauthToken.serviceAccountEmail)"
```

Force one poll job execution after secrets are populated:

```bash
gcloud scheduler jobs run smokescreen-poll-schedule --location="$REGION"

gcloud run jobs executions list \
  --job=smokescreen-poll \
  --region="$REGION" \
  --limit=1
```

Repeat for outreach when you are ready to send opt-out emails:

```bash
gcloud scheduler jobs run smokescreen-outreach-schedule --location="$REGION"

gcloud run jobs executions list \
  --job=smokescreen-outreach \
  --region="$REGION" \
  --limit=1
```

If a job execution starts and then fails inside the container, the Scheduler to
Cloud Run invocation path is working. Check Cloud Run job logs and Secret
Manager payloads next.

## Update or Roll Back an Image

To update to a new release, set `IMAGE_TAG` and `IMAGE` to the new image, then
rerun `terraform plan` and `terraform apply` with the same variables used for
the original deployment.

```bash
export IMAGE_TAG="YOUR_NEW_IMAGE_TAG"
export IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPO}/smokescreen:${IMAGE_TAG}"
```

To roll back, set `IMAGE_TAG` and `IMAGE` to the last known-good image tag and
apply Terraform again. Cloud Run will create a new revision pointing at that
older image.

## Checkpoint

smokescreen is running in my GCP project and I can access the dashboard.
