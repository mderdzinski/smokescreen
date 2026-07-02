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
Artifact Registry, Gmail OAuth, IAP, and Vertex AI Gemini.

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
