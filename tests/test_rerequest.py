"""Tests for re-request frequency configuration and logic."""

from datetime import datetime, timedelta

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


def test_check_rerequest_uses_updated_at_when_no_last_completed():
    record = OptOutRecord(
        broker_id="a",
        status=BrokerStatus.COMPLETED,
        last_completed_at=None,
    )
    # Force updated_at to be old enough
    record.updated_at = datetime.utcnow() - timedelta(days=90)
    assert _check_rerequest(record, 60) is True


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
    assert s.rerequest_interval_days == 60


def test_settings_rerequest_interval_custom():
    s = Settings(sender_email="t@t.com", sender_name="T", rerequest_interval_days=30)
    assert s.rerequest_interval_days == 30


# --- SQLite round-trip ---


def test_sqlite_last_completed_at_persisted(tmp_path):
    store = SQLiteStore(tmp_path / "test.db")
    now = datetime.utcnow()
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
