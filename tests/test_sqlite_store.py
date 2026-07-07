"""Tests for the SQLite state store."""

import sqlite3
import tempfile
from datetime import UTC, datetime
from pathlib import Path

import pytest

from smokescreen.models import (
    BrokerStatus,
    NeedsManualReason,
    OptOutRecord,
    StateTransition,
    VerificationAddress,
    VerificationDocument,
    VerificationProfile,
)
from smokescreen.state.sqlite import SQLiteStore


@pytest.fixture
def store():
    with tempfile.NamedTemporaryFile(suffix=".db") as f:
        s = SQLiteStore(Path(f.name))
        yield s
        s.close()


def test_get_nonexistent(store):
    assert store.get("nonexistent") is None


def test_upsert_and_get(store):
    record = OptOutRecord(broker_id="spokeo", status=BrokerStatus.PENDING)
    store.upsert(record)

    fetched = store.get("spokeo")
    assert fetched is not None
    assert fetched.broker_id == "spokeo"
    assert fetched.status == BrokerStatus.PENDING


def test_upsert_updates(store):
    record = OptOutRecord(broker_id="spokeo", status=BrokerStatus.PENDING)
    store.upsert(record)

    record.status = BrokerStatus.INITIAL_SENT
    record.thread_id = "thread-123"
    store.upsert(record)

    fetched = store.get("spokeo")
    assert fetched.status == BrokerStatus.INITIAL_SENT
    assert fetched.thread_id == "thread-123"


def test_upsert_persists_info_request_metadata(store):
    record = OptOutRecord(
        broker_id="spokeo",
        status=BrokerStatus.NEEDS_MANUAL,
        previous_status=BrokerStatus.INFO_REQUESTED,
        needs_manual_reason=NeedsManualReason(
            reason_code="info_request_missing_fields",
            short_summary="Broker requested missing information.",
            broker_reply_excerpt="Please send a phone number.",
            classifier_output={
                "classification": "INFO_REQUEST",
                "requested_fields": ["home_address", "documents"],
                "other_details": "",
            },
            missing_fields=["documents"],
        ),
        requested_fields=["home_address", "documents"],
        missing_fields=["documents"],
        requested_other_details="Signed form",
    )
    store.upsert(record)

    fetched = store.get("spokeo")
    assert fetched is not None
    assert fetched.previous_status == BrokerStatus.INFO_REQUESTED
    assert fetched.needs_manual_reason is not None
    assert fetched.needs_manual_reason.reason_code == "info_request_missing_fields"
    assert fetched.needs_manual_reason.missing_fields == ["documents"]
    assert (
        fetched.needs_manual_reason.classifier_output["classification"]
        == "INFO_REQUEST"
    )
    assert fetched.requested_fields == ["home_address", "documents"]
    assert fetched.missing_fields == ["documents"]
    assert fetched.requested_other_details == "Signed form"


def test_upsert_persists_state_history(store):
    transitioned_at = datetime(2026, 7, 7, 15, 45, tzinfo=UTC)
    record = OptOutRecord(
        broker_id="spokeo",
        status=BrokerStatus.INITIAL_SENT,
        state_history=[
            StateTransition(
                from_status="PENDING",
                to_status="INITIAL_SENT",
                transitioned_at=transitioned_at,
                reason="initial opt-out request sent",
                message_id="sent-1",
            )
        ],
    )

    store.upsert(record)

    fetched = store.get("spokeo")
    assert fetched is not None
    assert len(fetched.state_history) == 1
    transition = fetched.state_history[0]
    assert transition.from_status == "PENDING"
    assert transition.to_status == "INITIAL_SENT"
    assert transition.transitioned_at == transitioned_at
    assert transition.reason == "initial opt-out request sent"
    assert transition.message_id == "sent-1"


