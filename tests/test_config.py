"""Tests for application settings."""

import json

from smokescreen.config import Settings, load_settings_file


def test_allow_self_reply_defaults_false():
    settings = Settings(sender_email="me@example.com", sender_name="Test User")

    assert settings.allow_self_reply is False


def test_allow_self_reply_reads_env(monkeypatch):
    monkeypatch.setenv("SMOKESCREEN_ALLOW_SELF_REPLY", "true")

    settings = Settings(sender_email="me@example.com", sender_name="Test User")

    assert settings.allow_self_reply is True


def test_load_settings_file_drops_removed_identity_document_keys(tmp_path):
    settings_file = tmp_path / "settings.json"
    settings_file.write_text(
        json.dumps(
            {
                "sender_email": "me@example.com",
                "identity_bucket": "old-bucket",
                "identity_docs_dir": "identity/",
            }
        ),
        encoding="utf-8",
    )

    data = load_settings_file(settings_file)

    assert data == {"sender_email": "me@example.com"}
