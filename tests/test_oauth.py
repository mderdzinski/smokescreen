"""Tests for Gmail OAuth credential loading."""

from __future__ import annotations

import json

import pytest

from smokescreen.email.oauth import SCOPES, get_credentials


def _authorized_user_token() -> str:
    return json.dumps(
        {
            "token": "ya29.test-access-token",
            "refresh_token": "test-refresh-token",
            "token_uri": "https://oauth2.googleapis.com/token",
            "client_id": "test-client-id.apps.googleusercontent.com",
            "client_secret": "test-client-secret",
            "scopes": SCOPES,
            "expiry": "2099-01-01T00:00:00Z",
        }
    )


def test_get_credentials_loads_authorized_user_token_json(tmp_path):
    creds = get_credentials(
        tmp_path / "credentials.json",
        tmp_path / "token.json",
        token_json=_authorized_user_token(),
        interactive=False,
    )

    assert creds.valid
    assert creds.refresh_token == "test-refresh-token"
    assert not (tmp_path / "token.json").exists()


def test_get_credentials_noninteractive_requires_reusable_token(tmp_path):
    with pytest.raises(RuntimeError, match="interactive OAuth is disabled"):
        get_credentials(
            tmp_path / "credentials.json",
            tmp_path / "token.json",
            interactive=False,
        )

    assert not (tmp_path / "token.json").exists()
