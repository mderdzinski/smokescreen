"""Tests for domain models."""

from smokescreen.models import BrokerStatus, OptOutRecord, Broker, EmailMessage, ReplyClassification


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
    assert ReplyClassification.IDENTITY_REQUEST.value == "IDENTITY_REQUEST"
