"""Tests for the state machine."""

import pytest

from smokescreen.models import BrokerStatus
from smokescreen.state.machine import InvalidTransition, validate_transition


def test_valid_transitions():
    validate_transition(BrokerStatus.PENDING, BrokerStatus.INITIAL_SENT)
    validate_transition(BrokerStatus.INITIAL_SENT, BrokerStatus.AWAITING_RESPONSE)
    validate_transition(BrokerStatus.AWAITING_RESPONSE, BrokerStatus.COMPLETED)
    validate_transition(BrokerStatus.AWAITING_RESPONSE, BrokerStatus.IDENTITY_REQUESTED)
    validate_transition(BrokerStatus.IDENTITY_REQUESTED, BrokerStatus.IDENTITY_SENT)
    validate_transition(BrokerStatus.IDENTITY_SENT, BrokerStatus.AWAITING_RESPONSE)


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


def test_any_active_state_can_fail():
    validate_transition(BrokerStatus.PENDING, BrokerStatus.FAILED)
    validate_transition(BrokerStatus.INITIAL_SENT, BrokerStatus.FAILED)
    validate_transition(BrokerStatus.AWAITING_RESPONSE, BrokerStatus.FAILED)
    validate_transition(BrokerStatus.IDENTITY_REQUESTED, BrokerStatus.FAILED)
    validate_transition(BrokerStatus.IDENTITY_SENT, BrokerStatus.FAILED)
