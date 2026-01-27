"""StateStore protocol — backend-agnostic interface for opt-out records."""

from __future__ import annotations

from typing import Protocol

from smokescreen.models import BrokerStatus, OptOutRecord


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
