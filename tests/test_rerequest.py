"""Tests for re-request frequency configuration and logic."""

from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest
from pydantic import ValidationError

from smokescreen.brokers.registry import BrokerRegistry
from smokescreen.config import Settings
from smokescreen.jobs.outreach import _check_rerequest, run_outreach
from smokescreen.models import Broker, BrokerStatus, OptOutRecord
from smokescreen.state.sqlite import SQLiteStore


def _make_settings(**kwargs) -> Settings:
    defaults = {
        "sender_email": "test@example.com",
        "sender_name": "Test User",
        "dry_run": True,
    }
    defaults.update(kwargs)
    return Settings(**defaults)


# --- _check_rerequest unit tests ---


def test_check_rerequest_not_completed():
    record = OptOutRecord(broker_id="a", status=BrokerStatus.PENDING)
    assert _check_rerequest(record, 60) is False


def test_check_rerequest_skips_terminal_rejected():
    record = OptOutRecord(
        broker_id="a",
        status=BrokerStatus.REJECTED,
        updated_at=datetime.utcnow() - timedelta(days=90),
    )
    assert _check_rerequest(record, 60) is False


def test_check_rerequest_completed_not_due():
    record = OptOutRecord(
        broker_id="a",
        status=BrokerStatus.COMPLETED,
        last_completed_at=datetime.utcnow() - timedelta(days=10),
    )
    assert _check_rerequest(record, 60) is False


def test_check_rerequest_completed_due():
    record = OptOutRecord(
        broker_id="a",
        status=BrokerStatus.COMPLETED,
        last_completed_at=datetime.utcnow() - timedelta(days=61),
    )
    assert _check_rerequest(record, 60) is True


def test_check_rerequest_skips_when_no_last_completed():
    record = OptOutRecord(
        broker_id="a",
        status=BrokerStatus.COMPLETED,
        last_completed_at=None,
    )
    # Force updated_at to be old enough
    record.updated_at = datetime.utcnow() - timedelta(days=90)
    with patch("smokescreen.jobs.outreach.log.warning") as warning:
        assert _check_rerequest(record, 60) is False
    warning.assert_called_once()
    assert warning.call_args.args == ("rerequest_missing_last_completed_at",)


# --- Integration: outreach re-request ---


def test_outreach_rerequests_completed_broker(tmp_path):
    settings = _make_settings(
        sqlite_path=tmp_path / "test.db",
        rerequest_interval_days=30,
    )
    broker = Broker(
        id="test-broker",
        name="Test Broker",
        domain="test.com",
        privacy_email="privacy@test.com",
    )
    registry = BrokerRegistry([broker])
    store = SQLiteStore(settings.sqlite_path)
    store.set_enabled_brokers(["test-broker"])

    # Seed a completed record that's past the re-request interval
    record = OptOutRecord(
        broker_id="test-broker",
        status=BrokerStatus.COMPLETED,
        last_completed_at=datetime.utcnow() - timedelta(days=31),
    )
    record.updated_at = datetime.utcnow() - timedelta(days=31)
    store.upsert(record)

    processed = run_outreach(settings, registry, store, gmail=None)

    assert "test-broker" in processed
    updated = store.get("test-broker")
    assert updated.status == BrokerStatus.INITIAL_SENT
    assert updated.thread_id == "dry-run-thread-test-broker"
    assert updated.thread_ids == ["dry-run-thread-test-broker"]
    assert updated.last_message_id == "dry-run-message-test-broker"
    store.close()


def test_outreach_skips_recently_completed(tmp_path):
    settings = _make_settings(
        sqlite_path=tmp_path / "test.db",
        rerequest_interval_days=60,
    )
    broker = Broker(
        id="test-broker",
        name="Test Broker",
        domain="test.com",
        privacy_email="privacy@test.com",
    )
    registry = BrokerRegistry([broker])
    store = SQLiteStore(settings.sqlite_path)
    store.set_enabled_brokers(["test-broker"])

    # Seed a recently completed record
    record = OptOutRecord(
        broker_id="test-broker",
        status=BrokerStatus.COMPLETED,
        last_completed_at=datetime.utcnow() - timedelta(days=10),
    )
    store.upsert(record)

    processed = run_outreach(settings, registry, store, gmail=None)

    assert "test-broker" not in processed
    assert store.get("test-broker").status == BrokerStatus.COMPLETED
    store.close()


# --- Model field test ---


def test_opt_out_record_last_completed_at_default():
    record = OptOutRecord(broker_id="a")
    assert record.last_completed_at is None


# --- Config test ---


def test_settings_rerequest_interval_default():
    s = Settings(sender_email="t@t.com", sender_name="T")
    # sm-aa1: product default is now monthly (30 days).
    assert s.rerequest_interval_days == 30


def test_settings_rerequest_interval_custom():
    s = Settings(sender_email="t@t.com", sender_name="T", rerequest_interval_days=30)
    assert s.rerequest_interval_days == 30


# --- Bounds enforced by Settings config validation (sm-274) ---


