# Smokescreen Deploy

This guide covers repeatable deployment of Smokescreen into a Google Cloud
project that has already completed [SETUP.md](SETUP.md). It assumes the project,
billing, APIs, OAuth consent screen, OAuth client, Artifact Registry, and budget
alert already exist.

## Release Pipeline (default path)

Normal deployments after the first one are automatic:

1. A conventional-commit merge to `main` triggers `release.yml`. Semantic-release
   analyzes commits and, when appropriate, cuts a new `vX.Y.Z` git tag.
2. The `publish-release-image` job builds and pushes
   `us-central1-docker.pkg.dev/smokescreen-app/smokescreen/smokescreen:vX.Y.Z`
   to Artifact Registry using Workload Identity Federation.
3. The `deploy` job runs `terraform apply -auto-approve` against the shared GCS
   backend state, wiring the new image tag into Cloud Run and Scheduler.

No manual `terraform apply` is required for image upgrades. See
[SETUP.md](SETUP.md#set-up-automated-deployment) for the one-time GCS bucket,
CI IAM, and GitHub Actions variable setup required to make this work.

The manual sequence below is still needed for two cases:

- **First deploy** into a fresh project — the three-phase apply is required
  because Secret Manager containers must exist before their payloads can be
  populated, and Cloud Run validates secret access at revision creation.
- **Break-glass** — when the release workflow is broken and you need to push
  a fix without waiting for CI, when debugging Terraform state, or when
  reproducing a drift the pipeline flagged.

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

Install dependencies and trigger the flow with the Smokescreen CLI. The `poll`
command initializes the Gmail client, which reliably opens the browser OAuth
flow the first time it runs:

```bash
uv sync

uv run smokescreen poll
```

> **Do not use `uv run smokescreen --dry-run outreach` (or any other
> `--dry-run` command) to trigger OAuth.** Dry-run short-circuits before
> Gmail client initialization, so it never opens the browser flow and never
> writes `token.json`. Use `uv run smokescreen poll` instead.

The browser opens and asks `YOUR_EMAIL` to grant Gmail access. If the OAuth
consent screen is still in External **testing** mode with test users, Google
shows an "unverified app" warning. Click **Advanced**, then
**Go to Smokescreen (unsafe)** to continue. This warning goes away once the
consent screen is published, but is expected during personal-project setup.

After the browser flow completes, Smokescreen writes `token.json` next to
`credentials.json` in the repository root. The resulting `token.json` must
contain a `refresh_token`; Cloud Run jobs cannot complete an interactive OAuth
flow. Verify:

```bash
python3 -c "import json; d=json.load(open('token.json')); print('has refresh_token:', 'refresh_token' in d)"
```

Expected output includes `True`. If it prints `False`, revoke the app grant at
`https://myaccount.google.com/permissions`, delete `token.json`, and re-run
`uv run smokescreen poll` to redo the flow.

## Run Terraform

Terraform provisions:

- Cloud Run dashboard service behind IAP.
- Cloud Run jobs for polling and outreach.
- Cloud Scheduler jobs for scheduled polling and outreach.
- Firestore in native mode for deployed state storage and Terraform-managed
  composite indexes.
- Secret Manager secret containers.
- Service accounts and IAM bindings for Cloud Run, Scheduler, Firestore, Secret
  Manager, Vertex AI, and IAP.

Gemini is the default reply classifier provider. It uses Vertex AI through the
Cloud Run service accounts and does not require a separate AI API key or
provider-specific Secret Manager secret.

Firestore composite indexes belong in Terraform, not the Console. If a
production index was created manually to unblock a deploy, import the
server-generated index name into state rather than recreating it by hand:

```bash
INDEX_NAME="$(gcloud firestore indexes composite list \
  --database="(default)" \
  --filter="COLLECTION_GROUP:opt_outs_pending_whitelist" \
  --format="value(name)" | head -n1)"

terraform import google_firestore_index.pending_whitelist_status_detected_at \
  "$INDEX_NAME"
```

Manual Console creation is acceptable for exploration or break-glass use, but
permanent production indexes should live in `infra/main.tf`.

### First-Deploy Sequence

The first deploy into a fresh project runs as three phases: apply the secret
containers, populate the secret payloads with `gcloud`, then apply everything
else. Cloud Run eagerly validates referenced secret versions (`versions/latest`)
and secret-accessor IAM at revision creation time, so it cannot create a working
revision until the payload exists. Secret versions in turn can only be added
with `gcloud` after Terraform has created the secret container. This is the
standard Terraform + Cloud Run + Secret Manager first-deploy pattern.

Subsequent applies do not repeat Phase 1. Once the secret containers and
payloads exist, upgrading image tags or changing configuration is a normal
single `terraform apply` — see [Update or Roll Back an Image](#update-or-roll-back-an-image).

Choose the variable set that matches your provider. The default is Gemini; to
make it explicit or override the model or location, add:

```bash
  -var="ai_provider=gemini" \
  -var="gemini_model=gemini-3.1-flash-lite" \
  -var="gemini_location=global"
```

To deploy with Anthropic instead, set:

```bash
  -var="ai_provider=anthropic"
```

Always pass `dashboard_allowed_user` for your own deployment. That value is the
single Google account allowed through IAP.

Initialize Terraform once:

```bash
cd infra
terraform init
```

#### Phase 1 — Apply secret containers only

Create the Secret Manager containers first with `-target`. Terraform should
show 2 resources to add for the default Gemini deployment, or 3 when
`ai_provider=anthropic`. Review the plan, then approve.

```bash
terraform apply \
  -var="project_id=${PROJECT_ID}" \
  -var="region=${REGION}" \
  -var="sender_email=${DEPLOYER_EMAIL}" \
  -var="sender_name=${DEPLOYER_NAME}" \
  -var="dashboard_allowed_user=${DEPLOYER_EMAIL}" \
  -var="image=${IMAGE}" \
  -target=google_secret_manager_secret.gmail_credentials \
  -target=google_secret_manager_secret.gmail_token
```

If `ai_provider=anthropic`, add the Anthropic container target as well:

```bash
  -target=google_secret_manager_secret.anthropic_key
```

#### Phase 2 — Populate secret payloads

Terraform creates the secret containers, but the payloads are added manually
with `gcloud` so they do not enter Terraform state.

From the repository root, not `infra/`, add the Gmail OAuth client credentials
and the authorized user token:

```bash
gcloud secrets versions add smokescreen-gmail-credentials \
  --data-file=credentials.json

gcloud secrets versions add smokescreen-gmail-token \
  --data-file=token.json
```

If you deploy with `ai_provider=anthropic`, also populate the Anthropic key:

```bash
printf '%s' "$SMOKESCREEN_ANTHROPIC_API_KEY" | \
  gcloud secrets versions add smokescreen-anthropic-key --data-file=-
```

Secret payloads:

| Secret | Payload |
| --- | --- |
| `smokescreen-gmail-credentials` | OAuth client JSON downloaded from Google Cloud Console. |
| `smokescreen-gmail-token` | Authorized-user token JSON from the local OAuth flow. Must include a `refresh_token`. |
| `smokescreen-anthropic-key` | Anthropic API key text. Created and required only when `ai_provider=anthropic`. |

The default Gemini deployment skips `smokescreen-anthropic-key` entirely.
Gemini uses Vertex AI through Application Default Credentials and does not
require a Gemini API key or Gemini-specific secret.

#### Phase 3 — Apply everything else

With the secret payloads in place, apply the remaining resources with the same
variables and no `-target`. Terraform should show the remaining resources to
add depending on `ai_provider` — Cloud Run services and jobs, Cloud Scheduler
jobs, Firestore, service accounts, IAM bindings, and IAP. Review the plan,
then approve.

```bash
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

Restart or redeploy Cloud Run services after adding new secret versions later
if a running revision does not pick them up automatically.

#### Recovery — untaint Cloud Run resources after a partial apply

If a full `terraform apply` was attempted before the secrets were populated,
or if the first apply errored partway through, Terraform can mark the Cloud
Run resources tainted. The next `terraform apply` then tries to destroy and
recreate them and fails with:

```text
Error: cannot destroy service without setting deletion_protection=false
```

The resources actually exist and are correct on the GCP side — Terraform is
being defensive because their creation errored mid-flight. Untaint them so
Terraform trusts the existing GCP-side state, then re-run the Phase 3 apply:

```bash
terraform untaint google_cloud_run_v2_service.dashboard
terraform untaint google_cloud_run_v2_job.poll_and_reply
terraform untaint google_cloud_run_v2_job.outreach
```

Only untaint the resources Terraform actually marked tainted; extra
`untaint` calls on clean resources are harmless but noisy. Following the
[three-phase sequence](#first-deploy-sequence) from a fresh project avoids
this state entirely.

## AI Provider Notes

Gemini uses Vertex AI through the Google Gen AI SDK and Application Default
Credentials and is the Terraform default. Terraform sets
`SMOKESCREEN_AI_PROVIDER=gemini`,
`SMOKESCREEN_GEMINI_MODEL`, `SMOKESCREEN_GEMINI_PROJECT`, and
`SMOKESCREEN_GEMINI_LOCATION` on the Cloud Run resources. It also grants
`roles/aiplatform.user` to the poll/outreach service account and the dashboard
service account. Do not create a Gemini API key or Gemini-specific secret.

Anthropic remains supported when `ai_provider=anthropic`. Terraform then creates
the `smokescreen-anthropic-key` secret container, grants the dashboard service
account access to it, and injects that secret as
`SMOKESCREEN_ANTHROPIC_API_KEY` into the dashboard, poll, and outreach Cloud Run
resources. Anthropic requires a separate Anthropic account and API key.

The default Gemini model is `gemini-3.1-flash-lite`. Google Cloud's
[Gemini 3.1 Flash-Lite model page](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-1-flash-lite)
lists `gemini-3.1-flash-lite` as the GA model ID, and the
[Provisioned Throughput supported-models page](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/provisioned-throughput/supported-models)
lists it as the latest supported version for Gemini 3.1 Flash-Lite.

## Verification Profile Storage

Identity document uploads have been removed. Terraform no longer creates or
injects `SMOKESCREEN_IDENTITY_BUCKET`, and broker requests for documents now
move records to `NEEDS_MANUAL`.

The optional Verification Profile is stored in the configured state backend,
not in Terraform variables, environment variables, or Secret Manager. For
deployed Firestore state, Smokescreen stores it as a single metadata document
beside broker selections. Configure it from the dashboard Settings page.

Existing deployments that still have
`google_storage_bucket.identity_documents` in Terraform state should expect the
next plan to destroy that old bucket and its IAM bindings. The bucket must be
empty before destroy can succeed; the expected overseer state is an empty
identity-document bucket before applying the removal.

## Verify IAP Dashboard Access

After `terraform apply` completes, verifying dashboard access is a four-step
sequence:

1. **Configure IAP OAuth branding.** IAP needs its own OAuth client, separate
   from the Gmail OAuth client, before Google can authenticate anyone at the
   dashboard URL. Follow
   [Configure IAP OAuth Branding for the Dashboard](SETUP.md#configure-iap-oauth-branding-for-the-dashboard)
   in `docs/SETUP.md`. Skipping this step yields errors like `Empty Google
   Account OAuth client ID(s)/secret(s)` when you open the URL. This is a
   one-time console step per project; subsequent applies do not repeat it.
2. **Open the dashboard URL** in a browser.
3. **Sign in with the allowlisted Google account** — the value passed as
   `dashboard_allowed_user`.
4. **Confirm the app loads** behind IAP.

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

## End-to-End Testing With a Synthetic Broker

Use layered testing before enabling real broker outreach:

1. **Local dry-run.** Run `uv run smokescreen --dry-run outreach` locally to
   inspect composed emails without sending them.
2. **Synthetic broker.** Set `SMOKESCREEN_TEST_BROKER_EMAIL` locally, or set the
   Terraform `test_broker_email` variable during deploy, to a controlled address
   such as a Gmail plus alias: `your.email+testbroker@gmail.com`. Trigger
   outreach, then reply from a second account with different response patterns
   to exercise classifier output, state-machine transitions, follow-up replies,
   and dashboard state changes.
3. **Real-broker canary.** Enable one real broker at a time in the dashboard's
   persisted broker selections and verify the full request, poll, classify, and
   reply loop.
4. **Full rollout.** Expand broker selections only after the canary path behaves
   as expected.

For deployed testing, pass the synthetic broker settings with the rest of your
Terraform variables:

```bash
terraform apply \
  -var="project_id=${PROJECT_ID}" \
  -var="region=${REGION}" \
  -var="sender_email=${DEPLOYER_EMAIL}" \
  -var="sender_name=${DEPLOYER_NAME}" \
  -var="dashboard_allowed_user=${DEPLOYER_EMAIL}" \
  -var="image=${IMAGE}" \
  -var="test_broker_email=your.email+testbroker@gmail.com"
```

Optional overrides are available when you want a non-default registry identity
or want the broker visible but not automatically enabled for outreach:

```bash
  -var="test_broker_id=testbroker" \
  -var="test_broker_name=Test Broker" \
  -var="test_broker_enabled=false"
```

Leave `test_broker_email` empty to omit the synthetic broker entirely.

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

## Troubleshooting

### Scheduler shows `INVALID_ARGUMENT` / HTTP 400 (`URL_ERROR-ERROR_OTHER`)

Symptom: `gcloud scheduler jobs run smokescreen-poll-schedule` (or
`smokescreen-outreach-schedule`) fails, and the Scheduler job history shows
`status=INVALID_ARGUMENT`, original HTTP response code `400`, and
`debugInfo=URL_ERROR-ERROR_OTHER`. Manual `gcloud run jobs execute` still
works, which means the job resource and IAM are healthy — only the
Scheduler-to-Cloud-Run invocation is broken.

Cause: the Scheduler `http_target.uri` is pointing at the legacy Cloud Run v1
Jobs endpoint (`https://REGION-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/PROJECT/jobs/JOB:run`)
while the actual jobs are `google_cloud_run_v2_job` resources. The v1
endpoint does not accept v2 job invocations.

Fix: confirm `infra/main.tf` uses the Cloud Run Jobs **v2** REST endpoint for
both scheduler resources:

```text
https://run.googleapis.com/v2/projects/PROJECT_ID/locations/REGION/jobs/JOB_NAME:run
```

Re-run `terraform apply` and re-trigger the scheduler job to verify.

### Cloud Run job stuck on `SecretsAccessCheckFailed` / `Ready=False`

Symptom: A Cloud Run v2 Job stays in `Ready=False` with a
`SecretsAccessCheckFailed` condition even after the Secret Manager payloads
have been populated. This happens when the job was created (during the
first `terraform apply`) before the referenced secret versions existed.
Cloud Run caches the failed access check and does not automatically retry it
when the version later appears.

Fix: force a job update so Cloud Run re-evaluates secret access. Run this
once for each job after populating the secrets and before triggering the
scheduler:

```bash
gcloud run jobs update smokescreen-poll \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --update-labels=refresh=1

gcloud run jobs update smokescreen-outreach \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --update-labels=refresh=1
```

The `--update-labels=refresh=1` change is a no-op nudge that triggers Cloud
Run to re-check secret access; the label itself is not read by the
application. If the deploy followed the [First-Deploy Sequence](#first-deploy-sequence)
correctly (Phase 1, then populate secrets, then Phase 3), this recovery
step is not needed.

## Update or Roll Back an Image

### Normal upgrade — release pipeline

To ship a new version, merge a conventional-commit change to `main`. The
release workflow cuts a `vX.Y.Z` tag, publishes the image, and runs
`terraform apply` against the shared GCS state. No local step is required.

### Redeploy the last release without a new commit

Sometimes you need to re-apply the current release — for example, after
manually populating a new secret version so Cloud Run picks it up, or after
changing a repository variable. Re-run the last successful `Release`
workflow from **GitHub Actions → Release → …last run… → Re-run all jobs**.
Semantic-release will not cut a new tag; the deploy job will re-apply
Terraform against the same tag.

### Roll back to an earlier tag

Roll backs are still driven by Terraform, but the safer path is a revert
commit that becomes its own release:

1. `git revert` the offending commit, open a PR, and merge it. The release
   workflow cuts a new `vX.Y.Z` tag on the reverted code and deploys it.

For an emergency in-place rollback without a revert commit, use the
break-glass path in the next section with the previous tag:

```bash
export IMAGE_TAG="v0.18.0"  # last known-good tag
export IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPO}/smokescreen:${IMAGE_TAG}"
terraform apply -var="image=${IMAGE}" ...
```

Cloud Run will create a new revision pointing at that older image. Follow
up by opening a proper revert PR so `main` and the deployed state agree.

### Break-glass local apply

The manual `terraform apply` path documented above still works. Use it when
the release workflow is broken, when debugging Terraform state, or when
investigating drift the pipeline flagged. Because the backend now points at
the shared GCS bucket, a local apply mutates the same state CI does — take
the usual care about concurrent runs.

## Troubleshooting the release workflow

### `deploy` job fails at `Validate deploy repository variables`

The deploy job now checks required GitHub Actions repository variables before
it authenticates to Google Cloud or runs Terraform. If the step reports missing
variables, set the named values in **Settings > Secrets and variables >
Actions > Variables** and rerun the Release workflow:

- `GCP_PROJECT_ID`
- `GCP_REGION`
- `SMOKESCREEN_SENDER_EMAIL`
- `SMOKESCREEN_SENDER_NAME`
- `WIF_PROVIDER`
- `WIF_SERVICE_ACCOUNT`

`GCP_REGION` is required explicitly. Use the same region you chose during
setup, usually `us-central1`.

### `Release` job succeeded but no `deploy` ran

The deploy job is gated on `needs.release.outputs.tag != ''`. If
semantic-release did not analyze any release-worthy commits (all commits
were `chore:`, `test:`, `refactor:` without `!` breaking marker, etc.), no
tag was cut and deploy is intentionally skipped. This is the normal case
for non-release merges.

### `deploy` job fails at `terraform init`

Most `terraform init` failures against the GCS backend are auth or bucket
scope problems:

- The CI service account is missing `roles/storage.objectAdmin` on the
  tfstate bucket. Confirm the grant from
  [SETUP.md](SETUP.md#grant-deploy-roles-to-the-ci-service-account) is
  present on the bucket, not just project-wide.
- The bucket name in `infra/backend.tf` does not match the bucket you
  created. Forks must edit `backend.tf` to match their unique bucket name.
- Workload Identity Federation is misconfigured. Re-run `docker-publish`
  in isolation; if it can push images, WIF is working and the problem is
  scoped to Terraform/bucket IAM.

### `deploy` job fails at `terraform apply`

- Missing repository variables should be caught by the preflight step before
  Terraform runs. If Terraform still reports an empty required input, verify
  the variable names match
  [SETUP.md](SETUP.md#set-github-actions-repository-variables).
- IAP IAM policy 403 → errors mentioning
  `iap webcloudrunservice ... getIamPolicy` or
  `google_iap_web_cloud_run_service_iam_member.dashboard_accessor` mean the
  CI service account is missing IAP Policy Admin (`roles/iap.admin`).
  `roles/iap.settingsAdmin` is not enough because it does not grant
  `iap.web*.getIamPolicy` or `iap.web*.setIamPolicy`.
- IAM shortage → the apply reports `Permission denied` on a resource kind.
  Cross-reference the failing resource against the role list in
  [SETUP.md](SETUP.md#grant-deploy-roles-to-the-ci-service-account) and
  add the missing role to the CI service account.
- GCS bucket creation failure → if the missing permission is
  `storage.buckets.create`, existing deployers may need to add project-level
  `roles/storage.admin` to the CI service account, then rerun the failed
  workflow with `gh run rerun --failed WORKFLOW_ID` or trigger a fresh release.
- Secret access failure on Cloud Run → the payload was never populated
  for that project. First deploys still need the manual Phase 2 secret
  population step; the deploy job does not populate secrets.

## Checkpoint

smokescreen is running in my GCP project and I can access the dashboard.
