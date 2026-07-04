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
Manager. Cloud Resource Manager is required for project-scoped IAM operations
such as `gcloud iap web get-iam-policy` during deploy verification. Cloud
Storage is required for the Terraform state bucket.

```bash
gcloud services enable \
  artifactregistry.googleapis.com \
  run.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  iap.googleapis.com \
  firestore.googleapis.com \
  secretmanager.googleapis.com \
  storage.googleapis.com \
  cloudscheduler.googleapis.com \
  aiplatform.googleapis.com \
  gmail.googleapis.com \
  cloudresourcemanager.googleapis.com
```

Firestore composite indexes are Terraform-managed in `infra/main.tf`, not
created permanently by hand in the Console. Use the Console only for
exploration or emergency unblock, then import the resulting index into
Terraform state if you created it manually, or let Terraform create it on the
next apply when no index exists yet.

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
   `https://www.googleapis.com/auth/gmail.modify`.
5. Open **APIs & Services > Credentials**.
6. Create an OAuth client ID with application type **Desktop app**.
7. Download the client JSON and save it as `credentials.json` in the repository
   root when you are ready to deploy.

Do not commit `credentials.json` or `token.json`.

## Configure IAP OAuth Branding for the Dashboard

The Smokescreen dashboard sits behind Identity-Aware Proxy (IAP), which
requires its own OAuth 2.0 client — separate from the Gmail OAuth client
(`smokescreen-cli`) created above. The two clients play different roles:

- **Gmail OAuth client (`smokescreen-cli`)** authorizes Smokescreen to send
  and read mail on `YOUR_EMAIL`'s behalf. It is a Desktop-app client with
  Gmail scopes.
- **IAP OAuth client** authenticates users at the dashboard front door
  before IAP allows them through to Cloud Run. It is a Web-application
  client with no Gmail scopes.

The OAuth consent screen you configured earlier is shared between both
clients, but the OAuth Client IDs are distinct. If IAP is not configured, the
dashboard URL returns an error like `Empty Google Account OAuth client
ID(s)/secret(s)` at sign-in.

This step happens **after `terraform apply`** — IAP is not enabled on the
Cloud Run service until Terraform provisions it — and **before opening the
dashboard URL** for the first time. Come back to this section from
[docs/DEPLOY.md](DEPLOY.md) when the deploy tells you to.

### Choose Custom OAuth for personal projects

IAP offers two OAuth modes, and only one works for personal Smokescreen
deployments:

- **Google-managed OAuth** requires the project to live inside a Google
  Cloud **Organization** and restricts access to users of that organization.
  It is **not suitable for personal projects**.
- **Custom OAuth** works without an organization and allows any Google
  account on the IAM allowlist (the account you passed as
  `dashboard_allowed_user`). This is the correct choice for personal
  Smokescreen deployments.