@pytest.mark.parametrize("value", [7, 60, 365])
def test_settings_rerequest_interval_accepts_boundary(value):
    s = Settings(sender_email="t@t.com", sender_name="T", rerequest_interval_days=value)
    assert s.rerequest_interval_days == value


@pytest.mark.parametrize("value", [0, 1, 6, 366, 1000])
def test_settings_rerequest_interval_rejects_out_of_bounds(value):
    with pytest.raises(ValidationError):
        Settings(sender_email="t@t.com", sender_name="T", rerequest_interval_days=value)


# --- Outreach at the bound values (sm-274) ---


def _boundary_setup(tmp_path, interval_days: int):
    settings = _make_settings(
        sqlite_path=tmp_path / "test.db",
        rerequest_interval_days=interval_days,
    )
    broker = Broker(
        id="edge-broker",
        name="Edge Broker",
        domain="edge.com",
        privacy_email="privacy@edge.com",
    )
    registry = BrokerRegistry([broker])
    store = SQLiteStore(settings.sqlite_path)
    store.set_enabled_brokers(["edge-broker"])
    return settings, registry, store


def test_outreach_rerequests_at_minimum_interval_bound(tmp_path):
    """A completed record 8 days old is due for re-request when interval=7."""
    settings, registry, store = _boundary_setup(tmp_path, interval_days=7)
    record = OptOutRecord(
        broker_id="edge-broker",
        status=BrokerStatus.COMPLETED,
        last_completed_at=datetime.utcnow() - timedelta(days=8),
    )
    record.updated_at = datetime.utcnow() - timedelta(days=8)
    store.upsert(record)

    processed = run_outreach(settings, registry, store, gmail=None)

    assert "edge-broker" in processed
    assert store.get("edge-broker").status == BrokerStatus.INITIAL_SENT
    store.close()


def test_outreach_holds_within_maximum_interval_bound(tmp_path):
    """A completed record 300 days old is NOT due when interval=365."""
    settings, registry, store = _boundary_setup(tmp_path, interval_days=365)
    record = OptOutRecord(
        broker_id="edge-broker",
        status=BrokerStatus.COMPLETED,
        last_completed_at=datetime.utcnow() - timedelta(days=300),
    )
    record.updated_at = datetime.utcnow() - timedelta(days=300)
    store.upsert(record)

    processed = run_outreach(settings, registry, store, gmail=None)

    assert "edge-broker" not in processed
    assert store.get("edge-broker").status == BrokerStatus.COMPLETED
    store.close()


# --- SQLite round-trip ---


def test_sqlite_last_completed_at_persisted(tmp_path):
    store = SQLiteStore(tmp_path / "test.db")
    now = datetime.now(UTC)
    record = OptOutRecord(
        broker_id="a", status=BrokerStatus.COMPLETED, last_completed_at=now
    )
    store.upsert(record)

    fetched = store.get("a")
    assert fetched.last_completed_at is not None
    # Compare to second precision (isoformat round-trip)
    assert abs((fetched.last_completed_at - now).total_seconds()) < 1
    store.close()


def test_sqlite_last_completed_at_null(tmp_path):
    store = SQLiteStore(tmp_path / "test.db")
    record = OptOutRecord(broker_id="a")
    store.upsert(record)

    fetched = store.get("a")
    assert fetched.last_completed_at is None
    store.close()


# --- state_timeout_days config (sm-aa1) ---


def test_settings_state_timeout_default_is_14_days():
    s = Settings(sender_email="t@t.com", sender_name="T")
    assert s.state_timeout_days == 14


@pytest.mark.parametrize("value", [1, 14, 90])
def test_settings_state_timeout_accepts_boundary(value):
    s = Settings(sender_email="t@t.com", sender_name="T", state_timeout_days=value)
    assert s.state_timeout_days == value


@pytest.mark.parametrize("value", [0, -1, 91, 365])
def test_settings_state_timeout_rejects_out_of_bounds(value):
    with pytest.raises(ValidationError):
        Settings(sender_email="t@t.com", sender_name="T", state_timeout_days=value)


# --- Legacy stored status round-trip (sm-aa1) ---


def test_sqlite_reads_legacy_identity_status(tmp_path):
    """A stored record with the pre-sm-aa1 IDENTITY_SENT status value is
    surfaced to callers as FOLLOW_UP_SENT so the machinery keeps working."""
    import sqlite3

    store = SQLiteStore(tmp_path / "legacy.db")
    # Bypass the enum coercion path by writing the legacy value directly.
    now = datetime.utcnow().isoformat()
    store._conn.execute(
        """
        INSERT INTO opt_outs (
            broker_id, status, retries, thread_id, last_message_id,
            created_at, updated_at, last_completed_at, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        ("legacy", "IDENTITY_SENT", 0, None, None, now, now, None, ""),
    )
    store._conn.commit()

    fetched = store.get("legacy")
    assert fetched is not None
    assert fetched.status == BrokerStatus.FOLLOW_UP_SENT
    store.close()

    # sqlite3 imported above to sanity-check sqlite3 stays intact; unused
    # otherwise, so keep it referenced to avoid a ruff warning.
    del sqlite3
