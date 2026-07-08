"""State machine for broker opt-out workflow."""

from __future__ import annotations

from datetime import datetime

from smokescreen.models import (
    BrokerStatus,
    OptOutRecord,
    StateTransition,
    ThreadHistoryEntry,
    as_aware_utc,
    utc_now,
)

# States that expect a broker reply. If they remain unchanged for
# `state_timeout_days`, the poll job pings once (transitioning to the paired
# *_PINGED state) and after a second silent period escalates to NEEDS_MANUAL.
WAITING_STATES: set[BrokerStatus] = {
    BrokerStatus.INITIAL_SENT,
    BrokerStatus.AWAITING_RESPONSE,
    BrokerStatus.INFO_REQUESTED,
    BrokerStatus.FOLLOW_UP_SENT,
}


# Pairs a waiting state with the state a first-timeout ping transitions it to.
PINGED_STATE: dict[BrokerStatus, BrokerStatus] = {
    BrokerStatus.INITIAL_SENT: BrokerStatus.INITIAL_SENT_PINGED,
    BrokerStatus.AWAITING_RESPONSE: BrokerStatus.AWAITING_RESPONSE_PINGED,
    BrokerStatus.INFO_REQUESTED: BrokerStatus.INFO_REQUESTED_PINGED,
    BrokerStatus.FOLLOW_UP_SENT: BrokerStatus.FOLLOW_UP_SENT_PINGED,
}


# Explicit transition table: current_state -> set of valid next states
TERMINAL_OR_ATTENTION_STATES: set[BrokerStatus] = {
    BrokerStatus.COMPLETED,
    BrokerStatus.REJECTED,
    BrokerStatus.FAILED,
    BrokerStatus.NEEDS_MANUAL,
}

RETRYABLE_MANUAL_STATES: set[BrokerStatus] = {
    BrokerStatus.INITIAL_SENT,
    BrokerStatus.INITIAL_SENT_PINGED,
    BrokerStatus.AWAITING_RESPONSE,
    BrokerStatus.AWAITING_RESPONSE_PINGED,
    BrokerStatus.INFO_REQUESTED,
    BrokerStatus.INFO_REQUESTED_PINGED,
    BrokerStatus.FOLLOW_UP_SENT,
    BrokerStatus.FOLLOW_UP_SENT_PINGED,
    BrokerStatus.REJECTED_REBUTTED,
}

INFO_REQUEST_STATES: set[BrokerStatus] = {
    BrokerStatus.INFO_REQUESTED,
    BrokerStatus.INFO_REQUESTED_PINGED,
}

POST_OUTREACH_IN_FLIGHT_STATES: set[BrokerStatus] = {
    BrokerStatus.AWAITING_RESPONSE,
    BrokerStatus.AWAITING_RESPONSE_PINGED,
    BrokerStatus.INFO_REQUESTED,
    BrokerStatus.INFO_REQUESTED_PINGED,
    BrokerStatus.FOLLOW_UP_SENT,
    BrokerStatus.FOLLOW_UP_SENT_PINGED,
    BrokerStatus.REJECTED_REBUTTED,
}


def _post_outreach_targets() -> set[BrokerStatus]:
    targets = set(POST_OUTREACH_IN_FLIGHT_STATES)
    targets.update(TERMINAL_OR_ATTENTION_STATES)
    return targets


TRANSITIONS: dict[BrokerStatus, set[BrokerStatus]] = {
    BrokerStatus.PENDING: {BrokerStatus.INITIAL_SENT, BrokerStatus.FAILED},
    BrokerStatus.INITIAL_SENT: {
        BrokerStatus.INITIAL_SENT_PINGED,
        BrokerStatus.AWAITING_RESPONSE,
        *INFO_REQUEST_STATES,
        BrokerStatus.REJECTED_REBUTTED,
        *TERMINAL_OR_ATTENTION_STATES,
    },
    BrokerStatus.INITIAL_SENT_PINGED: {
        BrokerStatus.AWAITING_RESPONSE,
        *INFO_REQUEST_STATES,
        BrokerStatus.REJECTED_REBUTTED,
        *TERMINAL_OR_ATTENTION_STATES,
    },
    BrokerStatus.AWAITING_RESPONSE: _post_outreach_targets(),
    BrokerStatus.AWAITING_RESPONSE_PINGED: _post_outreach_targets(),
    BrokerStatus.INFO_REQUESTED: _post_outreach_targets(),
    BrokerStatus.INFO_REQUESTED_PINGED: _post_outreach_targets(),
    BrokerStatus.FOLLOW_UP_SENT: _post_outreach_targets(),
    BrokerStatus.FOLLOW_UP_SENT_PINGED: _post_outreach_targets(),
    BrokerStatus.REJECTED_REBUTTED: _post_outreach_targets(),
    # Terminal states (COMPLETED allows re-request back to PENDING)
    BrokerStatus.COMPLETED: {BrokerStatus.PENDING},
    BrokerStatus.REJECTED: set(),
    BrokerStatus.FAILED: set(),
    BrokerStatus.NEEDS_MANUAL: {
        BrokerStatus.PENDING,  # allow manual reset
        BrokerStatus.COMPLETED,
        BrokerStatus.REJECTED,
        BrokerStatus.FAILED,
        *RETRYABLE_MANUAL_STATES,
    },
}


