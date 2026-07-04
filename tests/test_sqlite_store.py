"""Tests for the SQLite state store."""

import tempfile
from pathlib import Path

import pytest

from smokescreen.models import BrokerStatus, OptOutRecord
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
