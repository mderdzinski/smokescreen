"""Tests for email whitelist logic and storage."""

import tempfile
from pathlib import Path

import pytest

from smokescreen.models import (
    PendingWhitelistEntry,
    PendingWhitelistStatus,
    WhitelistEntry,
    WhitelistSource,
)
from smokescreen.state.sqlite import SQLiteStore


@pytest.fixture
def store():
    with tempfile.NamedTemporaryFile(suffix=".db") as f:
        s = SQLiteStore(Path(f.name))
        yield s
        s.close()


# --- WhitelistEntry CRUD ---


def test_add_and_list_whitelist(store):
    entry = WhitelistEntry(broker_id="spokeo", email="privacy@spokeo.com")
    result = store.add_whitelist(entry)
    assert result.id is not None

    entries = store.list_whitelist()
    assert len(entries) == 1
    assert entries[0].email == "privacy@spokeo.com"
    assert entries[0].broker_id == "spokeo"
    assert entries[0].source == WhitelistSource.MANUAL


def test_is_whitelisted(store):
    assert not store.is_whitelisted("privacy@spokeo.com")
    store.add_whitelist(WhitelistEntry(broker_id="spokeo", email="privacy@spokeo.com"))
    assert store.is_whitelisted("privacy@spokeo.com")


def test_delete_whitelist(store):
    entry = store.add_whitelist(
        WhitelistEntry(broker_id="spokeo", email="privacy@spokeo.com")
    )
    store.delete_whitelist(entry.id)
    assert not store.is_whitelisted("privacy@spokeo.com")
    assert len(store.list_whitelist()) == 0


def test_add_whitelist_upsert_on_conflict(store):
    store.add_whitelist(
        WhitelistEntry(
            broker_id="spokeo",
            email="privacy@spokeo.com",
            source=WhitelistSource.REGISTRY,
        )
    )
    store.add_whitelist(
        WhitelistEntry(
            broker_id="spokeo-v2",
            email="privacy@spokeo.com",
            source=WhitelistSource.MANUAL,
        )
    )
    entries = store.list_whitelist()
    assert len(entries) == 1
    assert entries[0].broker_id == "spokeo-v2"


def test_sync_registry_whitelist(store):
    from smokescreen.models import Broker

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
    store.sync_registry_whitelist(brokers)
    entries = store.list_whitelist()
    assert len(entries) == 2
    assert all(e.source == WhitelistSource.REGISTRY for e in entries)


# --- PendingWhitelistEntry CRUD ---


def test_add_and_list_pending(store):
    entry = PendingWhitelistEntry(
        broker_id="spokeo",
        email="noreply@spokeo.com",
        message_subject="Re: Data Deletion",
        message_snippet="Please verify your identity",
    )
    result = store.add_pending_whitelist(entry)
    assert result.id is not None

    entries = store.list_pending_whitelist()
    assert len(entries) == 1
    assert entries[0].email == "noreply@spokeo.com"
    assert entries[0].status == PendingWhitelistStatus.PENDING


def test_list_pending_by_status(store):
    store.add_pending_whitelist(
        PendingWhitelistEntry(email="a@test.com", status=PendingWhitelistStatus.PENDING)
    )
    store.add_pending_whitelist(
        PendingWhitelistEntry(
            email="b@test.com", status=PendingWhitelistStatus.APPROVED
        )
    )

    pending = store.list_pending_whitelist(PendingWhitelistStatus.PENDING)
    assert len(pending) == 1
    assert pending[0].email == "a@test.com"


def test_approve_pending(store):
    entry = store.add_pending_whitelist(
        PendingWhitelistEntry(
            broker_id="spokeo",
            email="noreply@spokeo.com",
            message_subject="Re: Data Deletion",
        )
    )

    result = store.approve_pending(entry.id)
    assert result is not None
    assert result.email == "noreply@spokeo.com"
    assert store.is_whitelisted("noreply@spokeo.com")

    # Check pending entry updated to approved
    entries = store.list_pending_whitelist(PendingWhitelistStatus.APPROVED)
    assert len(entries) == 1


def test_approve_pending_not_found(store):
    result = store.approve_pending(999)
    assert result is None


def test_reject_pending(store):
    entry = store.add_pending_whitelist(PendingWhitelistEntry(email="spam@test.com"))

    assert store.reject_pending(entry.id)
    assert not store.is_whitelisted("spam@test.com")

    entries = store.list_pending_whitelist(PendingWhitelistStatus.REJECTED)
    assert len(entries) == 1


def test_reject_pending_not_found(store):
    assert not store.reject_pending(999)
