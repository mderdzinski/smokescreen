# Smokescreen Deployment Setup

This guide covers the one-time setup for deploying Smokescreen as a personal
cloud tool in a dedicated Google Cloud project. It is intended for someone who
forks or clones this repository and wants to run their own instance.

## Single-User Scope

Smokescreen currently deploys as a single-user personal tool. The deployed
dashboard is protected by Identity-Aware Proxy (IAP), and the Terraform
configuration grants dashboard access to one Google account through
`dashboard_allowed_user`. The Gmail OAuth token is also for one mailbox: the
same Gmail account that sends opt-out requests and receives broker replies.

Multi-tenant support is not currently in scope. Supporting multiple users would
require substantial additional work, including per-user authentication,
per-user Gmail connections, tenant-aware storage, separate secret handling, and
authorization checks throughout the dashboard and API.

## Prerequisites

Install and verify these tools before starting:

- A Google Cloud account with billing access.
- A billing account linked or ready to link to the Smokescreen project.
- `gcloud` CLI authenticated with permission to create projects, enable APIs,
  create IAM resources, and manage billing for the project.
- Docker Desktop or another Docker engine that can build Linux images.
- Node.js and npm for the React dashboard build.
- `uv` for Python dependency management.
- Terraform `>= 1.5`.
- A GitHub fork or repository where GitHub Actions will publish your image.
- GitHub CLI (`gh`) if you want to set repository variables from the shell.

Set local shell variables for the placeholders used below:

```bash
export PROJECT_ID="YOUR_PROJECT_ID"
export REGION="YOUR_REGION"
export BILLING_ACCOUNT_ID="YOUR_BILLING_ACCOUNT_ID"
export DEPLOYER_EMAIL="YOUR_EMAIL"
export DEPLOYER_NAME="YOUR_LEGAL_NAME"
export GITHUB_REPO="YOUR_GITHUB_OWNER/YOUR_REPO"
export ARTIFACT_REPO="smokescreen"
export IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPO}/smokescreen:latest"
```

`YOUR_REGION` can be a region such as `us-central1`. Use the same region for
Artifact Registry, Cloud Run, Cloud Scheduler, and Firestore unless you have a
specific reason to split them.

## Create a Dedicated GCP Project

Use a dedicated project so Smokescreen IAM, secrets, Firestore data, Scheduler
jobs, and budget alerts are isolated from other workloads.

```bash
gcloud projects create "$PROJECT_ID" --name="Smokescreen"
gcloud beta billing projects link "$PROJECT_ID" \
  --billing-account="$BILLING_ACCOUNT_ID"
```

If the project already exists, confirm billing is linked:

```bash
gcloud beta billing projects describe "$PROJECT_ID"
```

## Isolate gcloud Configuration

Create a named `gcloud` configuration so Smokescreen does not clobber your
default Google Cloud project, account, or region.

```bash
gcloud config configurations create smokescreen
gcloud config configurations activate smokescreen
gcloud auth login
gcloud auth application-default login
gcloud config set project "$PROJECT_ID"
gcloud config set run/region "$REGION"
gcloud config set artifacts/location "$REGION"
```

Use `gcloud config configurations activate smokescreen` before running later
commands from a new shell.

## Enable Required APIs

Enable the APIs used by Terraform, Cloud Run, Scheduler, Secret Manager,
Artifact Registry, Gmail OAuth, IAP, and the forward-compatible Vertex AI path.

```bash
gcloud services enable \
  artifactregistry.googleapis.com \
  run.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  iap.googleapis.com \
  firestore.googleapis.com \
  secretmanager.googleapis.com \
  cloudscheduler.googleapis.com \
  aiplatform.googleapis.com \
  gmail.googleapis.com
```

## Create the Artifact Registry Repository

Create one Docker repository for Smokescreen images:

```bash
gcloud artifacts repositories create "$ARTIFACT_REPO" \
  --repository-format=docker \
  --location="$REGION" \
  --description="Smokescreen container images"

gcloud auth configure-docker "${REGION}-docker.pkg.dev"
```

