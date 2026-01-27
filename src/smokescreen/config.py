"""Configuration via environment variables with SMOKESCREEN_ prefix."""

from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings


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
    sender_email: str = Field(
        description="Email address to send opt-out requests from",
    )
    sender_name: str = Field(
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
        default=Path("smokescreen.db"),
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
        description="Gmail label to filter poll results",
    )
    dry_run: bool = Field(
        default=False,
        description="If true, don't actually send emails or update state",
    )


def get_settings(**overrides) -> Settings:
    """Load settings from environment, with optional overrides."""
    return Settings(**overrides)
