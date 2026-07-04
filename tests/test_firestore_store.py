"""Tests for the Firestore state store."""

from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime
from unittest.mock import MagicMock

from fastapi.testclient import TestClient

from smokescreen.api import app, init_app
from smokescreen.brokers.registry import BrokerRegistry
from smokescreen.config import Settings
from smokescreen.jobs.poll import _process_thread
from smokescreen.models import (
    Broker,
    BrokerStatus,
    EmailMessage,
    OptOutRecord,
    PendingWhitelistEntry,
    PendingWhitelistStatus,
    WhitelistEntry,
    WhitelistSource,
)
from smokescreen.state.firestore import FirestoreStore


class FakeDocumentSnapshot:
    def __init__(self, doc_id: str, data: dict | None) -> None:
        self.id = doc_id
        self._data = data
        self.exists = data is not None

    def to_dict(self) -> dict:
        return dict(self._data or {})


class FakeDocumentReference:
    def __init__(self, collection: FakeCollectionReference, doc_id: str) -> None:
        self._collection = collection
        self.id = doc_id

    def get(self, **_kwargs) -> FakeDocumentSnapshot:
        return FakeDocumentSnapshot(self.id, self._collection._docs.get(self.id))

    def set(self, data: dict, **kwargs) -> None:
        if kwargs.get("merge"):
            current = self._collection._docs.setdefault(self.id, {})
            current.update(data)
            return
        self._collection._docs[self.id] = dict(data)

    def update(self, data: dict) -> None:
        self._collection._docs[self.id].update(data)

    def delete(self) -> None:
        self._collection._docs.pop(self.id, None)


class FakeQuery:
    def __init__(
        self,
        collection: FakeCollectionReference,
        filters: list[tuple[str, str, object]] | None = None,
        limit_count: int | None = None,
        order_field: str | None = None,
    ) -> None:
        self._collection = collection
        self._filters = filters or []
        self._limit_count = limit_count
        self._order_field = order_field

    def where(self, field: str, op: str, value: object) -> FakeQuery:
        return FakeQuery(
            self._collection,
            [*self._filters, (field, op, value)],
            self._limit_count,
            self._order_field,
        )

    def limit(self, count: int) -> FakeQuery:
        return FakeQuery(
            self._collection,
            self._filters,
            count,
            self._order_field,
        )

    def order_by(self, field: str) -> FakeQuery:
        return FakeQuery(
            self._collection,
            self._filters,
            self._limit_count,
            field,
        )

    def stream(self):
        items = list(self._collection._docs.items())
        for field, op, value in self._filters:
            if op != "==":
                raise AssertionError(f"unsupported fake Firestore operator: {op}")
            items = [
                (doc_id, data) for doc_id, data in items if data.get(field) == value
            ]
        if self._order_field is not None:
            items.sort(key=lambda item: item[1].get(self._order_field))
        if self._limit_count is not None:
            items = items[: self._limit_count]
        return [FakeDocumentSnapshot(doc_id, data) for doc_id, data in items]


class FakeCollectionReference(FakeQuery):
    def __init__(self) -> None:
        self._docs: dict[str, dict] = {}
        super().__init__(self)

    def document(self, doc_id: str) -> FakeDocumentReference:
        return FakeDocumentReference(self, doc_id)


class FakeFirestoreClient:
    def __init__(self) -> None:
        self._collections: dict[str, FakeCollectionReference] = {}

    def collection(self, name: str) -> FakeCollectionReference:
        return self._collections.setdefault(name, FakeCollectionReference())


def _store() -> FirestoreStore:
    store = FirestoreStore(
        "test-project", "test_opt_outs", client=FakeFirestoreClient()
    )
    counters = defaultdict(int)

    def next_id(counter_name: str) -> int:
        counters[counter_name] += 1
        return counters[counter_name]

    store._next_id = next_id
    return store


def _mock_anthropic(label: str) -> MagicMock:
    client = MagicMock()
    content_block = MagicMock()
    content_block.text = label
    client.messages.create.return_value = MagicMock(content=[content_block])
    return client


def test_firestore_broker_selections_track_empty_document():
    store = _store()

    assert store.has_enabled_broker_selections() is False

    stored = store.set_enabled_brokers([])

    assert stored == []
    assert store.has_enabled_broker_selections() is True
    assert store.list_enabled_brokers() == []


def test_firestore_upsert_persists_last_completed_at():
    store = _store()
    now = datetime.now(UTC)

    store.upsert(
        OptOutRecord(
            broker_id="spokeo",
            status=BrokerStatus.COMPLETED,
            last_completed_at=now,
        )
    )

    fetched = store.get("spokeo")
    assert fetched is not None
    assert fetched.status == BrokerStatus.COMPLETED
    assert fetched.last_completed_at == now


def test_firestore_whitelist_crud_and_registry_sync():
    store = _store()
    broker = Broker(
        id="spokeo",
        name="Spokeo",
        domain="spokeo.com",
        privacy_email="privacy@spokeo.com",
    )

    store.sync_registry_whitelist([broker])
    assert store.is_whitelisted("privacy@spokeo.com")

    manual = store.add_whitelist(
        WhitelistEntry(broker_id="spokeo", email="reply@spokeo.com")
    )
    entries = store.list_whitelist()
    assert {entry.email for entry in entries} == {
        "privacy@spokeo.com",
        "reply@spokeo.com",
    }
    registry_entry = next(e for e in entries if e.email == "privacy@spokeo.com")
    assert registry_entry.source == WhitelistSource.REGISTRY

    store.delete_whitelist(manual.id)
    assert not store.is_whitelisted("reply@spokeo.com")


