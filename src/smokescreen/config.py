"""Configuration via environment variables with SMOKESCREEN_ prefix."""

from __future__ import annotations

import json
import os
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings

SENSITIVE_FIELDS: set[str] = {
    "anthropic_api_key",
    "gmail_credentials_json",
    "gmail_token_json",
}

# Fields that require a server restart to take effect
RESTART_FIELDS: set[str] = {
    "state_backend",
    "sqlite_path",
    "firestore_project",
    "firestore_collection",
    "gmail_credentials_path",
    "gmail_credentials_json",
    "gmail_oauth_interactive",
    "gmail_token_json",
    "gmail_token_path",
    "sender_email",
    "sender_name",
}


class Settings(BaseSettings):
    model_config = {"env_prefix": "SMOKESCREEN_"}

    # Gmail OAuth
    gmail_credentials_path: Path = Field(
        default=Path("credentials.json"),
        description="Path to Gmail OAuth client credentials JSON",
    )
    gmail_token_path: Path = Field(
        default=Path("token.json"),
        description="Path to stored OAuth token",
    )
    gmail_credentials_json: str = Field(
        default="",
        description="OAuth client credentials JSON, used for secret-backed deployments",
    )
    gmail_token_json: str = Field(
        default="",
        description=(
            "Authorized user OAuth token JSON, used for secret-backed deployments"
        ),
    )
    gmail_oauth_interactive: bool = Field(
        default=True,
        description="Allow browser-based OAuth when no reusable token is available",
    )
    sender_email: str = Field(
        default="",
        description="Email address to send opt-out requests from",
    )
    sender_name: str = Field(
        default="",
        description="Full legal name for opt-out requests",
    )

    # Claude API
    anthropic_api_key: str = Field(default="", description="Anthropic API key")
    anthropic_model: str = Field(
        default="claude-sonnet-4-20250514",
        description="Claude model to use for classification/composition",
    )

    # State backend
    state_backend: str = Field(
        default="sqlite",
        description="State backend: 'sqlite' or 'firestore'",
    )
    sqlite_path: Path = Field(
        default_factory=lambda: Path.home() / ".smokescreen" / "data.db",
        description="Path to SQLite database (local dev)",
    )
    firestore_project: str = Field(
        default="",
        description="GCP project ID for Firestore",
    )
    firestore_collection: str = Field(
        default="opt_outs",
        description="Firestore collection name",
    )

    # Identity docs
    identity_docs_dir: Path = Field(
        default=Path("identity/"),
        description="Directory containing pre-redacted identity documents",
    )

    # Job settings
    max_retries: int = Field(
        default=5,
        description="Max retries per broker before marking FAILED",
    )
    poll_label: str = Field(
        default="smokescreen",
        description=(
            "Gmail label used to select active threads during polling; "
            "blank disables label filtering"
        ),
    )
    dry_run: bool = Field(
        default=False,
        description="If true, don't actually send emails or update state",
    )
    rerequest_interval_days: int = Field(
        default=60,
        description="Days after completion before re-sending a deletion request",
    )


def _get_settings_file_path() -> Path:
    """Return the path to the settings JSON file."""
    return Path(os.environ.get("SMOKESCREEN_SETTINGS_FILE", "settings.json"))


def load_settings_file(path: Path | None = None) -> dict:
    """Read settings from the JSON file, returning an empty dict if missing."""
    if path is None:
        path = _get_settings_file_path()
    if not path.exists():
        return {}
    text = path.read_text(encoding="utf-8")
    if not text.strip():
        return {}
    return json.loads(text)


def save_settings(data: dict, path: Path | None = None) -> None:
    """Write settings dict to the JSON file."""
    if path is None:
        path = _get_settings_file_path()
    # Convert Path values to strings for JSON serialization
    serializable = {}
    for k, v in data.items():
        serializable[k] = str(v) if isinstance(v, Path) else v
    path.write_text(json.dumps(serializable, indent=2) + "\n", encoding="utf-8")


def get_settings(settings_file: Path | None = None, **overrides) -> Settings:
    """Load settings from JSON file + environment, with optional overrides.

    Precedence: overrides > env vars > JSON file > Pydantic defaults.
    """
    file_data = load_settings_file(settings_file)
    # File values are used as kwargs; env vars and overrides take precedence
    # because pydantic-settings reads env vars automatically.
    merged = {**file_data, **overrides}
    return Settings(**merged)
