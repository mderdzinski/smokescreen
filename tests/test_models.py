"""Tests for domain models."""

from smokescreen.models import (
    Broker,
    BrokerStatus,
    EmailMessage,
    OptOutRecord,
    ReplyClassification,
    parse_broker_status,
)


def test_broker_status_values():
    assert BrokerStatus.PENDING.value == "PENDING"
    assert BrokerStatus.COMPLETED.value == "COMPLETED"


def test_opt_out_record_defaults():
    record = OptOutRecord(broker_id="test-broker")
    assert record.status == BrokerStatus.PENDING
    assert record.retries == 0
    assert record.thread_id is None
    assert record.notes == ""


def test_broker_model():
    broker = Broker(
        id="spokeo",
        name="Spokeo",
        domain="spokeo.com",
        privacy_email="privacy@spokeo.com",
    )
    assert broker.id == "spokeo"
    assert broker.aliases == []


def test_email_message_defaults():
    msg = EmailMessage()
    assert msg.message_id == ""
    assert msg.has_attachments is False


def test_reply_classification_values():
    assert ReplyClassification.ACKNOWLEDGMENT.value == "ACKNOWLEDGMENT"
    assert ReplyClassification.INFO_REQUEST.value == "INFO_REQUEST"


def test_parse_broker_status_current_names():
    assert parse_broker_status("INITIAL_SENT") is BrokerStatus.INITIAL_SENT
    assert parse_broker_status("INFO_REQUESTED") is BrokerStatus.INFO_REQUESTED
    assert parse_broker_status("FOLLOW_UP_SENT") is BrokerStatus.FOLLOW_UP_SENT
    assert (
        parse_broker_status("INFO_REQUESTED_PINGED")
        is BrokerStatus.INFO_REQUESTED_PINGED
    )


def test_parse_broker_status_legacy_identity_aliases():
    """Old records with IDENTITY_* names get remapped at read time."""
    assert parse_broker_status("IDENTITY_REQUESTED") is BrokerStatus.INFO_REQUESTED
    assert parse_broker_status("IDENTITY_SENT") is BrokerStatus.FOLLOW_UP_SENT


def test_parse_broker_status_new_pinged_states_exist():
    for name in (
        "INITIAL_SENT_PINGED",
        "AWAITING_RESPONSE_PINGED",
        "INFO_REQUESTED_PINGED",
        "FOLLOW_UP_SENT_PINGED",
    ):
        assert BrokerStatus(name).value == name
