"""Tests for the FastAPI dashboard API."""

import json
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from smokescreen.api import app, init_app
from smokescreen.brokers.registry import BrokerRegistry
from smokescreen.config import Settings
from smokescreen.models import Broker, BrokerStatus, OptOutRecord
from smokescreen.state.sqlite import SQLiteStore


def _make_brokers():
    return [
        Broker(
            id="spokeo",
            name="Spokeo",
            domain="spokeo.com",
            privacy_email="privacy@spokeo.com",
        ),
        Broker(
            id="beenverified",
            name="BeenVerified",
            domain="beenverified.com",
            privacy_email="privacy@beenverified.com",
        ),
    ]


@pytest.fixture
def client():
    with tempfile.NamedTemporaryFile(suffix=".db") as f:
        store = SQLiteStore(Path(f.name))
        registry = BrokerRegistry(_make_brokers())
        init_app(store, registry)
        yield TestClient(app)
        store.close()


@pytest.fixture
def seeded_client(client):
    """Client with some opt-out records pre-seeded."""
    from smokescreen.api import get_store

    store = get_store()
    store.upsert(OptOutRecord(broker_id="spokeo", status=BrokerStatus.INITIAL_SENT))
    store.upsert(OptOutRecord(broker_id="beenverified", status=BrokerStatus.COMPLETED))
    return client


# --- Dashboard ---


def test_dashboard_returns_html(client):
    resp = client.get("/")
    assert resp.status_code == 200
    assert "Smokescreen Dashboard" in resp.text


def test_old_dashboard_returns_html(client):
    resp = client.get("/old-dashboard")
    assert resp.status_code == 200
    assert "Smokescreen Dashboard" in resp.text


def test_react_app_redirect(client):
    resp = client.get("/app", follow_redirects=False)
    assert resp.status_code == 307
    assert resp.headers["location"] == "/app/"


# --- Broker endpoints ---


def test_list_brokers(client):
    resp = client.get("/api/brokers")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 2
    ids = {b["id"] for b in data}
    assert ids == {"spokeo", "beenverified"}


def test_create_broker(client):
    resp = client.post(
        "/api/brokers",
        json={
            "id": "newbroker",
            "name": "New Broker",
            "domain": "newbroker.com",
            "privacy_email": "p@newbroker.com",
        },
    )
    assert resp.status_code == 201
    assert resp.json()["id"] == "newbroker"

    # Verify it's listed
    resp = client.get("/api/brokers")
    ids = {b["id"] for b in resp.json()}
    assert "newbroker" in ids


def test_create_duplicate_broker(client):
    resp = client.post(
        "/api/brokers",
        json={
            "id": "spokeo",
            "name": "Dup",
            "domain": "dup.com",
            "privacy_email": "p@dup.com",
        },
    )
    assert resp.status_code == 400


def test_update_broker(client):
    resp = client.put(
        "/api/brokers/spokeo",
        json={
            "name": "Spokeo Updated",
            "domain": "updated.spokeo.com",
            "aliases": ["alias.spokeo.com"],
        },
    )
    assert resp.status_code == 200
    assert resp.json()["name"] == "Spokeo Updated"
    assert resp.json()["domain"] == "updated.spokeo.com"

    from smokescreen.api import get_registry

    registry = get_registry()
    assert registry.get_by_domain("spokeo.com") is None
    assert registry.get_by_domain("updated.spokeo.com").id == "spokeo"
    assert registry.get_by_domain("alias.spokeo.com").id == "spokeo"


def test_update_broker_not_found(client):
    resp = client.put("/api/brokers/nonexistent", json={"name": "X"})
    assert resp.status_code == 404


def test_delete_broker(client):
    resp = client.delete("/api/brokers/spokeo")
    assert resp.status_code == 204

    resp = client.get("/api/brokers")
    ids = {b["id"] for b in resp.json()}
    assert "spokeo" not in ids

    from smokescreen.api import get_registry

    assert get_registry().get_by_domain("spokeo.com") is None


# --- Opt-out endpoints ---


def test_list_optouts_empty(client):
    resp = client.get("/api/optouts")
    assert resp.status_code == 200
    assert resp.json() == []


def test_list_optouts(seeded_client):
    resp = seeded_client.get("/api/optouts")
    assert resp.status_code == 200
    assert len(resp.json()) == 2


def test_list_optouts_by_status(seeded_client):
    resp = seeded_client.get("/api/optouts?status=COMPLETED")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["broker_id"] == "beenverified"


def test_list_optouts_invalid_status(client):
    resp = client.get("/api/optouts?status=INVALID")
    assert resp.status_code == 400


