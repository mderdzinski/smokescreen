"""StateStore protocol — backend-agnostic interface for opt-out records."""

from __future__ import annotations

from typing import Protocol

from smokescreen.models import (
    BrokerStatus,
    OptOutRecord,
    PendingWhitelistEntry,
    PendingWhitelistStatus,
    WhitelistEntry,
)


class StateStore(Protocol):
    """Interface for persisting opt-out records."""

    def get(self, broker_id: str) -> OptOutRecord | None:
        """Get record for a broker, or None if not tracked."""
        ...

    def list_all(self) -> list[OptOutRecord]:
        """List all tracked records."""
        ...

    def list_by_status(self, status: BrokerStatus) -> list[OptOutRecord]:
        """List records with a given status."""
        ...

    def upsert(self, record: OptOutRecord) -> None:
        """Create or update a record."""
        ...

    def delete(self, broker_id: str) -> None:
        """Delete a record."""
        ...

    def is_whitelisted(self, email: str) -> bool:
        """Return whether an email is approved for reply processing."""
        ...

    def list_whitelist(self) -> list[WhitelistEntry]:
        """List approved whitelist entries."""
        ...

    def add_whitelist(self, entry: WhitelistEntry) -> WhitelistEntry:
        """Create or update a whitelist entry."""
        ...

    def delete_whitelist(self, entry_id: int) -> None:
        """Delete a whitelist entry by ID."""
        ...

    def sync_registry_whitelist(self, brokers: list) -> None:
        """Sync broker registry privacy emails into the whitelist."""
        ...

    def list_pending_whitelist(
        self, status: PendingWhitelistStatus | None = None
    ) -> list[PendingWhitelistEntry]:
        """List pending whitelist entries."""
        ...

    def add_pending_whitelist(
        self, entry: PendingWhitelistEntry
    ) -> PendingWhitelistEntry:
        """Create a pending whitelist entry."""
        ...

    def approve_pending(self, entry_id: int) -> WhitelistEntry | None:
        """Approve a pending whitelist entry and return the whitelist row."""
        ...

    def reject_pending(self, entry_id: int) -> bool:
        """Reject a pending whitelist entry."""
        ...

    def list_enabled_brokers(self) -> list[str]:
        """Return the persisted list of broker IDs enabled for outreach.

        Missing selections documents are seeded from registry defaults by
        service logic before scheduled outreach reads this list. Implementations
        still return only persisted broker IDs here.
        """
        ...

    def has_enabled_broker_selections(self) -> bool:
        """Return whether the selections document exists, even if empty."""
        ...

    def set_enabled_brokers(self, broker_ids: list[str]) -> list[str]:
        """Persist the list of broker IDs enabled for outreach.

        Returns the stored list after normalization (deduplicated, ordered).
        """
        ...
