"""Firestore implementation of StateStore for cloud deployment."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from google.cloud import firestore

from smokescreen.models import (
    BrokerStatus,
    OptOutRecord,
    PendingWhitelistEntry,
    PendingWhitelistStatus,
    WhitelistEntry,
    WhitelistSource,
)


class FirestoreStore:
    """Firestore-backed state store.

    Collection structure:
    - {collection}/{broker_id} documents for opt-out state.
    - {collection}_email_whitelist/{id} for approved sender emails.
    - {collection}_pending_whitelist/{id} for senders awaiting approval.
    - {collection}_meta/counters for monotonically increasing integer IDs.
    """

    def __init__(
        self,
        project: str,
        collection: str = "opt_outs",
        client: Any | None = None,
    ) -> None:
        self._db = client or firestore.Client(project=project)
        self._collection = collection
        self._whitelist_collection = f"{collection}_email_whitelist"
        self._pending_whitelist_collection = f"{collection}_pending_whitelist"
        self._meta_collection = f"{collection}_meta"

    def _ref(self, broker_id: str):
        return self._db.collection(self._collection).document(broker_id)

    def _collection_ref(self, name: str):
        return self._db.collection(name)

    def _doc_id(self, entry_id: int) -> str:
        return str(entry_id)

    def _next_id(self, counter_name: str) -> int:
        counter_ref = self._collection_ref(self._meta_collection).document(
            "counters"
        )

        @firestore.transactional
        def _increment(transaction):
            snapshot = counter_ref.get(transaction=transaction)
            data = snapshot.to_dict() if snapshot.exists else {}
            next_id = int(data.get(counter_name, 0)) + 1
            transaction.set(counter_ref, {counter_name: next_id}, merge=True)
            return next_id

        return _increment(self._db.transaction())

    def _datetime_or_default(
        self, value: Any, default: datetime | None = None
    ) -> datetime:
        if value is None:
            return default or datetime.utcnow()
        if isinstance(value, datetime):
            return value
        if isinstance(value, str):
            return datetime.fromisoformat(value)
        return value

    def _optional_datetime(self, value: Any) -> datetime | None:
        if value is None:
            return None
        return self._datetime_or_default(value)

    def _doc_to_record(self, broker_id: str, data: dict) -> OptOutRecord:
        return OptOutRecord(
            broker_id=broker_id,
            status=BrokerStatus(data["status"]),
            retries=data.get("retries", 0),
            thread_id=data.get("thread_id"),
            last_message_id=data.get("last_message_id"),
            created_at=self._datetime_or_default(data.get("created_at")),
            updated_at=self._datetime_or_default(data.get("updated_at")),
            last_completed_at=self._optional_datetime(data.get("last_completed_at")),
            notes=data.get("notes", ""),
        )

    def _doc_to_whitelist_entry(self, doc) -> WhitelistEntry:
        data = doc.to_dict()
        return WhitelistEntry(
            id=int(data.get("id", doc.id)),
            broker_id=data["broker_id"],
            email=data["email"],
            source=WhitelistSource(data.get("source", WhitelistSource.MANUAL.value)),
            added_at=self._datetime_or_default(data.get("added_at")),
        )

    def _doc_to_pending_whitelist_entry(self, doc) -> PendingWhitelistEntry:
        data = doc.to_dict()
        return PendingWhitelistEntry(
            id=int(data.get("id", doc.id)),
            broker_id=data.get("broker_id"),
            email=data["email"],
            message_subject=data.get("message_subject", ""),
            message_snippet=data.get("message_snippet", ""),
            detected_at=self._datetime_or_default(data.get("detected_at")),
            status=PendingWhitelistStatus(
                data.get("status", PendingWhitelistStatus.PENDING.value)
            ),
        )

    def get(self, broker_id: str) -> OptOutRecord | None:
        doc = self._ref(broker_id).get()
        if not doc.exists:
            return None
        return self._doc_to_record(broker_id, doc.to_dict())

    def list_all(self) -> list[OptOutRecord]:
        docs = self._db.collection(self._collection).stream()
        return [self._doc_to_record(doc.id, doc.to_dict()) for doc in docs]

    def list_by_status(self, status: BrokerStatus) -> list[OptOutRecord]:
        docs = (
            self._db.collection(self._collection)
            .where("status", "==", status.value)
            .stream()
        )
        return [self._doc_to_record(doc.id, doc.to_dict()) for doc in docs]

    def upsert(self, record: OptOutRecord) -> None:
        self._ref(record.broker_id).set(
            {
                "status": record.status.value,
                "retries": record.retries,
                "thread_id": record.thread_id,
                "last_message_id": record.last_message_id,
                "created_at": record.created_at,
                "updated_at": record.updated_at,
                "last_completed_at": record.last_completed_at,
                "notes": record.notes,
            }
        )

    def delete(self, broker_id: str) -> None:
        self._ref(broker_id).delete()

    # --- Whitelist methods ---

    def is_whitelisted(self, email: str) -> bool:
        docs = (
            self._collection_ref(self._whitelist_collection)
            .where("email", "==", email)
            .limit(1)
            .stream()
        )
        return next(iter(docs), None) is not None

    def list_whitelist(self) -> list[WhitelistEntry]:
        docs = (
            self._collection_ref(self._whitelist_collection)
            .order_by("added_at")
            .stream()
        )
        return [self._doc_to_whitelist_entry(doc) for doc in docs]

    def add_whitelist(self, entry: WhitelistEntry) -> WhitelistEntry:
        existing = (
            self._collection_ref(self._whitelist_collection)
            .where("email", "==", entry.email)
            .limit(1)
            .stream()
        )
        existing_doc = next(iter(existing), None)
        if existing_doc:
            existing_data = existing_doc.to_dict()
            entry_id = int(existing_doc.id)
            entry.added_at = self._datetime_or_default(existing_data.get("added_at"))
        else:
            entry_id = self._next_id("whitelist")
        entry.id = entry_id
        self._collection_ref(self._whitelist_collection).document(
            self._doc_id(entry_id)
        ).set(
            {
                "id": entry_id,
                "broker_id": entry.broker_id,
                "email": entry.email,
                "source": entry.source.value,
                "added_at": entry.added_at,
            }
        )
        return entry

    def delete_whitelist(self, entry_id: int) -> None:
        self._collection_ref(self._whitelist_collection).document(
            self._doc_id(entry_id)
        ).delete()

    def sync_registry_whitelist(self, brokers: list) -> None:
        """Sync broker privacy emails from registry into whitelist."""
        for broker in brokers:
            if self.is_whitelisted(broker.privacy_email):
                continue
            self.add_whitelist(
                WhitelistEntry(
                    broker_id=broker.id,
                    email=broker.privacy_email,
                    source=WhitelistSource.REGISTRY,
                )
            )

    # --- Pending whitelist methods ---

    def list_pending_whitelist(
        self, status: PendingWhitelistStatus | None = None
    ) -> list[PendingWhitelistEntry]:
        query = self._collection_ref(self._pending_whitelist_collection)
        if status is not None:
            query = query.where("status", "==", status.value)
        docs = query.order_by("detected_at").stream()
        return [self._doc_to_pending_whitelist_entry(doc) for doc in docs]

    def add_pending_whitelist(
        self, entry: PendingWhitelistEntry
    ) -> PendingWhitelistEntry:
        existing = (
            self._collection_ref(self._pending_whitelist_collection)
            .where("email", "==", entry.email)
            .where("status", "==", entry.status.value)
            .limit(1)
            .stream()
        )
        existing_doc = next(iter(existing), None)
        if existing_doc:
            return self._doc_to_pending_whitelist_entry(existing_doc)

        entry_id = self._next_id("pending_whitelist")
        entry.id = entry_id
        self._collection_ref(self._pending_whitelist_collection).document(
            self._doc_id(entry_id)
        ).set(
            {
                "id": entry_id,
                "broker_id": entry.broker_id,
                "email": entry.email,
                "message_subject": entry.message_subject,
                "message_snippet": entry.message_snippet,
                "detected_at": entry.detected_at,
                "status": entry.status.value,
            }
        )
        return entry

    def approve_pending(self, entry_id: int) -> WhitelistEntry | None:
        ref = self._collection_ref(self._pending_whitelist_collection).document(
            self._doc_id(entry_id)
        )
        doc = ref.get()
        if not doc.exists:
            return None
        entry = self._doc_to_pending_whitelist_entry(doc)
        ref.update({"status": PendingWhitelistStatus.APPROVED.value})
        return self.add_whitelist(
            WhitelistEntry(
                broker_id=entry.broker_id or "",
                email=entry.email,
                source=WhitelistSource.MANUAL,
            )
        )

    def reject_pending(self, entry_id: int) -> bool:
        ref = self._collection_ref(self._pending_whitelist_collection).document(
            self._doc_id(entry_id)
        )
        doc = ref.get()
        if not doc.exists:
            return False
        ref.update({"status": PendingWhitelistStatus.REJECTED.value})
        return True

    # --- Broker selections ---

    def _broker_selections_ref(self):
        return self._collection_ref(self._meta_collection).document("broker_selections")

    def list_enabled_brokers(self) -> list[str]:
        doc = self._broker_selections_ref().get()
        if not doc.exists:
            return []
        data = doc.to_dict() or {}
        raw = data.get("enabled_broker_ids") or []
        return [str(item) for item in raw if isinstance(item, str)]

    def set_enabled_brokers(self, broker_ids: list[str]) -> list[str]:
        normalized: list[str] = []
        seen: set[str] = set()
        for raw in broker_ids:
            broker_id = raw.strip()
            if not broker_id or broker_id in seen:
                continue
            seen.add(broker_id)
            normalized.append(broker_id)
        normalized.sort()

        self._broker_selections_ref().set(
            {
                "enabled_broker_ids": normalized,
                "updated_at": datetime.utcnow().isoformat(),
            }
        )
        return normalized
