terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.50"
    }
    google-beta = {
      source = "hashicorp/google-beta"
      # Direct Cloud Run service IAP is exposed through the beta provider.
      version = "~> 6.50"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

data "google_project" "current" {
  project_id = var.project_id
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

resource "google_service_account" "dashboard" {
  account_id   = "smokescreen-dashboard"
  display_name = "Smokescreen Dashboard Cloud Run SA"
}

resource "google_project_iam_member" "firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.smokescreen.email}"
}

resource "google_project_iam_member" "dashboard_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.dashboard.email}"
}

resource "google_project_iam_member" "aiplatform_user" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.smokescreen.email}"
}

resource "google_project_iam_member" "dashboard_aiplatform_user" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.dashboard.email}"
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

resource "google_secret_manager_secret_iam_member" "dashboard_gmail_token_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.gmail_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.dashboard.email}"
}

resource "google_secret_manager_secret_iam_member" "dashboard_anthropic_key_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.anthropic_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.dashboard.email}"
}

resource "google_secret_manager_secret_iam_member" "dashboard_gmail_credentials_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.gmail_credentials.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.dashboard.email}"
}

# --- Cloud Run Services ---

resource "google_cloud_run_v2_service" "dashboard" {
  provider = google-beta

  name        = "smokescreen-dashboard"
  location    = var.region
  ingress     = "INGRESS_TRAFFIC_ALL"
  iap_enabled = true

  template {
    service_account = google_service_account.dashboard.email

    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }

    containers {
      image = var.image
      args  = ["serve", "--host", "0.0.0.0", "--port", "8080"]

      ports {
        name           = "http1"
        container_port = 8080
      }

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
        name  = "SMOKESCREEN_AI_PROVIDER"
        value = var.ai_provider
      }
      env {
        name  = "SMOKESCREEN_GEMINI_MODEL"
        value = var.gemini_model
      }
      env {
        name  = "SMOKESCREEN_GEMINI_PROJECT"
        value = var.project_id
      }
      env {
        name  = "SMOKESCREEN_GEMINI_LOCATION"
        value = var.gemini_location
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
      dynamic "env" {
        for_each = var.ai_provider == "anthropic" ? [1] : []

        content {
          name = "SMOKESCREEN_ANTHROPIC_API_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.anthropic_key.secret_id
              version = "latest"
            }
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
  }
}

resource "google_cloud_run_v2_service_iam_member" "dashboard_iap_invoker" {
  project  = google_cloud_run_v2_service.dashboard.project
  location = google_cloud_run_v2_service.dashboard.location
  name     = google_cloud_run_v2_service.dashboard.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-iap.iam.gserviceaccount.com"
}

resource "google_iap_web_cloud_run_service_iam_member" "dashboard_accessor" {
  provider = google-beta

  project                = google_cloud_run_v2_service.dashboard.project
  location               = google_cloud_run_v2_service.dashboard.location
  cloud_run_service_name = google_cloud_run_v2_service.dashboard.name
  role                   = "roles/iap.httpsResourceAccessor"
  member                 = "user:${var.dashboard_allowed_user}"
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
          name  = "SMOKESCREEN_AI_PROVIDER"
          value = var.ai_provider
        }
        env {
          name  = "SMOKESCREEN_GEMINI_MODEL"
          value = var.gemini_model
        }
        env {
          name  = "SMOKESCREEN_GEMINI_PROJECT"
          value = var.project_id
        }
        env {
          name  = "SMOKESCREEN_GEMINI_LOCATION"
          value = var.gemini_location
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
        dynamic "env" {
          for_each = var.ai_provider == "anthropic" ? [1] : []

          content {
            name = "SMOKESCREEN_ANTHROPIC_API_KEY"
            value_source {
              secret_key_ref {
                secret  = google_secret_manager_secret.anthropic_key.secret_id
                version = "latest"
              }
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
          name  = "SMOKESCREEN_AI_PROVIDER"
          value = var.ai_provider
        }
        env {
          name  = "SMOKESCREEN_GEMINI_MODEL"
          value = var.gemini_model
        }
        env {
          name  = "SMOKESCREEN_GEMINI_PROJECT"
          value = var.project_id
        }
        env {
          name  = "SMOKESCREEN_GEMINI_LOCATION"
          value = var.gemini_location
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
        dynamic "env" {
          for_each = var.ai_provider == "anthropic" ? [1] : []

          content {
            name = "SMOKESCREEN_ANTHROPIC_API_KEY"
            value_source {
              secret_key_ref {
                secret  = google_secret_manager_secret.anthropic_key.secret_id
                version = "latest"
              }
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
