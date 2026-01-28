"""Poll job: check inbox for broker replies, classify, respond, update state."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

import structlog
from anthropic import Anthropic

from smokescreen.ai.classifier import classify_reply
from smokescreen.brokers.registry import BrokerRegistry
from smokescreen.config import Settings
from smokescreen.email.client import GmailClient
from smokescreen.email.templates import render_identity_response
from smokescreen.models import (
    BrokerStatus,
    EmailMessage,
    OptOutRecord,
    PendingWhitelistEntry,
    ReplyClassification,
)
from smokescreen.state.machine import validate_transition
from smokescreen.state.sqlite import SQLiteStore
from smokescreen.state.store import StateStore

log = structlog.get_logger()

# States that expect incoming replies
_ACTIVE_STATES = {
    BrokerStatus.INITIAL_SENT,
    BrokerStatus.AWAITING_RESPONSE,
    BrokerStatus.IDENTITY_SENT,
}


def run_poll(
    settings: Settings,
    registry: BrokerRegistry,
    store: StateStore,
    gmail: GmailClient | None = None,
) -> list[str]:
    """Poll inbox for broker replies and process them.

    Returns list of broker IDs that were processed.
    """
    active_records = []
    for status in _ACTIVE_STATES:
        active_records.extend(store.list_by_status(status))

    if not active_records:
        log.info("poll_no_active_records")
        return []

    if gmail is None and not settings.dry_run:
        log.error("poll_no_gmail_client")
        return []

    anthropic_client = None
    if settings.anthropic_api_key:
        anthropic_client = Anthropic(api_key=settings.anthropic_api_key)

    processed: list[str] = []

    for record in active_records:
        broker = registry.get(record.broker_id)
        if broker is None:
            log.warning("poll_unknown_broker", broker_id=record.broker_id)
            continue

        if record.thread_id is None:
            log.warning("poll_no_thread", broker_id=record.broker_id)
            continue

        result = _process_thread(
            settings=settings,
            record=record,
            broker_name=broker.name,
            broker_email=broker.privacy_email,
            store=store,
            gmail=gmail,
            anthropic_client=anthropic_client,
        )
        if result:
            processed.append(record.broker_id)

    return processed


def _process_thread(
    settings: Settings,
    record: OptOutRecord,
    broker_name: str,
    broker_email: str,
    store: StateStore,
    gmail: GmailClient | None,
    anthropic_client: Anthropic | None,
) -> bool:
    """Process a single broker's thread. Returns True if any action was taken."""
    if gmail is None:
        return False

    thread = gmail.get_thread(record.thread_id)
    if not thread:
        return False

    # Find the latest message we haven't processed
    new_messages = [
        m
        for m in thread
        if m.message_id != record.last_message_id and m.sender != settings.sender_email
    ]

    if not new_messages:
        return False

    latest = new_messages[-1]
    log.info(
        "poll_new_message",
        broker=record.broker_id,
        from_=latest.sender,
        subject=latest.subject,
    )

    # Whitelist check: only process replies from whitelisted senders
    if isinstance(store, SQLiteStore) and not store.is_whitelisted(latest.sender):
        log.info(
            "poll_sender_not_whitelisted",
            broker=record.broker_id,
            sender=latest.sender,
        )
        store.add_pending_whitelist(
            PendingWhitelistEntry(
                broker_id=record.broker_id,
                email=latest.sender,
                message_subject=latest.subject,
                message_snippet=latest.body[:200] if latest.body else "",
            )
        )
        return False

    if anthropic_client is None:
        log.warning("poll_no_anthropic_client", broker=record.broker_id)
        record.status = BrokerStatus.NEEDS_MANUAL
        record.notes = "No Anthropic API key configured"
        record.updated_at = datetime.utcnow()
        store.upsert(record)
        return True

    # Classify the reply
    classification = classify_reply(
        client=anthropic_client,
        model=settings.anthropic_model,
        broker_name=broker_name,
        subject=latest.subject,
        body=latest.body,
    )

    log.info(
        "poll_classified",
        broker=record.broker_id,
        classification=classification.value,
    )

    return _handle_classification(
        settings=settings,
        record=record,
        broker_name=broker_name,
        broker_email=broker_email,
        latest=latest,
        classification=classification,
        store=store,
        gmail=gmail,
        anthropic_client=anthropic_client,
    )