def test_existing_sqlite_records_without_state_history_load_empty(tmp_path):
    db_path = tmp_path / "legacy.db"
    conn = sqlite3.connect(db_path)
    conn.execute("""
        CREATE TABLE opt_outs (
            broker_id TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            retries INTEGER NOT NULL DEFAULT 0,
            thread_id TEXT,
            last_message_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_completed_at TEXT,
            notes TEXT NOT NULL DEFAULT '',
            needs_manual_reason TEXT,
            previous_status TEXT,
            requested_fields TEXT NOT NULL DEFAULT '[]',
            missing_fields TEXT NOT NULL DEFAULT '[]',
            requested_other_details TEXT NOT NULL DEFAULT ''
        )
    """)
    conn.execute(
        """
        INSERT INTO opt_outs (
            broker_id, status, created_at, updated_at, requested_fields,
            missing_fields, requested_other_details
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "legacy",
            BrokerStatus.NEEDS_MANUAL.value,
            "2026-07-07T15:00:00+00:00",
            "2026-07-07T15:30:00+00:00",
            "[]",
            "[]",
            "",
        ),
    )
    conn.commit()
    conn.close()

    migrated_store = SQLiteStore(db_path)

    fetched = migrated_store.get("legacy")
    assert fetched is not None
    assert fetched.state_history == []
    migrated_store.close()


def test_list_all(store):
    store.upsert(OptOutRecord(broker_id="a"))
    store.upsert(OptOutRecord(broker_id="b"))
    store.upsert(OptOutRecord(broker_id="c"))

    records = store.list_all()
    assert len(records) == 3
    assert [r.broker_id for r in records] == ["a", "b", "c"]


def test_list_by_status(store):
    store.upsert(OptOutRecord(broker_id="a", status=BrokerStatus.PENDING))
    store.upsert(OptOutRecord(broker_id="b", status=BrokerStatus.COMPLETED))
    store.upsert(OptOutRecord(broker_id="c", status=BrokerStatus.PENDING))

    pending = store.list_by_status(BrokerStatus.PENDING)
    assert len(pending) == 2
    assert {r.broker_id for r in pending} == {"a", "c"}


def test_delete(store):
    store.upsert(OptOutRecord(broker_id="spokeo"))
    store.delete("spokeo")
    assert store.get("spokeo") is None


# --- Broker selections ---


def test_broker_selections_default_empty(store):
    """Fresh install must have no brokers enabled — safety default."""
    assert store.has_enabled_broker_selections() is False
    assert store.list_enabled_brokers() == []


def test_broker_selections_persist_and_normalize(store):
    stored = store.set_enabled_brokers(["spokeo", "beenverified", "spokeo", "  "])
    # Deduplicated, whitespace-stripped, and sorted for a stable read.
    assert stored == ["beenverified", "spokeo"]
    assert store.has_enabled_broker_selections() is True
    assert store.list_enabled_brokers() == ["beenverified", "spokeo"]


def test_broker_selections_replace_semantics(store):
    store.set_enabled_brokers(["spokeo", "beenverified"])
    store.set_enabled_brokers(["radaris"])
    assert store.list_enabled_brokers() == ["radaris"]


def test_broker_selections_can_be_cleared(store):
    store.set_enabled_brokers(["spokeo"])
    stored = store.set_enabled_brokers([])
    assert stored == []
    assert store.has_enabled_broker_selections() is True
    assert store.list_enabled_brokers() == []


def test_verification_profile_default_and_persist(store):
    assert store.get_verification_profile() == VerificationProfile()

    profile = VerificationProfile(
        home_addresses=[
            VerificationAddress(
                street="1 Main St",
                city="Springfield",
                state="CA",
                zip="90210",
                country="US",
            )
        ],
        phone_numbers=["+1 555 0100"],
        email_aliases=["old@example.com"],
        date_of_birth="1990-01-01",
        last_four_ssn="1234",
        employer_name="Acme",
    )

    stored = store.set_verification_profile(profile)

    assert stored == profile
    assert store.get_verification_profile() == profile


def test_profile_documents_field_persists(store):
    profile = VerificationProfile(
        documents=[
            VerificationDocument(
                label="Utility Bill",
                storage_note="Offline file cabinet",
            ),
            VerificationDocument(
                label="Driver License",
                storage_note="Physical wallet",
            ),
        ],
    )

    assert store.set_verification_profile(profile) == profile
    assert store.get_verification_profile() == profile
