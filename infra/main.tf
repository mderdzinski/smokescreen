terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# --- Firestore ---

resource "google_firestore_database" "default" {
  project     = var.project_id
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"
}

# --- Service Account ---

resource "google_service_account" "smokescreen" {
  account_id   = "smokescreen"
  display_name = "Smokescreen Cloud Run SA"
}

resource "google_project_iam_member" "firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.smokescreen.email}"
}

resource "google_project_iam_member" "secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.smokescreen.email}"
}

# --- Secrets ---

resource "google_secret_manager_secret" "gmail_token" {
  secret_id = "smokescreen-gmail-token"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "anthropic_key" {
  secret_id = "smokescreen-anthropic-key"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "gmail_credentials" {
  secret_id = "smokescreen-gmail-credentials"
  replication {
    auto {}
  }
}

# --- Cloud Run Jobs ---

resource "google_cloud_run_v2_job" "poll_and_reply" {
  name     = "smokescreen-poll"
  location = var.region

  template {
    template {
      service_account = google_service_account.smokescreen.email

      containers {
        image = var.image
        args  = ["poll"]

        env {
          name  = "SMOKESCREEN_STATE_BACKEND"
          value = "firestore"
        }
        env {
          name  = "SMOKESCREEN_FIRESTORE_PROJECT"
          value = var.project_id
        }
        env {
          name  = "SMOKESCREEN_SENDER_EMAIL"
          value = var.sender_email
        }
        env {
          name  = "SMOKESCREEN_SENDER_NAME"
          value = var.sender_name
        }
        env {
          name  = "SMOKESCREEN_GMAIL_OAUTH_INTERACTIVE"
          value = "false"
        }
        env {
          name = "SMOKESCREEN_GMAIL_CREDENTIALS_JSON"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.gmail_credentials.secret_id
              version = "latest"
            }
          }
        }
        env {
          name = "SMOKESCREEN_GMAIL_TOKEN_JSON"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.gmail_token.secret_id
              version = "latest"
            }
          }
        }
        env {
          name = "SMOKESCREEN_ANTHROPIC_API_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.anthropic_key.secret_id
              version = "latest"
            }
          }
        }

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }
      }

      timeout     = "300s"
      max_retries = 1
    }
  }
}

resource "google_cloud_run_v2_job" "outreach" {
  name     = "smokescreen-outreach"
  location = var.region

  template {
    template {
      service_account = google_service_account.smokescreen.email

      containers {
        image = var.image
        args  = ["outreach"]

        env {
          name  = "SMOKESCREEN_STATE_BACKEND"
          value = "firestore"
        }
        env {
          name  = "SMOKESCREEN_FIRESTORE_PROJECT"
          value = var.project_id
        }
        env {
          name  = "SMOKESCREEN_SENDER_EMAIL"
          value = var.sender_email
        }
        env {
          name  = "SMOKESCREEN_SENDER_NAME"
          value = var.sender_name
        }
        env {
          name  = "SMOKESCREEN_GMAIL_OAUTH_INTERACTIVE"
          value = "false"
        }
        env {
          name = "SMOKESCREEN_GMAIL_CREDENTIALS_JSON"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.gmail_credentials.secret_id
              version = "latest"
            }
          }
        }
        env {
          name = "SMOKESCREEN_GMAIL_TOKEN_JSON"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.gmail_token.secret_id
              version = "latest"
            }
          }
        }
        env {
          name = "SMOKESCREEN_ANTHROPIC_API_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.anthropic_key.secret_id
              version = "latest"
            }
          }
        }

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }
      }

      timeout     = "300s"
      max_retries = 1
    }
  }
}

# --- Cloud Scheduler ---

resource "google_cloud_scheduler_job" "poll_schedule" {
  name     = "smokescreen-poll-schedule"
  schedule = "*/10 * * * *"
  region   = var.region

  depends_on = [google_cloud_run_v2_job_iam_member.poll_scheduler_invoker]

  http_target {
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/smokescreen-poll:run"
    http_method = "POST"

    oauth_token {
      service_account_email = google_service_account.smokescreen.email
    }
  }
}

resource "google_cloud_scheduler_job" "outreach_schedule" {
  name     = "smokescreen-outreach-schedule"
  schedule = "0 9 * * *"
  region   = var.region

  depends_on = [google_cloud_run_v2_job_iam_member.outreach_scheduler_invoker]

  http_target {
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/smokescreen-outreach:run"
    http_method = "POST"

    oauth_token {
      service_account_email = google_service_account.smokescreen.email
    }
  }
}

# Allow scheduler SA to invoke only the Smokescreen Cloud Run jobs.
resource "google_cloud_run_v2_job_iam_member" "poll_scheduler_invoker" {
  project  = var.project_id
  location = google_cloud_run_v2_job.poll_and_reply.location
  name     = google_cloud_run_v2_job.poll_and_reply.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.smokescreen.email}"
}

resource "google_cloud_run_v2_job_iam_member" "outreach_scheduler_invoker" {
  project  = var.project_id
  location = google_cloud_run_v2_job.outreach.location
  name     = google_cloud_run_v2_job.outreach.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.smokescreen.email}"
}
