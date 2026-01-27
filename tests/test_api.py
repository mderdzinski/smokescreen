"""Tests for the FastAPI dashboard API."""

import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from smokescreen.api import app, init_app
from smokescreen.brokers.registry import BrokerRegistry
from smokescreen.models import Broker, BrokerStatus, OptOutRecord
from smokescreen.state.sqlite import SQLiteStore


@pytest.fixture
def client():
    with tempfile.NamedTemporaryFile(suffix=".db") as f:
        store = SQLiteStore(Path(f.name))
        brokers = [
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
        registry = BrokerRegistry(brokers)
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
    resp = client.put("/api/brokers/spokeo", json={"name": "Spokeo Updated"})
    assert resp.status_code == 200
    assert resp.json()["name"] == "Spokeo Updated"


def test_update_broker_not_found(client):
    resp = client.put("/api/brokers/nonexistent", json={"name": "X"})
    assert resp.status_code == 404


def test_delete_broker(client):
    resp = client.delete("/api/brokers/spokeo")
    assert resp.status_code == 204

    resp = client.get("/api/brokers")
    ids = {b["id"] for b in resp.json()}
    assert "spokeo" not in ids


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
