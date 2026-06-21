"""OAuth2 token management for Gmail API."""

from __future__ import annotations

import json
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = [
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.readonly",
]


def get_credentials(
    credentials_path: Path,
    token_path: Path,
    *,
    credentials_json: str = "",
    token_json: str = "",
    interactive: bool = True,
) -> Credentials:
    """Load or refresh OAuth2 credentials.

    Secret-backed deployments can pass authorized-user token JSON directly and
    disable the interactive installed-app flow. Local development can keep using
    credentials/token files and open a browser on first run.
    """
    creds: Credentials | None = None
    token_from_file = False

    if token_json.strip():
        creds = Credentials.from_authorized_user_info(json.loads(token_json), SCOPES)
    elif token_path.exists():
        creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)
        token_from_file = True

    if creds and creds.valid:
        return creds

    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
        if token_from_file:
            token_path.write_text(creds.to_json())
        return creds
    else:
        if not interactive:
            raise RuntimeError(
                "Gmail OAuth token is missing or invalid and interactive OAuth is "
                "disabled. Provide SMOKESCREEN_GMAIL_TOKEN_JSON with an "
                "authorized-user token containing a refresh_token."
            )
        if credentials_json.strip():
            flow = InstalledAppFlow.from_client_config(
                json.loads(credentials_json),
                SCOPES,
            )
        else:
            flow = InstalledAppFlow.from_client_secrets_file(
                str(credentials_path),
                SCOPES,
            )
        creds = flow.run_local_server(port=0)

    token_path.write_text(creds.to_json())
    return creds