def test_reset_optout(seeded_client):
    resp = seeded_client.post("/api/optouts/spokeo/reset")
    assert resp.status_code == 200
    assert resp.json()["status"] == "reset"


def test_reset_optout_not_found(client):
    resp = client.post("/api/optouts/nonexistent/reset")
    assert resp.status_code == 404


# --- Stats ---


def test_stats(seeded_client):
    resp = seeded_client.get("/api/stats")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 2
    assert data["completion_pct"] == 50.0
    assert data["by_status"]["COMPLETED"] == 1


def test_stats_empty(client):
    resp = client.get("/api/stats")
    assert resp.status_code == 200
    assert resp.json()["total"] == 0
    assert resp.json()["completion_pct"] == 0.0


# --- Whitelist endpoints ---


def test_list_whitelist(client):
    resp = client.get("/api/whitelist")
    assert resp.status_code == 200
    # Should have registry entries from init_app sync
    data = resp.json()
    emails = {e["email"] for e in data}
    assert "privacy@spokeo.com" in emails
    assert "privacy@beenverified.com" in emails


def test_add_whitelist(client):
    resp = client.post(
        "/api/whitelist",
        json={"broker_id": "spokeo", "email": "new@spokeo.com"},
    )
    assert resp.status_code == 201
    assert resp.json()["email"] == "new@spokeo.com"


def test_delete_whitelist(client):
    resp = client.post(
        "/api/whitelist",
        json={"broker_id": "test", "email": "delete-me@test.com"},
    )
    entry_id = resp.json()["id"]
    resp = client.delete(f"/api/whitelist/{entry_id}")
    assert resp.status_code == 204


# --- Pending whitelist endpoints ---


def test_pending_whitelist_empty(client):
    resp = client.get("/api/whitelist/pending")
    assert resp.status_code == 200
    assert resp.json() == []


def test_approve_pending(client):
    from smokescreen.api import get_store
    from smokescreen.models import PendingWhitelistEntry

    store = get_store()
    entry = store.add_pending_whitelist(
        PendingWhitelistEntry(
            broker_id="spokeo",
            email="verify@spokeo.com",
            message_subject="Verify identity",
        )
    )

    resp = client.post(f"/api/whitelist/pending/{entry.id}/approve")
    assert resp.status_code == 200
    assert resp.json()["email"] == "verify@spokeo.com"

    # Should now be whitelisted
    resp = client.get("/api/whitelist")
    emails = {e["email"] for e in resp.json()}
    assert "verify@spokeo.com" in emails


def test_reject_pending(client):
    from smokescreen.api import get_store
    from smokescreen.models import PendingWhitelistEntry

    store = get_store()
    entry = store.add_pending_whitelist(PendingWhitelistEntry(email="spam@test.com"))

    resp = client.post(f"/api/whitelist/pending/{entry.id}/reject")
    assert resp.status_code == 200
    assert resp.json()["status"] == "rejected"


def test_approve_pending_not_found(client):
    resp = client.post("/api/whitelist/pending/999/approve")
    assert resp.status_code == 404


def test_reject_pending_not_found(client):
    resp = client.post("/api/whitelist/pending/999/reject")
    assert resp.status_code == 404


# --- Settings endpoints ---


@pytest.fixture
def settings_client(tmp_path):
    """Client with settings initialized and a temp settings file."""
    import os

    db_path = tmp_path / "test.db"
    settings_file = tmp_path / "settings.json"
    # Point settings file to our temp location
    os.environ["SMOKESCREEN_SETTINGS_FILE"] = str(settings_file)
    store = SQLiteStore(db_path)
    registry = BrokerRegistry(_make_brokers())
    settings = Settings(sender_email="test@example.com", sender_name="Test User")
    init_app(store, registry, settings)
    yield TestClient(app), settings_file
    store.close()
    os.environ.pop("SMOKESCREEN_SETTINGS_FILE", None)


def test_get_settings(settings_client):
    client, _ = settings_client
    resp = client.get("/api/settings")
    assert resp.status_code == 200
    data = resp.json()
    assert data["sender_email"] == "test@example.com"
    assert data["sender_name"] == "Test User"
    assert data["gmail_connected"] is True
    assert data["gmail_connected_email"] == "test@example.com"
    assert "state_backend" not in data
    assert "sqlite_path" not in data
    assert "firestore_project" not in data
    assert "firestore_collection" not in data
    assert "gmail_credentials_path" not in data
    assert "gmail_token_path" not in data
    assert "max_retries" not in data
    assert "dry_run" not in data


