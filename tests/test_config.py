"""Tests for application settings."""

from smokescreen.config import Settings


def test_allow_self_reply_defaults_false():
    settings = Settings(sender_email="me@example.com", sender_name="Test User")

    assert settings.allow_self_reply is False


def test_allow_self_reply_reads_env(monkeypatch):
    monkeypatch.setenv("SMOKESCREEN_ALLOW_SELF_REPLY", "true")

    settings = Settings(sender_email="me@example.com", sender_name="Test User")

    assert settings.allow_self_reply is True