def test_firestore_add_whitelist_upserts_by_email():
    store = _store()
    store.add_whitelist(
        WhitelistEntry(
            broker_id="spokeo",
            email="privacy@spokeo.com",
            source=WhitelistSource.REGISTRY,
        )
    )

    updated = store.add_whitelist(
        WhitelistEntry(broker_id="spokeo-v2", email="privacy@spokeo.com")
    )

    entries = store.list_whitelist()
    assert len(entries) == 1
    assert entries[0].id == updated.id
    assert entries[0].broker_id == "spokeo-v2"
    assert entries[0].source == WhitelistSource.MANUAL


def test_firestore_pending_approve_and_reject():
    store = _store()
    pending = store.add_pending_whitelist(
        PendingWhitelistEntry(
            broker_id="spokeo",
            email="noreply@spokeo.com",
            message_subject="Verify identity",
        )
    )
    rejected = store.add_pending_whitelist(PendingWhitelistEntry(email="spam@test.com"))

    approved = store.approve_pending(pending.id)
    assert approved is not None
    assert approved.email == "noreply@spokeo.com"
    assert store.is_whitelisted("noreply@spokeo.com")
    assert store.reject_pending(rejected.id)

    approved_entries = store.list_pending_whitelist(PendingWhitelistStatus.APPROVED)
    rejected_entries = store.list_pending_whitelist(PendingWhitelistStatus.REJECTED)
    assert [entry.email for entry in approved_entries] == ["noreply@spokeo.com"]
    assert [entry.email for entry in rejected_entries] == ["spam@test.com"]


def test_firestore_add_pending_whitelist_returns_existing_pending_email():
    store = _store()
    first = store.add_pending_whitelist(
        PendingWhitelistEntry(
            broker_id="spokeo",
            email="noreply@spokeo.com",
            message_subject="Verify identity",
        )
    )

    second = store.add_pending_whitelist(
        PendingWhitelistEntry(
            broker_id="spokeo",
            email="noreply@spokeo.com",
            message_subject="Verify identity again",
        )
    )

    entries = store.list_pending_whitelist(PendingWhitelistStatus.PENDING)
    assert second.id == first.id
    assert len(entries) == 1
    assert entries[0].message_subject == "Verify identity"


def test_dashboard_whitelist_endpoints_with_firestore_store():
    store = _store()
    registry = BrokerRegistry(
        [
            Broker(
                id="spokeo",
                name="Spokeo",
                domain="spokeo.com",
                privacy_email="privacy@spokeo.com",
            )
        ]
    )
    init_app(store, registry)
    client = TestClient(app)

    resp = client.get("/api/whitelist")
    assert resp.status_code == 200
    assert resp.json()[0]["email"] == "privacy@spokeo.com"

    resp = client.post(
        "/api/whitelist",
        json={"broker_id": "spokeo", "email": "reply@spokeo.com"},
    )
    assert resp.status_code == 201
    entry_id = resp.json()["id"]

    resp = client.delete(f"/api/whitelist/{entry_id}")
    assert resp.status_code == 204
    assert not store.is_whitelisted("reply@spokeo.com")


def test_poll_adds_pending_whitelist_for_firestore_store():
    class FakeGmail:
        def get_thread(self, _thread_id):
            return [
                EmailMessage(
                    message_id="msg-2",
                    thread_id="thread-1",
                    sender="verify@spokeo.com",
                    subject="Verify identity",
                    body="Please verify your identity",
                )
            ]

    store = _store()
    record = OptOutRecord(
        broker_id="spokeo",
        status=BrokerStatus.INITIAL_SENT,
        thread_id="thread-1",
        last_message_id="msg-1",
    )

    processed = _process_thread(
        settings=Settings(
            sender_email="me@example.com",
            sender_name="Me",
            ai_provider="anthropic",
            dry_run=True,
        ),
        record=record,
        broker_name="Spokeo",
        broker_email="privacy@spokeo.com",
        store=store,
        gmail=FakeGmail(),
        ai_client=None,
    )

    assert processed is True
    pending = store.list_pending_whitelist(PendingWhitelistStatus.PENDING)
    assert len(pending) == 1
    assert pending[0].email == "verify@spokeo.com"
    updated = store.get("spokeo")
    assert updated.status == BrokerStatus.NEEDS_MANUAL
    assert (
        updated.notes
        == "Reply received from untrusted sender verify@spokeo.com - "
        "approve in Trusted Senders if legitimate"
    )


def test_poll_updates_firestore_record_for_completed_reply():
    class FakeGmail:
        def get_thread(self, _thread_id):
            return [
                EmailMessage(
                    message_id="msg-2",
                    thread_id="thread-1",
                    sender="privacy@spokeo.com",
                    subject="Complete",
                    body="Your opt-out request has been completed.",
                )
            ]

    store = _store()
    record = OptOutRecord(
        broker_id="spokeo",
        status=BrokerStatus.AWAITING_RESPONSE,
        thread_id="thread-1",
        last_message_id="msg-1",
    )
    store.upsert(record)
    store.add_whitelist(WhitelistEntry(broker_id="spokeo", email="privacy@spokeo.com"))

    processed = _process_thread(
        settings=Settings(
            sender_email="me@example.com",
            sender_name="Me",
            ai_provider="anthropic",
            dry_run=True,
        ),
        record=record,
        broker_name="Spokeo",
        broker_email="privacy@spokeo.com",
        store=store,
        gmail=FakeGmail(),
        ai_client=_mock_anthropic("COMPLETED"),
    )

    assert processed is True
    updated = store.get("spokeo")
    assert updated.status == BrokerStatus.COMPLETED
    assert updated.last_message_id == "msg-2"
    assert updated.last_completed_at is not None
