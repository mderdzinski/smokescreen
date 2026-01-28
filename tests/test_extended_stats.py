"""Tests for the extended stats endpoint."""

from datetime import datetime, timedelta

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
        Broker(
            id="whitepages",
            name="Whitepages",
            domain="whitepages.com",
            privacy_email="privacy@whitepages.com",
        ),
    ]


@pytest.fixture
def client(tmp_path):
    store = SQLiteStore(tmp_path / "test.db")
    registry = BrokerRegistry(_make_brokers())
    settings = Settings(sender_email="test@example.com", sender_name="Test")
    init_app(store, registry, settings)
    yield TestClient(app), store
    store.close()


def test_extended_stats_empty(client):
    c, _ = client
    resp = c.get("/api/stats/extended")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 0
    assert data["completed_count"] == 0
    assert data["success_rate"] == 0.0
    assert data["avg_completion_hours"] is None
    assert data["needs_attention"] == 0
    assert data["recent_activity"] == []


def test_extended_stats_with_records(client):
    c, store = client
    now = datetime.utcnow()

    store.upsert(
        OptOutRecord(
            broker_id="spokeo",
            status=BrokerStatus.COMPLETED,
            created_at=now - timedelta(hours=48),
        )
    )
    store.upsert(
        OptOutRecord(
            broker_id="beenverified",
            status=BrokerStatus.NEEDS_MANUAL,
        )
    )
    store.upsert(
        OptOutRecord(
            broker_id="whitepages",
            status=BrokerStatus.FAILED,
        )
    )

    resp = c.get("/api/stats/extended")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 3
    assert data["completed_count"] == 1
    assert data["success_rate"] == pytest.approx(33.3, abs=0.1)
    assert data["avg_completion_hours"] is not None
    assert data["needs_attention"] == 2
    assert len(data["recent_activity"]) == 3


def test_extended_stats_by_status(client):
    c, store = client
    store.upsert(OptOutRecord(broker_id="spokeo", status=BrokerStatus.COMPLETED))
    store.upsert(OptOutRecord(broker_id="beenverified", status=BrokerStatus.COMPLETED))
    store.upsert(OptOutRecord(broker_id="whitepages", status=BrokerStatus.PENDING))

    resp = c.get("/api/stats/extended")
    data = resp.json()
    assert data["by_status"]["COMPLETED"] == 2
    assert data["by_status"]["PENDING"] == 1
    assert data["success_rate"] == pytest.approx(66.7, abs=0.1)


def test_extended_stats_activity_feed_order(client):
    c, store = client
    now = datetime.utcnow()

    # Insert records with explicit timestamps via direct SQL to avoid model_post_init
    old_time = (now - timedelta(hours=2)).isoformat()
    recent_time = (now - timedelta(minutes=5)).isoformat()

    store._conn.execute(
        "INSERT INTO opt_outs (broker_id, status, retries,"
        " created_at, updated_at, notes) VALUES (?, ?, ?, ?, ?, ?)",
        ("spokeo", "PENDING", 0, old_time, old_time, ""),
    )
    store._conn.execute(
        "INSERT INTO opt_outs (broker_id, status, retries,"
        " created_at, updated_at, notes) VALUES (?, ?, ?, ?, ?, ?)",
        ("beenverified", "COMPLETED", 0, recent_time, recent_time, ""),
    )
    store._conn.commit()

    resp = c.get("/api/stats/extended")
    data = resp.json()
    activity = data["recent_activity"]
    assert len(activity) == 2
    # Most recent first
    assert activity[0]["broker_id"] == "beenverified"
    assert activity[1]["broker_id"] == "spokeo"
