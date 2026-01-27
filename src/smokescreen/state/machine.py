"""State machine for broker opt-out workflow."""

from __future__ import annotations

from smokescreen.models import BrokerStatus

# Explicit transition table: current_state -> set of valid next states
TRANSITIONS: dict[BrokerStatus, set[BrokerStatus]] = {
    BrokerStatus.PENDING: {BrokerStatus.INITIAL_SENT, BrokerStatus.FAILED},
    BrokerStatus.INITIAL_SENT: {BrokerStatus.AWAITING_RESPONSE, BrokerStatus.FAILED},
    BrokerStatus.AWAITING_RESPONSE: {
        BrokerStatus.IDENTITY_REQUESTED,
        BrokerStatus.COMPLETED,
        BrokerStatus.REJECTED,
        BrokerStatus.NEEDS_MANUAL,
        BrokerStatus.FAILED,
    },
    BrokerStatus.IDENTITY_REQUESTED: {BrokerStatus.IDENTITY_SENT, BrokerStatus.FAILED},
    BrokerStatus.IDENTITY_SENT: {BrokerStatus.AWAITING_RESPONSE, BrokerStatus.FAILED},
    # Terminal states - no transitions out
    BrokerStatus.COMPLETED: set(),
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
