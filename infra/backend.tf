# Remote Terraform state — required so CI (release.yml) can apply the same
# state as any local operator running `terraform apply`.
#
# The bucket is NOT managed by Terraform (chicken-and-egg with the backend
# itself). Create it once with the `gcloud storage buckets create` command
# documented in docs/SETUP.md. Bucket names are globally unique, so forks
# will need to pick a variant of `smokescreen-app-tfstate`.
terraform {
  backend "gcs" {
    bucket = "smokescreen-app-tfstate"
    prefix = "terraform/state"
  }
}
