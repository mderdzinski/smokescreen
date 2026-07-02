"""Tests for the FastAPI dashboard API."""

import json
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import smokescreen.api as api_module
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


def test_dashboard_returns_react_app(client, monkeypatch, tmp_path):
    web_dist = tmp_path / "web_dist"
    web_dist.mkdir()
    (web_dist / "index.html").write_text(
        "<!doctype html><title>Smokescreen React</title><div id='root'></div>",
        encoding="utf-8",
    )
    monkeypatch.setattr(api_module, "_web_dist_dir", web_dist)

    resp = client.get("/")
    assert resp.status_code == 200
    assert "Smokescreen React" in resp.text

    deep_link_resp = client.get("/needs-attention")
    assert deep_link_resp.status_code == 200
    assert "Smokescreen React" in deep_link_resp.text


def test_dashboard_requires_built_react_app(client, monkeypatch, tmp_path):
    monkeypatch.setattr(api_module, "_web_dist_dir", tmp_path / "missing")

    resp = client.get("/")
    assert resp.status_code == 503
    assert "React app has not been built" in resp.text


def test_react_app_redirect(client):
    resp = client.get("/app", follow_redirects=False)
    assert resp.status_code == 307
    assert resp.headers["location"] == "/"

    deep_link_resp = client.get("/app/needs-attention", follow_redirects=False)
    assert deep_link_resp.status_code == 307
    assert deep_link_resp.headers["location"] == "/needs-attention"


def test_old_dashboard_does_not_fall_through_to_react(client, monkeypatch, tmp_path):
    web_dist = tmp_path / "web_dist"
    web_dist.mkdir()
    (web_dist / "index.html").write_text(
        "<!doctype html><title>Smokescreen React</title><div id='root'></div>",
        encoding="utf-8",
    )
    monkeypatch.setattr(api_module, "_web_dist_dir", web_dist)

    resp = client.get("/old-dashboard")
    assert resp.status_code == 404
    assert "Smokescreen React" not in resp.text

    nested_resp = client.get("/old-dashboard/settings")
    assert nested_resp.status_code == 404
    assert "Smokescreen React" not in nested_resp.text


def test_unknown_api_path_does_not_fall_through_to_react(client, monkeypatch, tmp_path):
    web_dist = tmp_path / "web_dist"
    web_dist.mkdir()
    (web_dist / "index.html").write_text(
        "<!doctype html><title>Smokescreen React</title><div id='root'></div>",
        encoding="utf-8",
    )
    monkeypatch.setattr(api_module, "_web_dist_dir", web_dist)

    resp = client.get("/api/not-real")
    assert resp.status_code == 404


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


def test_create_broker_generates_id(client):
    resp = client.post(
        "/api/brokers",
        json={
            "name": "New Broker",
            "domain": "newbroker.com",
            "privacy_email": "p@newbroker.com",
        },
    )
    assert resp.status_code == 201
    assert resp.json()["id"] == "new-broker"


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


def test_list_optouts_by_needs_attention_group(client):
    from smokescreen.api import get_store

    store = get_store()
    store.upsert(OptOutRecord(broker_id="spokeo", status=BrokerStatus.NEEDS_MANUAL))
    store.upsert(OptOutRecord(broker_id="beenverified", status=BrokerStatus.FAILED))
    store.upsert(OptOutRecord(broker_id="whitepages", status=BrokerStatus.REJECTED))
    store.upsert(OptOutRecord(broker_id="radaris", status=BrokerStatus.COMPLETED))

    resp = client.get("/api/optouts?status=needs_attention")
    assert resp.status_code == 200
    data = resp.json()
    assert {record["broker_id"] for record in data} == {
        "spokeo",
        "beenverified",
        "whitepages",
    }
    assert {record["status"] for record in data} == {
        "NEEDS_MANUAL",
        "FAILED",
        "REJECTED",
    }


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


@pytest.mark.parametrize(
    "status",
    [BrokerStatus.NEEDS_MANUAL, BrokerStatus.REJECTED, BrokerStatus.FAILED],
)
def test_mark_optout_handled_from_attention_states(client, status):
    from smokescreen.api import get_store

    store = get_store()
    broker_id = f"attention-{status.value.lower()}"
    store.upsert(
        OptOutRecord(
            broker_id=broker_id,
            status=status,
            notes="Broker asked for manual review.",
            thread_id="thread-123",
            last_message_id="message-123",
        )
    )

    resp = client.post(f"/api/optouts/{broker_id}/handled")

    assert resp.status_code == 200
    assert resp.json() == {"status": "handled", "broker_id": broker_id}
    saved = store.get(broker_id)
    assert saved is not None
    assert saved.status == BrokerStatus.COMPLETED
    assert saved.notes == "Broker asked for manual review."
    assert saved.thread_id == "thread-123"
    assert saved.last_message_id == "message-123"
    assert saved.last_completed_at is not None
    needs_attention = client.get("/api/optouts?status=needs_attention")
    assert needs_attention.status_code == 200
    assert needs_attention.json() == []


