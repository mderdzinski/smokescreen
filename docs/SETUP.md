# Smokescreen Setup

This guide covers the one-time Google Cloud project bootstrap for a personal
Smokescreen deployment. It is mostly browser and console work. After this setup,
the project has billing, APIs, OAuth app credentials, Artifact Registry, and a
budget guardrail in place.

For repeatable application deployment, see [DEPLOY.md](DEPLOY.md). For local
development, CI, and publishing Docker images from a fork, see
[DEVELOPMENT.md](DEVELOPMENT.md).

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

Install and verify these tools before starting:

- A Google Cloud account with billing access.
- A billing account linked or ready to link to the Smokescreen project.
- `gcloud` CLI authenticated with permission to create projects, enable APIs,
  create IAM resources, and manage billing for the project.
- Docker Desktop or another Docker engine that can push Docker images.
- Optional: an Anthropic API key, only if you plan to deploy Terraform with
  `ai_provider=anthropic`. The default Gemini deployment uses Vertex AI and does
  not require an Anthropic key.

Set local shell variables for the placeholders used below:

```bash
export PROJECT_ID="YOUR_PROJECT_ID"
export REGION="YOUR_REGION"
export BILLING_ACCOUNT_ID="YOUR_BILLING_ACCOUNT_ID"
export DEPLOYER_EMAIL="YOUR_EMAIL"
export ARTIFACT_REPO="smokescreen"
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
Artifact Registry, Gmail OAuth, IAP, Vertex AI Gemini, and Cloud Resource
Manager. Cloud Resource Manager is required for project-scoped IAM
operations such as `gcloud iap web get-iam-policy` during deploy
verification.

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
  gmail.googleapis.com \
  cloudresourcemanager.googleapis.com
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

If you want your fork's GitHub Actions to publish your own Docker images to
your Artifact Registry repository, see
[DEVELOPMENT.md#setting-up-ci-for-a-fork](DEVELOPMENT.md#setting-up-ci-for-a-fork).

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
   root when you are ready to deploy.

Do not commit `credentials.json` or `token.json`.

## Configure IAP OAuth Branding for the Dashboard

The Smokescreen dashboard sits behind Identity-Aware Proxy (IAP), which
requires its own OAuth 2.0 client — separate from the Gmail OAuth client
created above. The two clients play different roles:

- **Gmail OAuth client** authorizes Smokescreen to send and read mail on
  `YOUR_EMAIL`'s behalf. It is a Desktop-app client with Gmail scopes.
- **IAP OAuth client** lets Google authenticate people visiting the dashboard
  URL before IAP allows them through to Cloud Run. It is a Web-application
  client with no Gmail scopes.

The OAuth consent screen you configured earlier is shared between both
clients, but the OAuth Client IDs are distinct. If IAP is not configured, the
dashboard URL returns an error like `Empty Google Account OAuth client
ID(s)/secret(s)` at sign-in.

This step happens **after `terraform apply`** — IAP is not enabled on the
Cloud Run service until Terraform provisions it — and **before opening the
dashboard URL** for the first time. Come back to this section from
[docs/DEPLOY.md](DEPLOY.md) when the deploy tells you to.

### Preferred: first-access branding prompt

The Cloud Console typically offers a guided IAP branding flow the first time
you touch IAP in a project:

1. Open the IAP console for your project:
   `https://console.cloud.google.com/security/iap?project=YOUR_PROJECT_ID`.
2. If prompted with **"Configure consent screen"** or **"OAuth branding"**,
   click **Configure Consent Screen** or **Configure**.
3. Enter these values:
   - **Application name**: `Smokescreen Dashboard`
   - **Support email**: `YOUR_EMAIL`
   - **Developer contact email**: `YOUR_EMAIL`
4. Save. Google creates and wires up the IAP OAuth Client ID automatically.
5. Back on the IAP page, locate the `smokescreen-dashboard` Cloud Run
   service. The IAP toggle should already be **ON** (Terraform enabled it);
   confirm the row shows a green check or "OK" status once branding is
   configured.

### Fallback: manual OAuth client creation

If the guided prompt does not appear (for example, IAP branding already
exists but no client is bound), create the client manually:

1. Open **APIs & Services > Credentials** for `YOUR_PROJECT_ID`.
2. Click **Create Credentials > OAuth client ID**.
3. Set **Application type** to **Web application**.
4. Set **Name** to `Smokescreen IAP`.
5. Under **Authorized redirect URIs**, add
   `https://iap.googleapis.com/v1/oauth/clientIds/CLIENT_ID:handleRedirect`.
   The Console pre-fills this pattern for IAP clients; if it does not,
   create the client first, copy the generated **Client ID**, and paste it
   back into the redirect URI.
6. Save the client.
7. Open the IAP console:
   `https://console.cloud.google.com/security/iap?project=YOUR_PROJECT_ID`.
8. Find the `smokescreen-dashboard` service, open its overflow menu, and
   choose **Use existing client**. Paste the Client ID and Client Secret
   from the credential you just created.

Either path leaves you with an IAP-protected dashboard. The
`dashboard_allowed_user` variable that Terraform applies still controls
**which** Google account is allowed through IAP; this section only
establishes **how** IAP authenticates users at all.

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

## Checkpoint

I have a GCP project configured and could push Docker images to Artifact Registry.
