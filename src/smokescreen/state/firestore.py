"""Firestore implementation of StateStore for cloud deployment."""

from __future__ import annotations

from datetime import datetime

from google.cloud import firestore

from smokescreen.models import BrokerStatus, OptOutRecord


class FirestoreStore:
    """Firestore-backed state store.

    Collection structure: {collection}/{broker_id} documents.
    """

    def __init__(self, project: str, collection: str = "opt_outs") -> None:
        self._db = firestore.Client(project=project)
        self._collection = collection

    def _ref(self, broker_id: str):
        return self._db.collection(self._collection).document(broker_id)

    def _doc_to_record(self, broker_id: str, data: dict) -> OptOutRecord:
        return OptOutRecord(
            broker_id=broker_id,
            status=BrokerStatus(data["status"]),
            retries=data.get("retries", 0),
            thread_id=data.get("thread_id"),
            last_message_id=data.get("last_message_id"),
            created_at=data.get("created_at", datetime.utcnow()),
            updated_at=data.get("updated_at", datetime.utcnow()),
            notes=data.get("notes", ""),
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
                "notes": record.notes,
            }
        )

    def delete(self, broker_id: str) -> None:
        self._ref(broker_id).delete()
