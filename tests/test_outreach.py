"""Tests for the outreach job."""

from unittest.mock import MagicMock

from smokescreen.brokers.registry import BrokerRegistry
from smokescreen.config import Settings
from smokescreen.jobs.outreach import run_outreach
from smokescreen.models import BrokerStatus, EmailMessage, OptOutRecord
from smokescreen.state.sqlite import SQLiteStore


def _make_settings(**kwargs) -> Settings:
    defaults = {
        "sender_email": "test@example.com",
        "sender_name": "Test User",
        "dry_run": True,
    }
    defaults.update(kwargs)
    return Settings(**defaults)


def test_outreach_dry_run(tmp_path):
    settings = _make_settings(sqlite_path=tmp_path / "test.db")
    registry = BrokerRegistry.from_yaml()
    store = SQLiteStore(settings.sqlite_path)
    store.set_enabled_brokers(["spokeo"])

    processed = run_outreach(settings, registry, store, gmail=None)

    assert processed == ["spokeo"]
    record = store.get("spokeo")
    assert record.status == BrokerStatus.INITIAL_SENT
    assert record.thread_id == "dry-run-thread-spokeo"
    assert record.last_message_id == "dry-run-message-spokeo"
    store.close()


def test_outreach_skips_non_pending(tmp_path):
    settings = _make_settings(sqlite_path=tmp_path / "test.db")
    registry = BrokerRegistry.from_yaml()
    store = SQLiteStore(settings.sqlite_path)
    store.set_enabled_brokers(["spokeo"])

    # Pre-set spokeo to COMPLETED
    store.upsert(OptOutRecord(broker_id="spokeo", status=BrokerStatus.COMPLETED))

    processed = run_outreach(settings, registry, store, gmail=None)

    assert "spokeo" not in processed
    store.close()


def test_outreach_sends_email(tmp_path):
    settings = _make_settings(sqlite_path=tmp_path / "test.db", dry_run=False)

    # Only use one broker for simplicity
    from smokescreen.models import Broker

    broker = Broker(
        id="test-broker",
        name="Test Broker",
        domain="test.com",
        privacy_email="privacy@test.com",
    )
    registry = BrokerRegistry([broker])
    store = SQLiteStore(settings.sqlite_path)
    store.set_enabled_brokers(["test-broker"])

    mock_gmail = MagicMock()
    mock_gmail.send.return_value = EmailMessage(
        message_id="msg-1",
        thread_id="thread-1",
        sender="test@example.com",
        to="privacy@test.com",
        subject="Personal Data Deletion Request - Test User",
        body="test",
    )

    processed = run_outreach(settings, registry, store, gmail=mock_gmail)

    assert "test-broker" in processed
    mock_gmail.send.assert_called_once()

    record = store.get("test-broker")
    assert record.status == BrokerStatus.INITIAL_SENT
    assert record.thread_id == "thread-1"
    store.close()


def test_outreach_skipped_when_no_brokers_enabled(tmp_path):
    """Empty enabled-list must skip outreach entirely: safety default."""
    settings = _make_settings(sqlite_path=tmp_path / "test.db")
    registry = BrokerRegistry.from_yaml()
    store = SQLiteStore(settings.sqlite_path)

    # Do NOT call set_enabled_brokers — this is the fresh-install state.
    processed = run_outreach(settings, registry, store, gmail=None)

    assert processed == []
    # No records were created either.
    assert store.get("spokeo") is None
    store.close()


def test_outreach_only_sends_to_enabled_subset(tmp_path):
    """Only brokers in the enabled list get outreach, not the full registry."""
    settings = _make_settings(sqlite_path=tmp_path / "test.db")
    registry = BrokerRegistry.from_yaml()
    store = SQLiteStore(settings.sqlite_path)
    store.set_enabled_brokers(["spokeo"])

    processed = run_outreach(settings, registry, store, gmail=None)

    assert processed == ["spokeo"]
    assert store.get("spokeo") is not None
    # A non-enabled broker from brokers.yaml must not have a record.
    assert store.get("beenverified") is None
    store.close()


def test_outreach_bypasses_gate_when_enforce_selections_false(tmp_path):
    """Explicit filter path (e.g. one-shot API send) bypasses the persisted gate."""
    settings = _make_settings(sqlite_path=tmp_path / "test.db")
    from smokescreen.models import Broker

    broker = Broker(
        id="only-broker",
        name="Only",
        domain="only.example",
        privacy_email="p@only.example",
    )
    registry = BrokerRegistry([broker])
    store = SQLiteStore(settings.sqlite_path)
    # Note: no set_enabled_brokers call.

    processed = run_outreach(
        settings, registry, store, gmail=None, enforce_selections=False
    )

    assert processed == ["only-broker"]
    store.close()
