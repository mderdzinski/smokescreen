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

resource "google_firestore_index" "pending_whitelist_email_status" {
  project     = var.project_id
  database    = google_firestore_database.default.name
  collection  = "opt_outs_pending_whitelist"
  query_scope = "COLLECTION"

  fields {
    field_path = "email"
    order      = "ASCENDING"
  }

  fields {
    field_path = "status"
    order      = "ASCENDING"
  }

  fields {
    field_path = "__name__"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "pending_whitelist_status_detected_at" {
  project     = var.project_id
  database    = google_firestore_database.default.name
  collection  = "opt_outs_pending_whitelist"
  query_scope = "COLLECTION"

  fields {
    field_path = "status"
    order      = "ASCENDING"
  }

  fields {
    field_path = "detected_at"
    order      = "ASCENDING"
  }

  fields {
    field_path = "__name__"
    order      = "ASCENDING"
  }
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

# --- Identity Documents ---

resource "google_storage_bucket" "identity_documents" {
  name                        = "${var.project_id}-smokescreen-identity-docs"
  location                    = "us-central1"
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning {
    enabled = true
  }
}

resource "google_storage_bucket_iam_member" "dashboard_identity_document_admin" {
  bucket = google_storage_bucket.identity_documents.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.dashboard.email}"
}

resource "google_storage_bucket_iam_member" "poll_identity_document_viewer" {
  bucket = google_storage_bucket.identity_documents.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.smokescreen.email}"
}

# --- Secrets ---

resource "google_secret_manager_secret" "gmail_token" {
  secret_id = "smokescreen-gmail-token"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "anthropic_key" {
  count = var.ai_provider == "anthropic" ? 1 : 0

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
  count = var.ai_provider == "anthropic" ? 1 : 0

  project   = var.project_id
  secret_id = google_secret_manager_secret.anthropic_key[0].secret_id
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
        name  = "SMOKESCREEN_REREQUEST_INTERVAL_DAYS"
        value = tostring(var.rerequest_interval_days)
      }
      env {
        name  = "SMOKESCREEN_STATE_TIMEOUT_DAYS"
        value = tostring(var.state_timeout_days)
      }
      env {
        name  = "SMOKESCREEN_IDENTITY_BUCKET"
        value = google_storage_bucket.identity_documents.name
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
              secret  = google_secret_manager_secret.anthropic_key[0].secret_id
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
          name  = "SMOKESCREEN_REREQUEST_INTERVAL_DAYS"
          value = tostring(var.rerequest_interval_days)
        }
        env {
          name  = "SMOKESCREEN_STATE_TIMEOUT_DAYS"
          value = tostring(var.state_timeout_days)
        }
        env {
          name  = "SMOKESCREEN_IDENTITY_BUCKET"
          value = google_storage_bucket.identity_documents.name
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
                secret  = google_secret_manager_secret.anthropic_key[0].secret_id
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
          name  = "SMOKESCREEN_REREQUEST_INTERVAL_DAYS"
          value = tostring(var.rerequest_interval_days)
        }
        env {
          name  = "SMOKESCREEN_STATE_TIMEOUT_DAYS"
          value = tostring(var.state_timeout_days)
        }
        env {
          name  = "SMOKESCREEN_IDENTITY_BUCKET"
          value = google_storage_bucket.identity_documents.name
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
                secret  = google_secret_manager_secret.anthropic_key[0].secret_id
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
    # Cloud Run Jobs here are google_cloud_run_v2_job resources, so this URI
    # must target the v2 Jobs REST endpoint:
    #   POST https://run.googleapis.com/v2/projects/{project}/locations/{location}/jobs/{job}:run
    # Targeting the legacy v1 namespaces endpoint returns HTTP 400
    # INVALID_ARGUMENT (URL_ERROR-ERROR_OTHER). Do not change back to v1.
    # Refs: https://cloud.google.com/run/docs/execute/jobs-on-schedule
    #       https://cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs/run
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/smokescreen-poll:run"
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
    # Must target the Cloud Run Jobs v2 REST endpoint to match the
    # google_cloud_run_v2_job resource; see poll_schedule comment above for
    # the failure mode when v1 is used.
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/smokescreen-outreach:run"
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
