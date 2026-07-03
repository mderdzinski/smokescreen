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
  description = "Default AI provider for reply classification. 'gemini' (uses Vertex AI, no separate secret needed) or 'anthropic' (requires anthropic-key secret populated)."
  type        = string
  default     = "gemini"

  validation {
    condition     = contains(["gemini", "anthropic"], var.ai_provider)
    error_message = "ai_provider must be one of: gemini, anthropic."
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

variable "rerequest_interval_days" {
  description = "Days between deletion re-requests to the same broker. Must be between 7 and 365."
  type        = number
  default     = 30

  validation {
    condition     = var.rerequest_interval_days >= 7 && var.rerequest_interval_days <= 365
    error_message = "rerequest_interval_days must be between 7 and 365."
  }
}

variable "state_timeout_days" {
  description = "Days a waiting broker record can stall before smokescreen pings; a second silent period escalates it to human review."
  type        = number
  default     = 14

  validation {
    condition     = var.state_timeout_days >= 1 && var.state_timeout_days <= 90
    error_message = "state_timeout_days must be between 1 and 90."
  }
}

variable "test_broker_id" {
  description = "Runtime synthetic test broker ID registered when test_broker_email is set."
  type        = string
  default     = "testbroker"
}

variable "test_broker_name" {
  description = "Runtime synthetic test broker display name registered when test_broker_email is set."
  type        = string
  default     = "Test Broker"
}

variable "test_broker_email" {
  description = "Runtime synthetic test broker privacy email. Leave empty to disable synthetic broker registration."
  type        = string
  default     = ""
}

variable "test_broker_enabled" {
  description = "Whether the runtime synthetic test broker is enabled for outreach by default."
  type        = bool
  default     = true
}