Build and push the first image manually so Terraform can deploy it:

```bash
docker build -t "$IMAGE" .
docker push "$IMAGE"
```

Later releases can publish images from GitHub Actions after Workload Identity
Federation is configured.

## Configure GitHub Actions Workload Identity Federation

The Docker publish workflow uses the Workload Identity Federation pattern in
[`docker-publish.yml`](../.github/workflows/docker-publish.yml): GitHub Actions
requests an OIDC token, exchanges it for a Google access token with
`google-github-actions/auth`, logs in to Artifact Registry, and pushes the
release image.

Create a service account for GitHub Actions:

```bash
export PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" \
  --format="value(projectNumber)")"
export WIF_POOL_ID="github"
export WIF_PROVIDER_ID="github"
export GITHUB_ACTIONS_SA_NAME="smokescreen-github-actions"
export GITHUB_ACTIONS_SA_EMAIL="${GITHUB_ACTIONS_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

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

If your fork changes the Artifact Registry project, region, or repository name,
make sure the workflow image target points at your `YOUR_PROJECT_ID` image path.

## Create OAuth Consent and Gmail Client Credentials

Create the Gmail OAuth app in the Google Cloud Console:

1. Open **APIs & Services > OAuth consent screen** for `YOUR_PROJECT_ID`.
2. Choose the user type that matches your Google account. For a personal Gmail
   account, this is usually **External**.
3. Add app contact information and add `YOUR_EMAIL` as a test user if the app
   remains in testing mode.
4. Add the Gmail scopes used by Smokescreen:
   `https://www.googleapis.com/auth/gmail.send` and
   `https://www.googleapis.com/auth/gmail.readonly`.
5. Open **APIs & Services > Credentials**.
6. Create an OAuth client ID with application type **Desktop app**.
7. Download the client JSON and save it as `credentials.json` in the repository
   root.

Do not commit `credentials.json` or `token.json`.

## Run the Local OAuth Flow

Install dependencies, then generate `token.json` from the desktop OAuth client:

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
  Manager, and IAP.

Run the first plan and apply from the `infra/` directory:

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

## Populate Secret Manager

Terraform creates the secret containers, but the secret payloads are added
manually so they do not enter Terraform state.

From the repository root, not `infra/`, add the Gmail OAuth client credentials,
authorized user token, and Anthropic API key:

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
| `smokescreen-anthropic-key` | Anthropic API key text used by the current classifier and composer. |

Restart or redeploy Cloud Run services after adding new secret versions if a
running revision does not pick them up automatically.

## AI Provider Note

The current runtime and Terraform configuration use Anthropic through
`SMOKESCREEN_ANTHROPIC_API_KEY`, stored in the
`smokescreen-anthropic-key` secret.

The setup also enables `aiplatform.googleapis.com` so a future Gemini/Vertex AI
provider can use GCP-native Application Default Credentials from the Cloud Run
service accounts. If that provider exists in your branch, grant the relevant
Cloud Run service accounts Vertex AI permissions such as `roles/aiplatform.user`
and follow that provider's configuration. Do not create Gemini-specific secrets
for the current Anthropic-only code path.

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

## Verify Scheduled Jobs

After secrets are populated, force one poll job execution:

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

## Set a Billing Budget Alert

Set a small budget before leaving the deployment unattended:

1. Open **Billing > Budgets & alerts** in the Google Cloud Console.
2. Create a budget scoped to `YOUR_PROJECT_ID`.
3. Set the monthly amount to `$5`.
4. Add alert thresholds at `50%` and `100%` of actual spend.
5. Send alerts to `YOUR_EMAIL` or a monitored billing email.

Smokescreen is designed to run cheaply with scale-to-zero Cloud Run services,
short Cloud Run jobs, and small Firestore usage, but budget alerts are the
guardrail for mistakes, retries, or unexpected traffic.

## Local Validation

Before submitting deployment changes from your fork, run the same checks used by
this repository:

```bash
terraform -chdir=infra validate
uv run pytest tests/ -v
uv run ruff check .
npm --prefix web run build
```