class InvalidTransition(Exception):
    """Raised when a state transition is not allowed."""

    def __init__(self, current: BrokerStatus, target: BrokerStatus) -> None:
        super().__init__(f"Cannot transition from {current.value} to {target.value}")
        self.current = current
        self.target = target


def validate_transition(current: BrokerStatus, target: BrokerStatus) -> None:
    """Raise InvalidTransition if the transition is not allowed."""
    allowed = TRANSITIONS.get(current, set())
    if target not in allowed:
        raise InvalidTransition(current, target)


def _status_value(status: BrokerStatus | str) -> str:
    if isinstance(status, BrokerStatus):
        return status.value
    return str(status)


def current_thread_ids(record: OptOutRecord) -> list[str]:
    """Return the current-cycle Gmail thread IDs with scalar legacy fallback."""
    return _dedupe_thread_ids([*(record.thread_ids or []), record.thread_id or ""])


def primary_thread_id(record: OptOutRecord) -> str | None:
    """Return the compatibility primary thread ID for replies."""
    if record.thread_id:
        return record.thread_id
    ids = current_thread_ids(record)
    return ids[0] if ids else None


def set_current_thread(record: OptOutRecord, thread_id: str | None) -> None:
    """Replace current-cycle thread tracking with one new primary thread."""
    if not thread_id:
        record.thread_id = None
        record.thread_ids = []
        return
    record.thread_id = thread_id
    record.thread_ids = [thread_id]


def append_current_thread(record: OptOutRecord, thread_id: str) -> bool:
    """Append a validated current-cycle thread without replacing the primary."""
    thread_id = thread_id.strip()
    if not thread_id:
        return False

    ids = current_thread_ids(record)
    if thread_id in ids:
        record.thread_ids = ids
        if record.thread_id is None:
            record.thread_id = ids[0]
        return False

    if record.thread_id is None:
        record.thread_id = thread_id
    record.thread_ids = [*ids, thread_id]
    return True


def clear_current_threads(record: OptOutRecord) -> None:
    """Clear current-cycle thread tracking."""
    record.thread_id = None
    record.thread_ids = []


def current_cycle_started_at(record: OptOutRecord) -> datetime:
    """Return the best known start time for the current outreach cycle."""
    pending_to_initial = [
        as_aware_utc(transition.transitioned_at)
        for transition in record.state_history
        if transition.from_status == BrokerStatus.PENDING.value
        and transition.to_status == BrokerStatus.INITIAL_SENT.value
    ]
    if pending_to_initial:
        return max(pending_to_initial)

    initial_sent = [
        as_aware_utc(transition.transitioned_at)
        for transition in record.state_history
        if transition.to_status == BrokerStatus.INITIAL_SENT.value
    ]
    if initial_sent:
        return max(initial_sent)

    if record.created_at is not None:
        return as_aware_utc(record.created_at)
    if record.updated_at is not None:
        return as_aware_utc(record.updated_at)
    return utc_now()


def snapshot_current_cycle(
    record: OptOutRecord,
    *,
    ended_at: datetime,
    final_status: BrokerStatus | str | None = None,
) -> ThreadHistoryEntry | None:
    """Move current-cycle thread IDs into immutable prior-cycle history."""
    thread_ids = current_thread_ids(record)
    if not thread_ids:
        clear_current_threads(record)
        return None

    entry = ThreadHistoryEntry(
        cycle_number=len(record.thread_history) + 1,
        thread_ids=thread_ids,
        started_at=current_cycle_started_at(record),
        ended_at=ended_at,
        final_status=_status_value(final_status or record.status),
    )
    record.thread_history.append(entry)
    clear_current_threads(record)
    return entry


def _dedupe_thread_ids(values: list[str]) -> list[str]:
    ids: list[str] = []
    seen: set[str] = set()
    for raw in values:
        if not isinstance(raw, str):
            continue
        value = raw.strip()
        if not value or value in seen:
            continue
        seen.add(value)
        ids.append(value)
    return ids


def append_transition(
    record: OptOutRecord,
    from_status: BrokerStatus | str,
    to_status: BrokerStatus | str,
    *,
    allow_noop: bool = False,
    reason: str | None = None,
    message_id: str | None = None,
    transitioned_at: datetime | None = None,
) -> StateTransition | None:
    """Append a history entry for a real status transition."""
    from_value = _status_value(from_status)
    to_value = _status_value(to_status)
    if from_value == to_value and not allow_noop:
        return None

    transition = StateTransition(
        from_status=from_value,
        to_status=to_value,
        transitioned_at=transitioned_at or utc_now(),
        reason=reason,
        message_id=message_id if message_id is not None else record.last_message_id,
    )
    record.state_history.append(transition)
    return transition


def transition_record_status(
    record: OptOutRecord,
    target: BrokerStatus,
    *,
    reason: str | None = None,
    message_id: str | None = None,
    transitioned_at: datetime | None = None,
    validate: bool = True,
) -> StateTransition | None:
    """Set a record status and persist the transition history entry."""
    current = record.status
    if validate and current != target:
        validate_transition(current, target)

    record.status = target
    return append_transition(
        record,
        current,
        target,
        reason=reason,
        message_id=message_id,
        transitioned_at=transitioned_at,
    )
