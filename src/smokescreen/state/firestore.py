"""Firestore implementation of StateStore for cloud deployment."""

from __future__ import annotations

from datetime import datetime
from typing import Any

import structlog
from google.cloud import firestore

from smokescreen.models import (
    BrokerStatus,
    OptOutRecord,
    PendingWhitelistEntry,
    PendingWhitelistStatus,
    ProfileGapLedgerEntry,
    StateTransition,
    ThreadHistoryEntry,
    VerificationProfile,
    WhitelistEntry,
    WhitelistSource,
    as_aware_utc,
    parse_broker_status,
    utc_now,
)
from smokescreen.state.selection_size import (
    broker_selection_document,
    broker_selection_size_warning,
    estimate_broker_selection_document_size_bytes,
)

log = structlog.get_logger()


class FirestoreStore:
    """Firestore-backed state store.

    Collection structure:
    - {collection}/{broker_id} documents for opt-out state.
    - {collection}_email_whitelist/{id} for approved sender emails.
    - {collection}_pending_whitelist/{id} for senders awaiting approval.
    - {collection}_meta/counters for monotonically increasing integer IDs.
    - profile_gap_ledger/{broker_id}__{field_name} for broker-requested
      verification profile fields the user has not populated yet.
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
        self._profile_gap_collection = "profile_gap_ledger"

    def _ref(self, broker_id: str):
        return self._db.collection(self._collection).document(broker_id)

    def _collection_ref(self, name: str):
        return self._db.collection(name)

    def _doc_id(self, entry_id: int) -> str:
        return str(entry_id)

    def _profile_gap_doc_id(self, broker_id: str, field_name: str) -> str:
        return f"{broker_id}__{field_name}"

    def _profile_gap_ref(self, broker_id: str, field_name: str):
        return self._collection_ref(self._profile_gap_collection).document(
            self._profile_gap_doc_id(broker_id, field_name)
        )

    def _next_id(self, counter_name: str) -> int:
        counter_ref = self._collection_ref(self._meta_collection).document("counters")

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
            return as_aware_utc(default) if default is not None else utc_now()
        if isinstance(value, datetime):
            return as_aware_utc(value)
        if isinstance(value, str):
            return as_aware_utc(datetime.fromisoformat(value))
        return value

    def _optional_datetime(self, value: Any) -> datetime | None:
        if value is None:
            return None
        return self._datetime_or_default(value)

    def _string_list(self, value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        return [item for item in value if isinstance(item, str)]

    def _state_history(self, value: Any) -> list[StateTransition]:
        if not isinstance(value, list):
            return []

        transitions: list[StateTransition] = []
        for item in value:
            if not isinstance(item, dict):
                continue
            try:
                transitions.append(StateTransition.model_validate(item))
            except ValueError:
                continue
        return transitions

    def _thread_history(self, value: Any) -> list[ThreadHistoryEntry]:
        if not isinstance(value, list):
            return []

        history: list[ThreadHistoryEntry] = []
        for item in value:
            if not isinstance(item, dict):
                continue
            try:
                history.append(ThreadHistoryEntry.model_validate(item))
            except ValueError:
                continue
        return history

    def _doc_to_record(self, broker_id: str, data: dict) -> OptOutRecord:
        return OptOutRecord(
            broker_id=broker_id,
            status=parse_broker_status(data["status"]),
            previous_status=(
                parse_broker_status(data["previous_status"])
                if data.get("previous_status")
                else None
            ),
            retries=data.get("retries", 0),
            thread_id=data.get("thread_id"),
            thread_ids=self._string_list(data.get("thread_ids")),
            last_message_id=data.get("last_message_id"),
            created_at=self._datetime_or_default(data.get("created_at")),
            updated_at=self._datetime_or_default(data.get("updated_at")),
            last_completed_at=self._optional_datetime(data.get("last_completed_at")),
            notes=data.get("notes", ""),
            needs_manual_reason=data.get("needs_manual_reason"),
            requested_fields=self._string_list(data.get("requested_fields")),
            missing_fields=self._string_list(data.get("missing_fields")),
            requested_other_details=data.get("requested_other_details", ""),
            state_history=self._state_history(data.get("state_history")),
            thread_history=self._thread_history(data.get("thread_history")),
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

    def _doc_to_profile_gap(self, doc) -> ProfileGapLedgerEntry:
        data = doc.to_dict()
        return ProfileGapLedgerEntry(
            broker_id=data["broker_id"],
            field_name=data["field_name"],
            first_asked_at=self._datetime_or_default(data.get("first_asked_at")),
            last_asked_at=self._datetime_or_default(data.get("last_asked_at")),
            ask_count=int(data.get("ask_count", 1)),
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
                "previous_status": (
                    record.previous_status.value if record.previous_status else None
                ),
                "retries": record.retries,
                "thread_id": record.thread_id,
                "thread_ids": record.thread_ids,
                "last_message_id": record.last_message_id,
                "created_at": record.created_at,
                "updated_at": record.updated_at,
                "last_completed_at": record.last_completed_at,
                "notes": record.notes,
                "needs_manual_reason": (
                    record.needs_manual_reason.model_dump(mode="json")
                    if record.needs_manual_reason
                    else None
                ),
                "requested_fields": record.requested_fields,
                "missing_fields": record.missing_fields,
                "requested_other_details": record.requested_other_details,
                "state_history": [
                    transition.model_dump(mode="json")
                    for transition in record.state_history
                ],
                "thread_history": [
                    entry.model_dump(mode="json") for entry in record.thread_history
                ],
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

    def _verification_profile_ref(self):
        return self._collection_ref(self._meta_collection).document(
            "verification_profile"
        )

    def list_enabled_brokers(self) -> list[str]:
        doc = self._broker_selections_ref().get()
        if not doc.exists:
            return []
        data = doc.to_dict() or {}
        raw = data.get("enabled_broker_ids") or []
        return [str(item) for item in raw if isinstance(item, str)]

    def has_enabled_broker_selections(self) -> bool:
        return self._broker_selections_ref().get().exists

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

        updated_at = utc_now().isoformat()
        warning = broker_selection_size_warning(normalized, updated_at)
        if warning:
            log.warning(
                "broker_selections_size_warning",
                message=warning,
                size_bytes=estimate_broker_selection_document_size_bytes(
                    normalized, updated_at
                ),
            )

        self._broker_selections_ref().set(
            broker_selection_document(normalized, updated_at)
        )
        return normalized

    # --- Verification profile ---

    def get_verification_profile(self) -> VerificationProfile:
        doc = self._verification_profile_ref().get()
        if not doc.exists:
            return VerificationProfile()
        data = doc.to_dict() or {}
        return VerificationProfile.model_validate(data.get("profile") or {})

    def set_verification_profile(
        self, profile: VerificationProfile
    ) -> VerificationProfile:
        normalized = VerificationProfile.model_validate(profile.model_dump())
        self._verification_profile_ref().set(
            {"profile": normalized.model_dump(), "updated_at": utc_now().isoformat()}
        )
        return normalized

    # --- Profile gap ledger ---

    def record_profile_gap(
        self,
        broker_id: str,
        field_name: str,
        asked_at: datetime | None = None,
    ) -> ProfileGapLedgerEntry:
        normalized_broker_id = broker_id.strip()
        normalized_field_name = field_name.strip()
        if not normalized_broker_id or not normalized_field_name:
            raise ValueError("broker_id and field_name are required")

        asked = as_aware_utc(asked_at) if asked_at is not None else utc_now()
        ref = self._profile_gap_ref(normalized_broker_id, normalized_field_name)
        doc = ref.get()
        if doc.exists:
            data = doc.to_dict() or {}
            first_asked_at = self._datetime_or_default(
                data.get("first_asked_at"), asked
            )
            ask_count = int(data.get("ask_count", 0)) + 1
        else:
            first_asked_at = asked
            ask_count = 1

        ref.set(
            {
                "broker_id": normalized_broker_id,
                "field_name": normalized_field_name,
                "first_asked_at": first_asked_at,
                "last_asked_at": asked,
                "ask_count": ask_count,
            }
        )
        return self._doc_to_profile_gap(ref.get())

    def list_profile_gap_ledger(self) -> list[ProfileGapLedgerEntry]:
        docs = self._collection_ref(self._profile_gap_collection).stream()
        return [self._doc_to_profile_gap(doc) for doc in docs]