Reference:
[Enabling IAP for external identities: custom OAuth configuration](https://cloud.google.com/iap/docs/custom-oauth-configuration).

### Console flow: set Custom OAuth on the dashboard service

1. Open the IAP console for your project:
   `https://console.cloud.google.com/security/iap?project=YOUR_PROJECT_ID`.
2. Ensure the **Applications** tab is selected.
3. Find the row for `smokescreen-dashboard`.
4. Click the **⋮** (three-dot **More Options**) icon on the right of the
   row.
5. Click **Settings**.
6. In the **Settings** panel, locate the **OAuth** section.
7. Select the **Custom OAuth** radio option. **Do not** select
   Google-managed for personal projects.
8. Click **Auto Generate Credentials**. GCP creates a Web-application OAuth
   Client behind the scenes with the correct redirect URI wired
   automatically — you do not need to build the redirect URI by hand.
9. Click **Download credentials** to save the JSON file. It contains the
   Client ID and Client Secret. Keep it safe (it authenticates dashboard
   users), but Smokescreen does not need it for any further deployment
   step after saving this IAP configuration.
10. Click **Save**.
11. Wait about **30 seconds** for the configuration to propagate.
12. Open the dashboard URL in a fresh **incognito / private** window to
    verify. Sign in with the Google account on the `dashboard_allowed_user`
    allowlist.

The `dashboard_allowed_user` variable that Terraform applies still controls
**which** Google account is allowed through IAP; this section only
establishes **how** IAP authenticates users at all.

> Do not use deprecated `gcloud iap oauth-brands` or `gcloud iap
> oauth-clients` commands to configure IAP branding for personal projects.
> The Console UI flow above is the supported path.

## Set up automated deployment

Once the release pipeline is landed on this repo, merges to `main` cut a
semantic-release tag, build and push a Docker image to Artifact Registry,
and then run `terraform apply` against your GCP project to roll out the new
image. Getting that pipeline working requires three one-time setup steps
below, all done from your local shell against your GCP project.

The pipeline assumes a Workload Identity Federation (WIF) provider and
service account already exist for GitHub Actions — you should already have
these if `docker-publish.yml` is publishing images. The variables
`vars.WIF_PROVIDER` and `vars.WIF_SERVICE_ACCOUNT` in the repository's
Actions configuration reference them.

### Create the Terraform state bucket

Terraform state must live in GCS so both local operators and CI apply
against the same state. The bucket is created manually, not by Terraform,
to avoid a chicken-and-egg with the backend it configures.

Bucket names are globally unique across all of GCS. Pick something distinctive
for your project, then pass it to Terraform at init time with
`terraform init -backend-config="bucket=YOUR_BUCKET_NAME"`.

```bash
# Bucket names are globally unique in GCS; pick something distinctive for your project.
export TFSTATE_BUCKET="YOUR_PROJECT_ID-tfstate"

gcloud storage buckets create "gs://${TFSTATE_BUCKET}" \
  --project="${PROJECT_ID}" \
  --location="${REGION}" \
  --default-storage-class=STANDARD \
  --uniform-bucket-level-access

gcloud storage buckets update "gs://${TFSTATE_BUCKET}" \
  --versioning
```

Object versioning is what lets you recover from a bad `terraform apply`
that corrupts state. Uniform bucket-level access is required so IAM on
the bucket controls object access (Terraform's default assumption).

### Grant deploy roles to the CI service account

The CI service account already has WIF access and Artifact Registry writer
access from the image-publish step. It now also needs enough IAM to run
`terraform apply` against the smokescreen resource set. Grant only what
`infra/main.tf` actually manages:

Use the same CI service account that the Workload Identity Federation setup
uses today:

```bash
export CI_SA="YOUR_CI_SERVICE_ACCOUNT_EMAIL"

for role in \
  roles/run.admin \
  roles/iam.serviceAccountUser \
  roles/iam.serviceAccountAdmin \
  roles/resourcemanager.projectIamAdmin \
  roles/secretmanager.admin \
  roles/storage.admin \
  roles/cloudscheduler.admin \
  roles/datastore.owner \
  roles/iap.admin
do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${CI_SA}" \
    --role="${role}"
done
```

Grant Terraform state bucket access only on the bucket, not project-wide:

```bash
gcloud storage buckets add-iam-policy-binding "gs://${TFSTATE_BUCKET}" \
  --member="serviceAccount:${CI_SA}" \
  --role="roles/storage.objectAdmin"
```

Why each role, briefly:

- `run.admin` — create/update Cloud Run services and jobs.
- `iam.serviceAccountUser` — impersonate the smokescreen runtime service
  accounts when wiring `--service-account` on Cloud Run and Scheduler.
- `iam.serviceAccountAdmin` — create the runtime service accounts.
- `resourcemanager.projectIamAdmin` — grant project-level roles to the
  runtime service accounts (Firestore, Vertex AI, Secret Manager
  accessor).
- `secretmanager.admin` — create the Secret Manager secret containers.
- `storage.admin` — create and manage Terraform-owned GCS buckets when needed
  for deploy support. The current app no longer creates an identity-document
  bucket; keep Terraform state access bucket-scoped when possible.
- `cloudscheduler.admin` — create the poll and outreach schedules.
- `datastore.owner` — create and manage the Firestore database.
- `iap.admin` — read and write IAP IAM bindings on the dashboard service.
  Terraform's `google_iap_web_cloud_run_service_iam_member` resource calls
  `iap.web*.getIamPolicy` and `iap.web*.setIamPolicy`, which
  `roles/iap.settingsAdmin` does **not** grant (that role manages IAP
  configuration/settings, not IAM policies). Google's
  [IAP roles reference](https://cloud.google.com/iam/docs/roles-permissions/iap)
  lists those IAM policy permissions on `roles/iap.admin`, not on
  `roles/iap.settingsAdmin`. Using the settings role fails on first
  `terraform apply` with `Error 403: The caller does not have permission`
  on the dashboard IAP IAM binding.
- `storage.objectAdmin` on the tfstate bucket — read and write state; do
  not grant this project-wide. This bucket-scoped role only covers objects
  inside the manually created Terraform state bucket; it cannot create new
  buckets or manage Terraform-created bucket IAM.

> **Existing deployers with old identity-document buckets.** Current Terraform
> removes `google_storage_bucket.identity_documents`. If a prior deployment
> created that bucket, empty it before applying this release so Terraform can
> destroy it and its IAM bindings cleanly.

> **Migrating from an earlier version of these docs.** If you previously
> granted `roles/iap.settingsAdmin`, add `roles/iap.admin` on top —
> `terraform apply` will start succeeding on the IAP binding. You can
> also revoke `roles/iap.settingsAdmin` afterwards. It grants settings
> update permissions, but the current `infra/main.tf` manages only IAP IAM
> bindings, so `roles/iap.admin` is the role the release workflow needs.

> **Future Terraform-managed resources.** New Terraform changes that add GCS
> buckets, Cloud Run services, Firestore resources, or similar new resource
> types may require additional CI service account roles. When `terraform apply`
> fails with permission denied, inspect the missing permission in the error,
> grant the narrow role needed for that resource type, and rerun the deploy.

### Set GitHub Actions repository variables

The deploy job reads non-sensitive configuration from **repository variables**
(Settings → Secrets and variables → Actions → Variables). Do not put these
in Secrets — they are not confidential and repository variables are the
correct GitHub surface for them.

The release workflow validates required variables before authenticating to
Google Cloud, publishing an image, or running Terraform. If any required value
is missing or blank, the workflow fails fast with a message naming the missing
variables instead of passing empty project, backend, or dashboard allowlist
values into the deploy.

`ARTIFACT_REPO_NAME` and `ARTIFACT_IMAGE_NAME` are optional. If either
repository variable is unset or blank, the release workflow defaults that value
to `smokescreen`, producing the standard
`us-central1-docker.pkg.dev/YOUR_PROJECT_ID/smokescreen/smokescreen:vX.Y.Z`
image path.

| Variable | Example | Description |
| --- | --- | --- |
| `WIF_PROVIDER` | `projects/123/locations/global/workloadIdentityPools/gh/providers/github` | Already set for the docker-publish workflow. Deploy reuses it. |
| `WIF_SERVICE_ACCOUNT` | `smokescreen-ci@YOUR_PROJECT_ID.iam.gserviceaccount.com` | Already set for docker-publish. Deploy reuses it. |
| `GCP_PROJECT_ID` | `YOUR_PROJECT_ID` | Target project for image publishing and `terraform apply`. |
| `GCP_REGION` | `us-central1` | Terraform region. |
| `ARTIFACT_REPO_NAME` | `smokescreen` | Optional Artifact Registry repository name. Defaults to `smokescreen` when unset or blank. |
| `ARTIFACT_IMAGE_NAME` | `smokescreen` | Optional Artifact Registry image name. Defaults to `smokescreen` when unset or blank. |
| `TFSTATE_BUCKET` | `YOUR_PROJECT_ID-tfstate` | GCS bucket used by Terraform's remote backend. Must match the bucket you created above. |
| `DASHBOARD_ALLOWED_USER` | `you@example.com` | Google account authorized to access the IAP-protected dashboard. |
| `SMOKESCREEN_SENDER_EMAIL` | `you@example.com` | Value passed as `sender_email`. |
| `SMOKESCREEN_SENDER_NAME` | `Your Legal Name` | Value passed as `sender_name`. |

Sensitive values (Anthropic API key, Gmail credentials JSON, Gmail token
JSON) never appear in the GitHub Actions environment. They live in Secret
Manager only, populated by the operator as documented in
[docs/DEPLOY.md](DEPLOY.md#phase-2--populate-secret-payloads).

### Migrate an existing local Terraform state

If you had been running `terraform apply` locally without a backend, migrate
your local state into the new bucket once:

The first command refreshes Application Default Credentials used by the GCS
backend:

```bash
gcloud auth application-default login
cd infra
terraform init -migrate-state -backend-config="bucket=${TFSTATE_BUCKET}"
```

Terraform detects the new backend block, prompts you to copy the local
`terraform.tfstate` into GCS, and confirms once complete. Subsequent
applies (local or CI) use the same remote state.

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
