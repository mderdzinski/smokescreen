"""State machine for broker opt-out workflow."""

from __future__ import annotations

from smokescreen.models import BrokerStatus

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
TRANSITIONS: dict[BrokerStatus, set[BrokerStatus]] = {
    BrokerStatus.PENDING: {BrokerStatus.INITIAL_SENT, BrokerStatus.FAILED},
    BrokerStatus.INITIAL_SENT: {
        BrokerStatus.INITIAL_SENT_PINGED,
        BrokerStatus.AWAITING_RESPONSE,
        BrokerStatus.INFO_REQUESTED,
        BrokerStatus.FAILED,
    },
    BrokerStatus.INITIAL_SENT_PINGED: {
        BrokerStatus.AWAITING_RESPONSE,
        BrokerStatus.INFO_REQUESTED,
        BrokerStatus.NEEDS_MANUAL,
        BrokerStatus.FAILED,
    },
    BrokerStatus.AWAITING_RESPONSE: {
        BrokerStatus.AWAITING_RESPONSE_PINGED,
        BrokerStatus.INFO_REQUESTED,
        BrokerStatus.COMPLETED,
        BrokerStatus.REJECTED,
        BrokerStatus.NEEDS_MANUAL,
        BrokerStatus.FAILED,
    },
    BrokerStatus.AWAITING_RESPONSE_PINGED: {
        BrokerStatus.INFO_REQUESTED,
        BrokerStatus.COMPLETED,
        BrokerStatus.REJECTED,
        BrokerStatus.NEEDS_MANUAL,
        BrokerStatus.FAILED,
    },
    BrokerStatus.INFO_REQUESTED: {
        BrokerStatus.INFO_REQUESTED_PINGED,
        BrokerStatus.FOLLOW_UP_SENT,
        BrokerStatus.NEEDS_MANUAL,
        BrokerStatus.FAILED,
    },
    BrokerStatus.INFO_REQUESTED_PINGED: {
        BrokerStatus.FOLLOW_UP_SENT,
        BrokerStatus.NEEDS_MANUAL,
        BrokerStatus.FAILED,
    },
    BrokerStatus.FOLLOW_UP_SENT: {
        BrokerStatus.FOLLOW_UP_SENT_PINGED,
        BrokerStatus.AWAITING_RESPONSE,
        BrokerStatus.NEEDS_MANUAL,
        BrokerStatus.FAILED,
    },
    BrokerStatus.FOLLOW_UP_SENT_PINGED: {
        BrokerStatus.AWAITING_RESPONSE,
        BrokerStatus.NEEDS_MANUAL,
        BrokerStatus.FAILED,
    },
    # Terminal states (COMPLETED allows re-request back to PENDING)
    BrokerStatus.COMPLETED: {BrokerStatus.PENDING},
    BrokerStatus.REJECTED: set(),
    BrokerStatus.FAILED: set(),
    BrokerStatus.NEEDS_MANUAL: {
        BrokerStatus.PENDING,  # allow manual reset
        BrokerStatus.COMPLETED,
        BrokerStatus.FAILED,
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
