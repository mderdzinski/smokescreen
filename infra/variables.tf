variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "us-central1"
}

variable "sender_email" {
  description = "Email address for sending opt-out requests"
  type        = string
}

variable "sender_name" {
  description = "Full legal name for opt-out requests"
  type        = string
}

variable "image" {
  description = "Container image for Cloud Run Jobs and the dashboard service"
  type        = string
}

variable "dashboard_allowed_user" {
  description = "Google account email granted IAP access to the dashboard Cloud Run service"
  type        = string
  default     = "mark.derdzinski@gmail.com"
}
