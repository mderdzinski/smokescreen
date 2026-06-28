"""Outreach job: send initial opt-out emails for PENDING brokers."""

from __future__ import annotations

from datetime import datetime, timedelta

import structlog

from smokescreen.brokers.registry import BrokerRegistry
from smokescreen.config import Settings
from smokescreen.email.client import GmailClient
from smokescreen.email.templates import render_initial_opt_out
from smokescreen.models import BrokerStatus, OptOutRecord
from smokescreen.state.machine import validate_transition
from smokescreen.state.store import StateStore

log = structlog.get_logger()


def _check_rerequest(record: OptOutRecord, interval_days: int) -> bool:
    """Return True if a COMPLETED record is due for re-request."""
    if record.status != BrokerStatus.COMPLETED:
        return False
    ref_time = record.last_completed_at or record.updated_at
    return datetime.utcnow() - ref_time >= timedelta(days=interval_days)


def run_outreach(
    settings: Settings,
    registry: BrokerRegistry,
    store: StateStore,
    gmail: GmailClient | None = None,
) -> list[str]:
    """Send initial opt-out emails to all PENDING brokers.

    Also re-queues COMPLETED brokers whose re-request interval has elapsed.
    Returns list of broker IDs that were processed.
    """
    processed: list[str] = []

    for broker in registry.all():
        record = store.get(broker.id)

        # Check if a completed broker is due for re-request
        if record is not None and _check_rerequest(
            record, settings.rerequest_interval_days
        ):
            log.info(
                "rerequest_due",
                broker=broker.id,
                last_completed=str(record.last_completed_at or record.updated_at),
            )
            record.status = BrokerStatus.PENDING
            record.retries = 0
            record.thread_id = None
            record.last_message_id = None
            record.notes = "Re-request after interval"
            record.updated_at = datetime.utcnow()
            store.upsert(record)

        # Only process brokers in PENDING state (or not yet tracked)
        if record is not None and record.status != BrokerStatus.PENDING:
            continue

        if record is None:
            record = OptOutRecord(broker_id=broker.id)
            store.upsert(record)

        log.info("outreach_sending", broker=broker.id, email=broker.privacy_email)

        body = render_initial_opt_out(
            broker_name=broker.name,
            sender_name=settings.sender_name,
            sender_email=settings.sender_email,
        )
        subject = f"Personal Data Deletion Request - {settings.sender_name}"

        if settings.dry_run:
            log.info("dry_run_skip", broker=broker.id, subject=subject)
            thread_id = f"dry-run-thread-{broker.id}"
            message_id = f"dry-run-message-{broker.id}"
        else:
            if gmail is None:
                log.error("no_gmail_client", broker=broker.id)
                continue

            sent = gmail.send(
                to=broker.privacy_email,
                subject=subject,
                body=body,
                sender=settings.sender_email,
                sender_name=settings.sender_name,
            )
            thread_id = sent.thread_id
            message_id = sent.message_id

        validate_transition(record.status, BrokerStatus.INITIAL_SENT)
        record.status = BrokerStatus.INITIAL_SENT
        record.thread_id = thread_id
        record.last_message_id = message_id
        record.updated_at = datetime.utcnow()
        store.upsert(record)

        processed.append(broker.id)
        if settings.dry_run:
            log.info("dry_run_outreach_recorded", broker=broker.id, thread_id=thread_id)
        else:
            log.info("outreach_sent", broker=broker.id, thread_id=thread_id)

    return processed