def test_mark_optout_handled_rejects_non_attention_state(seeded_client):
    resp = seeded_client.post("/api/optouts/beenverified/handled")

    assert resp.status_code == 400
    assert "does not need attention" in resp.json()["detail"]


def test_mark_optout_handled_not_found(client):
    resp = client.post("/api/optouts/nonexistent/handled")

    assert resp.status_code == 404


# --- Outreach ---


def test_run_outreach_omitted_broker_ids_processes_enabled_dry_run(settings_client):
    """With broker_ids omitted, only the persisted enabled subset is processed."""
    client, _ = settings_client
    client.put("/api/settings", json={"dry_run": True})
    client.put(
        "/api/brokers/selections",
        json={"enabled_broker_ids": ["spokeo", "beenverified"]},
    )

    resp = client.post("/api/outreach", json={})

    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "sent"
    assert data["processed"] == ["spokeo", "beenverified"]
    assert data["processed_count"] == 2
    assert data["dry_run"] is True
    optouts_resp = client.get("/api/optouts")
    assert optouts_resp.status_code == 200
    records = {record["broker_id"]: record for record in optouts_resp.json()}
    assert set(records) == {"spokeo", "beenverified"}
    for broker_id, record in records.items():
        assert record["status"] == "INITIAL_SENT"
        assert record["thread_id"] == f"dry-run-thread-{broker_id}"
        assert record["last_message_id"] == f"dry-run-message-{broker_id}"


def test_run_outreach_omitted_broker_ids_is_gated_when_no_selection(settings_client):
    """No selection means no outreach, even with broker_ids omitted."""
    client, _ = settings_client
    client.put("/api/settings", json={"dry_run": True})

    resp = client.post("/api/outreach", json={})

    assert resp.status_code == 200
    data = resp.json()
    assert data["processed"] == []
    assert data["processed_count"] == 0


def test_run_outreach_explicit_broker_ids_bypass_gate_dry_run(settings_client):
    """Explicit broker_ids (onboarding first-batch flow) bypass the enable gate."""
    client, _ = settings_client
    client.put("/api/settings", json={"dry_run": True})

    # No selections set — the explicit list still runs.
    resp = client.post("/api/outreach", json={"broker_ids": ["spokeo"]})

    assert resp.status_code == 200
    data = resp.json()
    assert data["processed"] == ["spokeo"]
    assert data["processed_count"] == 1


def test_run_outreach_empty_broker_ids_is_noop_dry_run(settings_client):
    client, _ = settings_client
    client.put("/api/settings", json={"dry_run": True})

    resp = client.post("/api/outreach", json={"broker_ids": []})

    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "sent"
    assert data["processed"] == []
    assert data["processed_count"] == 0
    assert data["dry_run"] is True
    assert client.get("/api/optouts").json() == []


def test_run_outreach_selected_brokers_dry_run(settings_client):
    client, _ = settings_client
    client.put("/api/settings", json={"dry_run": True})

    resp = client.post("/api/outreach", json={"broker_ids": ["spokeo"]})

    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "sent"
    assert data["processed"] == ["spokeo"]
    assert data["processed_count"] == 1
    assert data["dry_run"] is True
    optouts_resp = client.get("/api/optouts")
    assert optouts_resp.status_code == 200
    records = {record["broker_id"]: record for record in optouts_resp.json()}
    assert set(records) == {"spokeo"}
    assert records["spokeo"]["status"] == "INITIAL_SENT"
    assert records["spokeo"]["thread_id"] == "dry-run-thread-spokeo"
    assert records["spokeo"]["last_message_id"] == "dry-run-message-spokeo"


def test_run_outreach_rejects_unknown_broker(settings_client):
    client, _ = settings_client
    client.put("/api/settings", json={"dry_run": True})

    resp = client.post("/api/outreach", json={"broker_ids": ["missing"]})

    assert resp.status_code == 404
    assert "Broker missing not found" in resp.text


def test_run_outreach_without_gmail_credentials_returns_actionable_error(
    settings_client, tmp_path
):
    client, _ = settings_client
    import smokescreen.api as api_module

    api_module._settings = Settings(
        sender_email="test@example.com",
        sender_name="Test User",
        anthropic_api_key="sk-test",
        dry_run=False,
        gmail_oauth_interactive=False,
        gmail_credentials_path=tmp_path / "missing-credentials.json",
        gmail_token_path=tmp_path / "missing-token.json",
    )

    resp = client.post("/api/outreach", json={"broker_ids": ["spokeo"]})

    assert resp.status_code == 400
    assert resp.json()["detail"] == {
        "code": "gmail_credentials_required",
        "message": (
            "Connect Gmail before sending outreach, or enable dry run to prepare "
            "the batch without sending email."
        ),
    }


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


# --- Broker selections endpoints ---


def test_get_broker_selections_defaults_to_empty(client):
    resp = client.get("/api/brokers/selections")
    assert resp.status_code == 200
    assert resp.json() == {"enabled_broker_ids": []}