def test_get_advanced_settings(settings_client):
    client, _ = settings_client
    resp = client.get("/api/settings/advanced")
    assert resp.status_code == 200
    data = resp.json()
    assert data["poll_label"] == "smokescreen"
    assert data["max_retries"] == 5
    assert data["rerequest_interval_days"] == 60
    assert data["dry_run"] is False
    assert data["anthropic_model"] == "claude-sonnet-4-20250514"
    assert "sender_email" not in data
    assert "sender_name" not in data
    assert "state_backend" not in data
    assert "sqlite_path" not in data
    assert "firestore_project" not in data
    assert "firestore_collection" not in data
    assert "gmail_credentials_path" not in data
    assert "gmail_token_path" not in data


def test_get_advanced_settings_masks_gmail_secrets(settings_client):
    client, _ = settings_client
    import smokescreen.api as api_module

    new_settings = Settings(
        sender_email="test@example.com",
        sender_name="Test User",
        gmail_credentials_json="credentials-secret-value",
        gmail_token_json="token-secret-value",
    )
    api_module._settings = new_settings

    resp = client.get("/api/settings/advanced")
    data = resp.json()
    assert "gmail_credentials_json" not in data
    assert "gmail_token_json" not in data


def test_get_settings_masks_api_key(settings_client):
    client, _ = settings_client
    import smokescreen.api as api_module

    # Create new settings with an API key
    new_settings = Settings(
        sender_email="test@example.com",
        sender_name="Test User",
        anthropic_api_key="sk-ant-secret-key-12345",
    )
    api_module._settings = new_settings

    resp = client.get("/api/settings")
    data = resp.json()
    assert data["anthropic_api_key"] == "sk-a****345"
    assert "secret" not in data["anthropic_api_key"]


def test_get_settings_no_settings_initialized(client):
    """GET /api/settings when no settings were passed to init_app."""
    import smokescreen.api as api_module

    saved = api_module._settings
    api_module._settings = None
    with pytest.raises(RuntimeError, match="Settings not initialized"):
        client.get("/api/settings")
    api_module._settings = saved


def test_put_settings_saves_to_file(settings_client):
    client, settings_file = settings_client
    resp = client.put(
        "/api/settings",
        json={"max_retries": 10, "poll_label": "custom-label"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "saved"
    assert data["restart_required"] is False

    # Verify file was written
    assert settings_file.exists()
    file_data = json.loads(settings_file.read_text())
    assert file_data["max_retries"] == 10
    assert file_data["poll_label"] == "custom-label"


def test_put_settings_restart_required(settings_client):
    client, _ = settings_client
    resp = client.put(
        "/api/settings",
        json={"state_backend": "firestore"},
    )
    assert resp.status_code == 200
    assert resp.json()["restart_required"] is True


def test_put_settings_restart_not_required(settings_client):
    client, _ = settings_client
    resp = client.put(
        "/api/settings",
        json={"dry_run": True},
    )
    assert resp.status_code == 200
    assert resp.json()["restart_required"] is False


def test_put_settings_updates_in_memory(settings_client):
    client, _ = settings_client
    client.put("/api/settings", json={"poll_label": "new-label"})

    resp = client.get("/api/settings/advanced")
    assert resp.json()["poll_label"] == "new-label"


def test_put_settings_rejects_unknown_fields(settings_client):
    client, _ = settings_client
    resp = client.put(
        "/api/settings",
        json={"nonexistent_field": "value"},
    )
    assert resp.status_code == 422


def test_put_settings_api_key(settings_client):
    client, settings_file = settings_client
    resp = client.put(
        "/api/settings",
        json={"anthropic_api_key": "sk-new-key-value"},
    )
    assert resp.status_code == 200

    # Verify key is saved in file
    file_data = json.loads(settings_file.read_text())
    assert file_data["anthropic_api_key"] == "sk-new-key-value"

    # Verify GET masks it
    resp = client.get("/api/settings")
    assert "sk-new-key-value" not in resp.json()["anthropic_api_key"]
    assert resp.json()["anthropic_api_key"] == "sk-n****lue"


def test_put_settings_merges_with_existing_file(settings_client):
    client, settings_file = settings_client
    # Write initial setting
    client.put("/api/settings", json={"poll_label": "first"})
    # Write another setting
    client.put("/api/settings", json={"max_retries": 3})

    # Both should be in the file
    file_data = json.loads(settings_file.read_text())
    assert file_data["poll_label"] == "first"
    assert file_data["max_retries"] == 3
