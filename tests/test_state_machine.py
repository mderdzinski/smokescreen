"""Tests for the state machine."""

import pytest

from smokescreen.models import BrokerStatus
from smokescreen.state.machine import InvalidTransition, validate_transition

WAITING_REPLY_STATES = (
    BrokerStatus.INITIAL_SENT,
    BrokerStatus.INITIAL_SENT_PINGED,
    BrokerStatus.AWAITING_RESPONSE,
    BrokerStatus.AWAITING_RESPONSE_PINGED,
    BrokerStatus.INFO_REQUESTED,
    BrokerStatus.INFO_REQUESTED_PINGED,
    BrokerStatus.FOLLOW_UP_SENT,
    BrokerStatus.FOLLOW_UP_SENT_PINGED,
    BrokerStatus.REJECTED_REBUTTED,
)

TERMINAL_OR_ATTENTION_STATES = (
    BrokerStatus.COMPLETED,
    BrokerStatus.REJECTED,
    BrokerStatus.FAILED,
    BrokerStatus.NEEDS_MANUAL,
)


def test_valid_transitions():
    validate_transition(BrokerStatus.PENDING, BrokerStatus.INITIAL_SENT)
    validate_transition(BrokerStatus.INITIAL_SENT, BrokerStatus.AWAITING_RESPONSE)
    validate_transition(BrokerStatus.INITIAL_SENT, BrokerStatus.INFO_REQUESTED)
    validate_transition(BrokerStatus.AWAITING_RESPONSE, BrokerStatus.COMPLETED)
    validate_transition(BrokerStatus.AWAITING_RESPONSE, BrokerStatus.INFO_REQUESTED)
    validate_transition(BrokerStatus.INFO_REQUESTED, BrokerStatus.FOLLOW_UP_SENT)
    validate_transition(BrokerStatus.FOLLOW_UP_SENT, BrokerStatus.AWAITING_RESPONSE)
    validate_transition(BrokerStatus.AWAITING_RESPONSE, BrokerStatus.REJECTED_REBUTTED)
    validate_transition(BrokerStatus.REJECTED_REBUTTED, BrokerStatus.REJECTED)
    validate_transition(BrokerStatus.REJECTED_REBUTTED, BrokerStatus.COMPLETED)


def test_follow_up_sent_to_info_requested_allowed():
    validate_transition(BrokerStatus.FOLLOW_UP_SENT, BrokerStatus.INFO_REQUESTED)


def test_follow_up_sent_to_completed_allowed():
    validate_transition(BrokerStatus.FOLLOW_UP_SENT, BrokerStatus.COMPLETED)


def test_info_requested_to_info_requested_idempotent_allowed():
    validate_transition(BrokerStatus.INFO_REQUESTED, BrokerStatus.INFO_REQUESTED)


@pytest.mark.parametrize("current", WAITING_REPLY_STATES)
@pytest.mark.parametrize("target", TERMINAL_OR_ATTENTION_STATES)
def test_all_waiting_states_can_transition_to_all_terminals(
    current,
    target,
):
    validate_transition(current, target)


def test_invalid_transition_pending_to_completed():
    with pytest.raises(InvalidTransition):
        validate_transition(BrokerStatus.PENDING, BrokerStatus.COMPLETED)


def test_completed_can_transition_to_pending():
    """COMPLETED -> PENDING is allowed for re-request."""
    validate_transition(BrokerStatus.COMPLETED, BrokerStatus.PENDING)


def test_completed_cannot_transition_to_other_states():
    with pytest.raises(InvalidTransition):
        validate_transition(BrokerStatus.COMPLETED, BrokerStatus.INITIAL_SENT)


def test_terminal_states_have_no_transitions():
    with pytest.raises(InvalidTransition):
        validate_transition(BrokerStatus.COMPLETED, BrokerStatus.AWAITING_RESPONSE)
    with pytest.raises(InvalidTransition):
        validate_transition(BrokerStatus.REJECTED, BrokerStatus.PENDING)
    with pytest.raises(InvalidTransition):
        validate_transition(BrokerStatus.FAILED, BrokerStatus.PENDING)


def test_needs_manual_can_reset():
    validate_transition(BrokerStatus.NEEDS_MANUAL, BrokerStatus.PENDING)
    validate_transition(BrokerStatus.NEEDS_MANUAL, BrokerStatus.COMPLETED)
    validate_transition(BrokerStatus.NEEDS_MANUAL, BrokerStatus.REJECTED)


@pytest.mark.parametrize("target", WAITING_REPLY_STATES)
def test_needs_manual_can_restore_previous_waiting_state(target):
    validate_transition(BrokerStatus.NEEDS_MANUAL, target)


def test_pinged_transitions():
    """Every waiting state can transition to its paired pinged variant, and
    every pinged variant can escalate to NEEDS_MANUAL."""
    validate_transition(
        BrokerStatus.INITIAL_SENT, BrokerStatus.INITIAL_SENT_PINGED
    )
    validate_transition(
        BrokerStatus.AWAITING_RESPONSE, BrokerStatus.AWAITING_RESPONSE_PINGED
    )
    validate_transition(
        BrokerStatus.INFO_REQUESTED, BrokerStatus.INFO_REQUESTED_PINGED
    )
    validate_transition(
        BrokerStatus.FOLLOW_UP_SENT, BrokerStatus.FOLLOW_UP_SENT_PINGED
    )

    validate_transition(BrokerStatus.INITIAL_SENT_PINGED, BrokerStatus.NEEDS_MANUAL)
    validate_transition(
        BrokerStatus.AWAITING_RESPONSE_PINGED, BrokerStatus.NEEDS_MANUAL
    )
    validate_transition(BrokerStatus.INFO_REQUESTED_PINGED, BrokerStatus.NEEDS_MANUAL)
    validate_transition(BrokerStatus.FOLLOW_UP_SENT_PINGED, BrokerStatus.NEEDS_MANUAL)


def test_pinged_states_cannot_double_ping():
    """A pinged state has no transition back to itself; escalation is
    NEEDS_MANUAL, not another ping."""
    with pytest.raises(InvalidTransition):
        validate_transition(
            BrokerStatus.INITIAL_SENT_PINGED, BrokerStatus.INITIAL_SENT_PINGED
        )


def test_any_active_state_can_fail():
    validate_transition(BrokerStatus.PENDING, BrokerStatus.FAILED)
    validate_transition(BrokerStatus.INITIAL_SENT, BrokerStatus.FAILED)
    validate_transition(BrokerStatus.INITIAL_SENT_PINGED, BrokerStatus.FAILED)
    validate_transition(BrokerStatus.AWAITING_RESPONSE, BrokerStatus.FAILED)
    validate_transition(BrokerStatus.AWAITING_RESPONSE_PINGED, BrokerStatus.FAILED)
    validate_transition(BrokerStatus.INFO_REQUESTED, BrokerStatus.FAILED)
    validate_transition(BrokerStatus.INFO_REQUESTED_PINGED, BrokerStatus.FAILED)
    validate_transition(BrokerStatus.FOLLOW_UP_SENT, BrokerStatus.FAILED)
    validate_transition(BrokerStatus.FOLLOW_UP_SENT_PINGED, BrokerStatus.FAILED)
    validate_transition(BrokerStatus.REJECTED_REBUTTED, BrokerStatus.FAILED)