def test_put_broker_selections_persists_normalized_list(client):
    resp = client.put(
        "/api/brokers/selections",
        json={"enabled_broker_ids": ["spokeo", "spokeo", "beenverified"]},
    )
    assert resp.status_code == 200
    assert resp.json() == {"enabled_broker_ids": ["beenverified", "spokeo"]}

    # Subsequent GET returns the same normalized list.
    get_resp = client.get("/api/brokers/selections")
    assert get_resp.json() == {"enabled_broker_ids": ["beenverified", "spokeo"]}


def test_put_broker_selections_rejects_unknown_broker(client):
    resp = client.put(
        "/api/brokers/selections",
        json={"enabled_broker_ids": ["spokeo", "not-a-real-broker"]},
    )
    assert resp.status_code == 400
    assert "not-a-real-broker" in resp.json()["detail"]

    # The rejection must not partially apply.
    get_resp = client.get("/api/brokers/selections")
    assert get_resp.json() == {"enabled_broker_ids": []}


def test_put_broker_selections_accepts_empty_list(client):
    client.put(
        "/api/brokers/selections",
        json={"enabled_broker_ids": ["spokeo"]},
    )
    resp = client.put(
        "/api/brokers/selections",
        json={"enabled_broker_ids": []},
    )
    assert resp.status_code == 200
    assert resp.json() == {"enabled_broker_ids": []}


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
    settings = Settings(
        sender_email="test@example.com",
        sender_name="Test User",
        gmail_credentials_path=tmp_path / "credentials.json",
        gmail_token_path=tmp_path / "token.json",
    )
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
    assert data["identity_configured"] is True
    assert data["gmail_token_available"] is False
    assert data["gmail_credentials_available"] is False
    assert data["gmail_connected"] is False
    assert data["gmail_connected_email"] == ""
    assert "state_backend" not in data
    assert "sqlite_path" not in data
    assert "firestore_project" not in data
    assert "firestore_collection" not in data
    assert "gmail_credentials_path" not in data
    assert "gmail_token_path" not in data
    assert "max_retries" not in data
    assert "dry_run" not in data


def test_get_settings_reports_gmail_connected_only_when_token_available(
    settings_client,
):
    client, _ = settings_client
    import smokescreen.api as api_module

    new_settings = Settings(
        sender_email="test@example.com",
        sender_name="Test User",
        gmail_token_json="token-secret-value",
    )
    api_module._settings = new_settings

    resp = client.get("/api/settings")
    assert resp.status_code == 200
    data = resp.json()
    assert data["identity_configured"] is True
    assert data["gmail_token_available"] is True
    assert data["gmail_connected"] is True
    assert data["gmail_connected_email"] == "test@example.com"


def test_get_advanced_settings(settings_client):
    client, _ = settings_client
    resp = client.get("/api/settings/advanced")
    assert resp.status_code == 200
    data = resp.json()
    assert data["poll_label"] == "smokescreen"
    assert data["max_retries"] == 5
    assert data["rerequest_interval_days"] == 60
    assert data["dry_run"] is False
    assert data["ai_provider"] == "anthropic"
    assert data["anthropic_model"] == "claude-sonnet-4-20250514"
    assert data["gemini_model"] == "gemini-3.1-flash-lite"
    assert data["gemini_project"] == ""
    assert data["gemini_location"] == "global"
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


def test_put_settings_ai_provider_fields(settings_client):
    client, settings_file = settings_client
    resp = client.put(
        "/api/settings",
        json={
            "ai_provider": "gemini",
            "gemini_model": "gemini-3.1-flash-lite",
            "gemini_project": "vertex-project",
            "gemini_location": "global",
        },
    )
    assert resp.status_code == 200

    file_data = json.loads(settings_file.read_text())
    assert file_data["ai_provider"] == "gemini"
    assert file_data["gemini_model"] == "gemini-3.1-flash-lite"
    assert file_data["gemini_project"] == "vertex-project"
    assert file_data["gemini_location"] == "global"

    resp = client.get("/api/settings/advanced")
    assert resp.json()["ai_provider"] == "gemini"


def test_put_settings_rejects_unknown_ai_provider(settings_client):
    client, settings_file = settings_client
    resp = client.put("/api/settings", json={"ai_provider": "openai"})
    assert resp.status_code == 422
    assert not settings_file.exists()


def test_put_settings_restart_required_for_ui_field(settings_client):
    client, _ = settings_client
    resp = client.put(
        "/api/settings",
        json={"sender_email": "updated@example.com"},
    )
    assert resp.status_code == 200
    assert resp.json()["restart_required"] is True


@pytest.mark.parametrize(
    "field,value",
    [
        ("state_backend", "firestore"),
        ("sqlite_path", "/tmp/smokescreen.db"),
        ("firestore_project", "test-project"),
        ("firestore_collection", "test-collection"),
        ("gmail_credentials_path", "/tmp/credentials.json"),
        ("gmail_token_path", "/tmp/token.json"),
        ("gmail_oauth_interactive", False),
    ],
)
def test_put_settings_rejects_infrastructure_fields(settings_client, field, value):
    client, settings_file = settings_client
    resp = client.put("/api/settings", json={field: value})
    assert resp.status_code == 422
    assert not settings_file.exists()


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