def _handle_classification(
    settings: Settings,
    record: OptOutRecord,
    broker_name: str,
    broker_email: str,
    latest: EmailMessage,
    classification: ReplyClassification,
    store: StateStore,
    gmail: GmailClient,
    anthropic_client: Anthropic,
) -> bool:
    """Handle a classified reply. Returns True if action was taken."""
    now = datetime.utcnow()

    if classification == ReplyClassification.COMPLETED:
        validate_transition(record.status, BrokerStatus.COMPLETED)
        record.status = BrokerStatus.COMPLETED
        record.last_message_id = latest.message_id
        record.last_completed_at = now
        record.updated_at = now
        store.upsert(record)
        log.info("poll_completed", broker=record.broker_id)
        return True

    if classification == ReplyClassification.REJECTED:
        validate_transition(record.status, BrokerStatus.REJECTED)
        record.status = BrokerStatus.REJECTED
        record.last_message_id = latest.message_id
        record.updated_at = now
        store.upsert(record)
        log.info("poll_rejected", broker=record.broker_id)
        return True

    if classification == ReplyClassification.NEEDS_MANUAL:
        validate_transition(record.status, BrokerStatus.NEEDS_MANUAL)
        record.status = BrokerStatus.NEEDS_MANUAL
        record.last_message_id = latest.message_id
        record.updated_at = now
        store.upsert(record)
        log.info("poll_needs_manual", broker=record.broker_id)
        return True

    if classification == ReplyClassification.UNRELATED:
        # Ignore unrelated messages, just update tracking
        record.last_message_id = latest.message_id
        record.updated_at = now
        store.upsert(record)
        return False

    if classification == ReplyClassification.ACKNOWLEDGMENT:
        validate_transition(record.status, BrokerStatus.AWAITING_RESPONSE)
        record.status = BrokerStatus.AWAITING_RESPONSE
        record.last_message_id = latest.message_id
        record.updated_at = now
        store.upsert(record)
        log.info("poll_ack_awaiting", broker=record.broker_id)
        return True

    if classification == ReplyClassification.IDENTITY_REQUEST:
        return _handle_identity_request(
            settings=settings,
            record=record,
            broker_name=broker_name,
            broker_email=broker_email,
            latest=latest,
            store=store,
            gmail=gmail,
        )

    return False


def _handle_identity_request(
    settings: Settings,
    record: OptOutRecord,
    broker_name: str,
    broker_email: str,
    latest: EmailMessage,
    store: StateStore,
    gmail: GmailClient,
) -> bool:
    """Handle an identity verification request from a broker."""
    now = datetime.utcnow()

    if record.retries >= settings.max_retries:
        record.status = BrokerStatus.FAILED
        record.notes = "Max retries exceeded"
        record.updated_at = now
        store.upsert(record)
        log.warning("poll_max_retries", broker=record.broker_id)
        return True

    validate_transition(record.status, BrokerStatus.IDENTITY_REQUESTED)
    record.status = BrokerStatus.IDENTITY_REQUESTED
    record.last_message_id = latest.message_id
    record.updated_at = now
    store.upsert(record)

    # Gather identity docs
    attachment_paths: list[Path] = []
    if settings.identity_docs_dir.exists():
        attachment_paths = list(settings.identity_docs_dir.iterdir())

    body = render_identity_response(
        broker_name=broker_name,
        sender_name=settings.sender_name,
    )

    if settings.dry_run:
        log.info("dry_run_identity_reply", broker=record.broker_id)
    else:
        sent = gmail.send(
            to=broker_email,
            subject=f"Re: {latest.subject}",
            body=body,
            sender=settings.sender_email,
            sender_name=settings.sender_name,
            thread_id=record.thread_id,
            attachment_paths=attachment_paths if attachment_paths else None,
        )
        record.last_message_id = sent.message_id

    validate_transition(record.status, BrokerStatus.IDENTITY_SENT)
    record.status = BrokerStatus.IDENTITY_SENT
    record.retries += 1
    record.updated_at = datetime.utcnow()
    store.upsert(record)

    log.info("poll_identity_sent", broker=record.broker_id, retries=record.retries)
    return True
