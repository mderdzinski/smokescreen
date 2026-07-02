# CI Setup

Smokescreen releases are automated with GitHub Actions:

- Pushes to `main` run semantic-release.
- semantic-release creates release commits, updates `pyproject.toml` and
  `CHANGELOG.md`, pushes `vX.Y.Z` tags, and creates GitHub Releases for those
  tags.
- The Docker publish workflow builds the Linux amd64 image for `v*` tags and
  pushes both the version tag and `latest` to Artifact Registry. Direct tag
  pushes trigger it, and the release workflow calls the same workflow after
  semantic-release creates a tag.

The Docker publish workflow uses Workload Identity Federation. Do not create or
store a Google Cloud service account JSON key for CI.

## One-time Google Cloud setup

Run these commands from a local shell that is already authenticated to Google
Cloud with permission to manage IAM, Workload Identity Federation, service
accounts, and Artifact Registry IAM in `smokescreen-app`.

These commands intentionally do not enable APIs. Make sure the required APIs and
the Artifact Registry repository already exist before the first release tag is
pushed.

```bash
export PROJECT_ID="smokescreen-app"
export PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format="value(projectNumber)")"
export POOL_ID="github-actions"
export PROVIDER_ID="github"
export SERVICE_ACCOUNT_ID="smokescreen-ci"
export SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT_ID}@${PROJECT_ID}.iam.gserviceaccount.com"
export REPOSITORY="mderdzinski/smokescreen"

gcloud iam workload-identity-pools create "${POOL_ID}" \
  --project="${PROJECT_ID}" \
  --location="global" \
  --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc "${PROVIDER_ID}" \
  --project="${PROJECT_ID}" \
  --location="global" \
  --workload-identity-pool="${POOL_ID}" \
  --display-name="GitHub Actions provider" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition="assertion.repository == '${REPOSITORY}'"

gcloud iam service-accounts create "${SERVICE_ACCOUNT_ID}" \
  --project="${PROJECT_ID}" \
  --display-name="Smokescreen GitHub Actions CI"

gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
  --role="roles/artifactregistry.writer"

gcloud iam service-accounts add-iam-policy-binding "${SERVICE_ACCOUNT_EMAIL}" \
  --project="${PROJECT_ID}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository/${REPOSITORY}"
```

If the Artifact Registry repository still needs to be created, create it
separately before CI runs. The Docker workflow expects this image path:

```text
us-central1-docker.pkg.dev/smokescreen-app/smokescreen/smokescreen
```

## GitHub Actions repository variables

Set these repository variables in `mderdzinski/smokescreen`:

```text
WIF_PROVIDER=projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-actions/providers/github
WIF_SERVICE_ACCOUNT=smokescreen-ci@smokescreen-app.iam.gserviceaccount.com
```

`WIF_PROVIDER` must use the numeric project number, not the project ID. Configure
these as variables, not secrets. The release workflow uses the
repository-provided `GITHUB_TOKEN`; no Google Cloud JSON key or long-lived
Google Cloud credential is required.
