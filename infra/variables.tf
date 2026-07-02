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

variable "ai_provider" {
  description = "AI provider for reply classification: anthropic or gemini"
  type        = string
  default     = "anthropic"

  validation {
    condition     = contains(["anthropic", "gemini"], var.ai_provider)
    error_message = "ai_provider must be either anthropic or gemini."
  }
}

variable "gemini_model" {
  description = "Vertex AI Gemini model used when ai_provider is gemini"
  type        = string
  default     = "gemini-3.1-flash-lite"
}

variable "gemini_location" {
  description = "Vertex AI location used when ai_provider is gemini"
  type        = string
  default     = "global"
}

variable "dashboard_allowed_user" {
  description = "Google account email granted IAP access to the dashboard Cloud Run service"
  type        = string
  default     = "mark.derdzinski@gmail.com"
}
