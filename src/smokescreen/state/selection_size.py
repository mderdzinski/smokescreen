"""Broker selection document size helpers."""

from __future__ import annotations

import json

BROKER_SELECTION_WARNING_THRESHOLD_BYTES = 500 * 1024


def broker_selection_document(
    enabled_broker_ids: list[str], updated_at: str | None = None
) -> dict[str, object]:
    """Return the Firestore broker selection document shape."""
    document: dict[str, object] = {"enabled_broker_ids": enabled_broker_ids}
    if updated_at is not None:
        document["updated_at"] = updated_at
    return document


def estimate_broker_selection_document_size_bytes(
    enabled_broker_ids: list[str], updated_at: str | None = None
) -> int:
    """Estimate serialized broker selection document size.

    Firestore does not store JSON directly, but compact JSON is a stable,
    conservative approximation for the single-list metadata document.
    """
    payload = json.dumps(
        broker_selection_document(enabled_broker_ids, updated_at),
        separators=(",", ":"),
        sort_keys=True,
    )
    return len(payload.encode("utf-8"))


def broker_selection_size_warning(
    enabled_broker_ids: list[str],
    updated_at: str | None = None,
    *,
    threshold_bytes: int = BROKER_SELECTION_WARNING_THRESHOLD_BYTES,
) -> str | None:
    size_bytes = estimate_broker_selection_document_size_bytes(
        enabled_broker_ids, updated_at
    )
    if size_bytes < threshold_bytes:
        return None
    return (
        "Broker selection document is "
        f"{size_bytes:,} bytes, approaching the 1 MiB Firestore document limit."
    )
