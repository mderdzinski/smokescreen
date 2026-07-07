"""Tests for the outreach job."""

from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch

from smokescreen.brokers.registry import (
    TEST_BROKER_EMAIL_ENV,
    TEST_BROKER_ENABLED_ENV,
    BrokerRegistry,
)
from smokescreen.config import Settings
from smokescreen.jobs.outreach import run_outreach
from smokescreen.models import Broker, BrokerStatus, EmailMessage, OptOutRecord
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
    assert len(record.state_history) == 1
    transition = record.state_history[0]
    assert transition.from_status == "PENDING"
    assert transition.to_status == "INITIAL_SENT"
    assert transition.reason == "initial opt-out request sent"
    assert transition.message_id == "dry-run-message-spokeo"
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
    mock_gmail.label_thread.assert_called_once_with("thread-1", "smokescreen")

    record = store.get("test-broker")
    assert record.status == BrokerStatus.INITIAL_SENT
    assert record.thread_id == "thread-1"
    assert len(record.state_history) == 1
    transition = record.state_history[0]
    assert transition.from_status == "PENDING"
    assert transition.to_status == "INITIAL_SENT"
    assert transition.reason == "initial opt-out request sent"
    assert transition.message_id == "msg-1"
    store.close()


def test_outreach_labels_sent_thread_with_configured_poll_label(tmp_path):
    settings = _make_settings(
        sqlite_path=tmp_path / "test.db",
        dry_run=False,
        poll_label="privacy replies",
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

    assert processed == ["test-broker"]
    mock_gmail.label_thread.assert_called_once_with("thread-1", "privacy replies")
    store.close()


def test_outreach_label_failure_does_not_fail_send(tmp_path):
    settings = _make_settings(sqlite_path=tmp_path / "test.db", dry_run=False)
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
    mock_gmail.label_thread.side_effect = RuntimeError("gmail label outage")

    with patch("smokescreen.jobs.outreach.log.warning") as warning:
        processed = run_outreach(settings, registry, store, gmail=mock_gmail)

    assert processed == ["test-broker"]
    mock_gmail.send.assert_called_once()
    mock_gmail.label_thread.assert_called_once_with("thread-1", "smokescreen")
    warning.assert_called_once()
    assert warning.call_args.args == ("label_apply_failed",)
    assert warning.call_args.kwargs["broker"] == "test-broker"
    assert warning.call_args.kwargs["thread_id"] == "thread-1"
    assert warning.call_args.kwargs["label"] == "smokescreen"
    assert warning.call_args.kwargs["error"] == "gmail label outage"
    record = store.get("test-broker")
    assert record.status == BrokerStatus.INITIAL_SENT
    assert record.thread_id == "thread-1"
    assert record.last_message_id == "msg-1"
    store.close()


def test_synthetic_broker_enabled_by_default_for_outreach(tmp_path, monkeypatch):
    monkeypatch.setenv(TEST_BROKER_EMAIL_ENV, "operator+testbroker@gmail.com")
    monkeypatch.delenv(TEST_BROKER_ENABLED_ENV, raising=False)
    settings = _make_settings(sqlite_path=tmp_path / "test.db")
    registry = BrokerRegistry.from_yaml()
    store = SQLiteStore(settings.sqlite_path)

    processed = run_outreach(settings, registry, store, gmail=None)

    assert processed == ["testbroker"]
    record = store.get("testbroker")
    assert record is not None
    assert record.status == BrokerStatus.INITIAL_SENT
    store.close()


def test_synthetic_broker_enabled_false_requires_selection(tmp_path, monkeypatch):
    monkeypatch.setenv(TEST_BROKER_EMAIL_ENV, "operator+testbroker@gmail.com")
    monkeypatch.setenv(TEST_BROKER_ENABLED_ENV, "false")
    settings = _make_settings(sqlite_path=tmp_path / "test.db")
    registry = BrokerRegistry.from_yaml()
    store = SQLiteStore(settings.sqlite_path)

    assert run_outreach(settings, registry, store, gmail=None) == []

    store.set_enabled_brokers(["testbroker"])
    processed = run_outreach(settings, registry, store, gmail=None)

    assert processed == ["testbroker"]
    store.close()


def test_outreach_skips_disabled_broker_even_if_in_registry_default(
    tmp_path, monkeypatch
):
    monkeypatch.setenv(TEST_BROKER_EMAIL_ENV, "operator+testbroker@gmail.com")
    monkeypatch.delenv(TEST_BROKER_ENABLED_ENV, raising=False)
    settings = _make_settings(sqlite_path=tmp_path / "test.db")
    registry = BrokerRegistry.from_yaml()
    store = SQLiteStore(settings.sqlite_path)
    store.set_enabled_brokers([])

    processed = run_outreach(settings, registry, store, gmail=None)

    assert processed == []
    assert store.get("testbroker") is None
    store.close()


def test_outreach_reissues_completed_after_cadence(tmp_path):
    settings = _make_settings(
        sqlite_path=tmp_path / "test.db",
        dry_run=False,
        rerequest_interval_days=30,
    )
    broker = Broker(
        id="cadence-broker",
        name="Cadence Broker",
        domain="cadence.example",
        privacy_email="privacy@cadence.example",
    )
    registry = BrokerRegistry([broker])
    store = SQLiteStore(settings.sqlite_path)
    store.set_enabled_brokers(["cadence-broker"])
    now = datetime.now(UTC)
    last_completed_at = now - timedelta(days=31)
    store.upsert(
        OptOutRecord(
            broker_id="cadence-broker",
            status=BrokerStatus.COMPLETED,
            retries=3,
            thread_id="old-thread",
            last_message_id="old-message",
            last_completed_at=last_completed_at,
            updated_at=last_completed_at,
            notes="old completion",
        )
    )
    mock_gmail = MagicMock()
    mock_gmail.send.return_value = EmailMessage(
        message_id="new-message",
        thread_id="new-thread",
        sender=settings.sender_email,
        to=broker.privacy_email,
        subject="Personal Data Deletion Request - Test User",
        body="test",
    )

    processed = run_outreach(settings, registry, store, gmail=mock_gmail)

    assert processed == ["cadence-broker"]
    mock_gmail.send.assert_called_once()
    assert mock_gmail.send.call_args.kwargs["to"] == "privacy@cadence.example"
    record = store.get("cadence-broker")
    assert record.status == BrokerStatus.INITIAL_SENT
    assert record.retries == 0
    assert record.thread_id == "new-thread"
    assert record.last_message_id == "new-message"
    assert "Re-request after interval" in record.notes
    assert len(record.state_history) == 2
    assert record.state_history[0].from_status == "COMPLETED"
    assert record.state_history[0].to_status == "PENDING"
    assert record.state_history[0].reason == "re-request after interval"
    assert record.state_history[1].from_status == "PENDING"
    assert record.state_history[1].to_status == "INITIAL_SENT"
    assert record.state_history[1].message_id == "new-message"
    store.close()


def test_outreach_skips_completed_within_cadence(tmp_path):
    settings = _make_settings(
        sqlite_path=tmp_path / "test.db",
        dry_run=False,
        rerequest_interval_days=30,
    )
    broker = Broker(
        id="recent-broker",
        name="Recent Broker",
        domain="recent.example",
        privacy_email="privacy@recent.example",
    )
    registry = BrokerRegistry([broker])
    store = SQLiteStore(settings.sqlite_path)
    store.set_enabled_brokers(["recent-broker"])
    now = datetime.now(UTC)
    recent_completed_at = now - timedelta(days=7)
    store.upsert(
        OptOutRecord(
            broker_id="recent-broker",
            status=BrokerStatus.COMPLETED,
            retries=2,
            thread_id="recent-thread",
            last_message_id="recent-message",
            last_completed_at=recent_completed_at,
            updated_at=recent_completed_at,
            notes="recent completion",
        )
    )
    mock_gmail = MagicMock()

    processed = run_outreach(settings, registry, store, gmail=mock_gmail)

    assert processed == []
    mock_gmail.send.assert_not_called()
    record = store.get("recent-broker")
    assert record.status == BrokerStatus.COMPLETED
    assert record.retries == 2
    assert record.thread_id == "recent-thread"
    assert record.last_message_id == "recent-message"
    assert record.last_completed_at == recent_completed_at
    assert record.notes == "recent completion"
    store.close()


def test_outreach_skips_completed_missing_last_completed_at(tmp_path):
    settings = _make_settings(
        sqlite_path=tmp_path / "test.db",
        dry_run=False,
        rerequest_interval_days=30,
    )
    broker = Broker(
        id="legacy-broker",
        name="Legacy Broker",
        domain="legacy.example",
        privacy_email="privacy@legacy.example",
    )
    registry = BrokerRegistry([broker])
    store = SQLiteStore(settings.sqlite_path)
    store.set_enabled_brokers(["legacy-broker"])
    old_updated_at = datetime.now(UTC) - timedelta(days=90)
    store.upsert(
        OptOutRecord(
            broker_id="legacy-broker",
            status=BrokerStatus.COMPLETED,
            last_completed_at=None,
            updated_at=old_updated_at,
        )
    )
    mock_gmail = MagicMock()

    with patch("smokescreen.jobs.outreach.log.warning") as warning:
        processed = run_outreach(settings, registry, store, gmail=mock_gmail)

    assert processed == []
    mock_gmail.send.assert_not_called()
    warning.assert_called_once()
    assert warning.call_args.args == ("rerequest_missing_last_completed_at",)
    assert warning.call_args.kwargs["broker"] == "legacy-broker"
    record = store.get("legacy-broker")
    assert record.status == BrokerStatus.COMPLETED
    assert record.last_completed_at is None
    store.close()


def test_outreach_skipped_when_no_brokers_enabled(tmp_path):
    """Empty seeded enabled-list must skip outreach entirely."""
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
