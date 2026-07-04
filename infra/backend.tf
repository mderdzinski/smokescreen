# Remote Terraform state - required so CI (release.yml) can apply the same
# state as any local operator running `terraform apply`.
#
# The bucket is NOT managed by Terraform (chicken-and-egg with the backend
# itself). Create it once with the `gcloud storage buckets create` command
# documented in docs/SETUP.md, then pass it at init time with
# `terraform init -backend-config="bucket=YOUR_BUCKET_NAME"`.
terraform {
  backend "gcs" {
    prefix = "terraform/state"
  }
}
