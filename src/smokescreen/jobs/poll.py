"""Poll job: check inbox for broker replies, classify, respond, update state."""

from __future__ import annotations

from datetime import datetime
from email.utils import parseaddr
from typing import Any

import structlog
from anthropic import Anthropic
from google import genai

from smokescreen.ai.classifier import classify_reply, classify_reply_gemini
from smokescreen.brokers.registry import BrokerRegistry
from smokescreen.config import Settings
from smokescreen.email.client import GmailClient
from smokescreen.email.templates import render_follow_up_response, render_silent_ping
from smokescreen.identity_docs import identity_attachment_paths
from smokescreen.models import (
    BrokerStatus,
    EmailMessage,
    OptOutRecord,
    PendingWhitelistEntry,
    ReplyClassification,
    as_aware_utc,
    utc_now,
)
from smokescreen.state.machine import PINGED_STATE, WAITING_STATES, validate_transition
from smokescreen.state.store import StateStore

log = structlog.get_logger()

# States that expect incoming replies (including their pinged variants and
# the follow-up-sent state that expects a broker response after we replied).
_ACTIVE_STATES = {
    BrokerStatus.INITIAL_SENT,
    BrokerStatus.INITIAL_SENT_PINGED,
    BrokerStatus.AWAITING_RESPONSE,
    BrokerStatus.AWAITING_RESPONSE_PINGED,
    BrokerStatus.FOLLOW_UP_SENT,
    BrokerStatus.FOLLOW_UP_SENT_PINGED,
    BrokerStatus.INFO_REQUESTED,
    BrokerStatus.INFO_REQUESTED_PINGED,
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
        # Even with no live thread state, timeout escalation may still be
        # relevant if pinged records aged past a second window.
        run_timeout_escalation(settings, registry, store, gmail)
        return []

    if gmail is None and not settings.dry_run:
        log.error("poll_no_gmail_client")
        return []

    ai_client = _build_classifier_client(settings)

    labeled_thread_ids = _poll_label_thread_ids(settings, gmail)
    processed: list[str] = []

    for record in active_records:
        broker = registry.get(record.broker_id)
        if broker is None:
            log.warning("poll_unknown_broker", broker_id=record.broker_id)
            continue

        if record.thread_id is None:
            log.warning("poll_no_thread", broker_id=record.broker_id)
            continue

        if (
            labeled_thread_ids is not None
            and record.thread_id not in labeled_thread_ids
        ):
            log.debug(
                "poll_thread_not_in_label",
                broker_id=record.broker_id,
                thread_id=record.thread_id,
                poll_label=settings.poll_label,
            )
            continue

        result = _process_thread(
            settings=settings,
            record=record,
            broker_name=broker.name,
            broker_email=broker.privacy_email,
            store=store,
            gmail=gmail,
            ai_client=ai_client,
        )
        if result:
            processed.append(record.broker_id)

    # Idempotent timeout sweep: run after regular reply processing so that a
    # broker whose reply landed in the same poll doesn't get a ping in the
    # same run (its updated_at just moved).
    processed.extend(run_timeout_escalation(settings, registry, store, gmail))

    return processed


def _build_classifier_client(settings: Settings) -> Any | None:
    """Create the configured reply-classification client."""
    if settings.ai_provider == "anthropic":
        if settings.anthropic_api_key:
            return Anthropic(api_key=settings.anthropic_api_key)
        return None

    if settings.ai_provider == "gemini":
        kwargs: dict[str, str] = {}
        project = settings.gemini_project.strip() or settings.firestore_project.strip()
        location = settings.gemini_location.strip()
        if project:
            kwargs["project"] = project
        if location:
            kwargs["location"] = location
        return genai.Client(vertexai=True, **kwargs)

    raise ValueError(f"Unknown AI provider: {settings.ai_provider}")


def _poll_label_thread_ids(
    settings: Settings, gmail: GmailClient | None
) -> set[str] | None:
    """Return thread IDs matching the configured poll label.

    A blank poll_label disables label scoping. Otherwise, polling remains
    thread-based and only active records whose stored thread_id appears in the
    Gmail label search are processed.
    """
    label = settings.poll_label.strip()
    if not label or gmail is None:
        return None

    query = _poll_label_query(label)
    message_ids = gmail.search(query)
    if not message_ids:
        log.info("poll_label_no_messages", poll_label=label, query=query)
        return set()

    thread_ids: set[str] = set()
    for message_id in message_ids:
        message = gmail.get_message(message_id)
        if message.thread_id:
            thread_ids.add(message.thread_id)

    log.info(
        "poll_label_threads",
        poll_label=label,
        query=query,
        message_count=len(message_ids),
        thread_count=len(thread_ids),
    )
    return thread_ids


def _poll_label_query(label: str) -> str:
    """Build a Gmail search query for a user-configured label."""
    if any(c.isspace() for c in label):
        escaped = label.replace('"', r"\"")
        return f'label:"{escaped}"'
    return f"label:{label}"


def _process_thread(
    settings: Settings,
    record: OptOutRecord,
    broker_name: str,
    broker_email: str,
    store: StateStore,
    gmail: GmailClient | None,
    ai_client: Any | None,
) -> bool:
    """Process a single broker's thread. Returns True if any action was taken."""
    if gmail is None:
        return False

    thread = gmail.get_thread(record.thread_id)
    if not thread:
        return False

    # Find the latest message we haven't processed
    sender_email = _sender_address(settings.sender_email)
    new_messages = [
        m
        for m in thread
        if m.message_id != record.last_message_id
        and _sender_address(m.sender) != sender_email
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
    latest_sender = _sender_address(latest.sender)
    if not store.is_whitelisted(latest_sender):
        log.info(
            "poll_sender_not_whitelisted",
            broker=record.broker_id,
            sender=latest_sender,
        )
        store.add_pending_whitelist(
            PendingWhitelistEntry(
                broker_id=record.broker_id,
                email=latest_sender,
                message_subject=latest.subject,
                message_snippet=latest.body[:200] if latest.body else "",
            )
        )
        return False

    if ai_client is None:
        log.warning(
            "poll_no_ai_classifier",
            broker=record.broker_id,
            provider=settings.ai_provider,
        )
        record.status = BrokerStatus.NEEDS_MANUAL
        record.notes = _missing_classifier_notes(settings)
        record.updated_at = utc_now()
        store.upsert(record)
        return True

    # Classify the reply
    if settings.ai_provider == "anthropic":
        classification = classify_reply(
            client=ai_client,
            model=settings.anthropic_model,
            broker_name=broker_name,
            subject=latest.subject,
            body=latest.body,
        )
    else:
        classification = classify_reply_gemini(
            client=ai_client,
            model=settings.gemini_model,
            broker_name=broker_name,
            subject=latest.subject,
            body=latest.body,
        )

    log.info(
        "poll_classified",
        broker=record.broker_id,
        classification=classification.value,
        provider=settings.ai_provider,
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
    )


def _missing_classifier_notes(settings: Settings) -> str:
    if settings.ai_provider == "anthropic":
        return "No Anthropic API key configured"
    return f"No AI classifier configured for provider: {settings.ai_provider}"


def _sender_address(sender: str) -> str:
    """Return the bare address from a raw email sender header."""
    parsed = parseaddr(sender)[1]
    return (parsed or sender).strip().lower()


def _handle_classification(
    settings: Settings,
    record: OptOutRecord,
    broker_name: str,
    broker_email: str,
    latest: EmailMessage,
    classification: ReplyClassification,
    store: StateStore,
    gmail: GmailClient,
) -> bool:
    """Handle a classified reply. Returns True if action was taken."""
    now = utc_now()

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
        record.notes = _manual_review_notes(latest)
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

    if classification == ReplyClassification.INFO_REQUEST:
        return _handle_info_request(
            settings=settings,
            record=record,
            broker_name=broker_name,
            broker_email=broker_email,
            latest=latest,
            store=store,
            gmail=gmail,
        )

    return False


def _manual_review_notes(message: EmailMessage) -> str:
    """Build the saved text shown on the manual review page."""
    subject = message.subject.strip()
    body = message.body.strip()

    if subject and body:
        return f"Subject: {subject}\n\n{body}"
    if body:
        return body
    if subject:
        return f"Subject: {subject}"
    return (
        "Broker reply was classified for manual review, but the message body was empty."
    )


def _handle_info_request(
    settings: Settings,
    record: OptOutRecord,
    broker_name: str,
    broker_email: str,
    latest: EmailMessage,
    store: StateStore,
    gmail: GmailClient,
) -> bool:
    """Handle a broker follow-up requesting additional information."""
    now = utc_now()

    if record.retries >= settings.max_retries:
        record.status = BrokerStatus.FAILED
        record.notes = "Max retries exceeded"
        record.updated_at = now
        store.upsert(record)
        log.warning("poll_max_retries", broker=record.broker_id)
        return True

    validate_transition(record.status, BrokerStatus.INFO_REQUESTED)
    record.status = BrokerStatus.INFO_REQUESTED
    record.last_message_id = latest.message_id
    record.updated_at = now
    store.upsert(record)

    body = render_follow_up_response(
        broker_name=broker_name,
        sender_name=settings.sender_name,
    )

    with identity_attachment_paths(settings) as attachment_paths:
        if settings.dry_run:
            log.info("dry_run_follow_up_reply", broker=record.broker_id)
        else:
            # Replies stay in the original Gmail thread, so Gmail preserves the
            # poll label applied by outreach.
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

    validate_transition(record.status, BrokerStatus.FOLLOW_UP_SENT)
    record.status = BrokerStatus.FOLLOW_UP_SENT
    record.retries += 1
    record.updated_at = utc_now()
    store.upsert(record)

    log.info("poll_follow_up_sent", broker=record.broker_id, retries=record.retries)
    return True


def run_timeout_escalation(
    settings: Settings,
    registry: BrokerRegistry,
    store: StateStore,
    gmail: GmailClient | None,
    now: datetime | None = None,
) -> list[str]:
    """Ping silent brokers and escalate ones that stayed silent again.

    Idempotent: acts only on records whose ``updated_at`` has aged past
    ``state_timeout_days``. A single normal state transition inside the same
    window resets the timer via ``updated_at``.
    """
    timeout_days = settings.state_timeout_days
    if timeout_days <= 0:
        return []

    now = as_aware_utc(now) if now is not None else utc_now()
    processed: list[str] = []

    # Ping first-timeout records (waiting state → paired *_PINGED).
    for status in WAITING_STATES:
        for record in store.list_by_status(status):
            if not _is_stale(record, now, timeout_days):
                continue
            broker = registry.get(record.broker_id)
            if broker is None:
                log.warning("timeout_unknown_broker", broker_id=record.broker_id)
                continue
            _send_silent_ping(
                settings=settings,
                record=record,
                broker_name=broker.name,
                broker_email=broker.privacy_email,
                gmail=gmail,
                store=store,
                now=now,
            )
            processed.append(record.broker_id)

    # Escalate second-timeout records (*_PINGED → NEEDS_MANUAL).
    for waiting_state, pinged_state in PINGED_STATE.items():
        for record in store.list_by_status(pinged_state):
            if not _is_stale(record, now, timeout_days):
                continue
            _escalate_to_needs_manual(
                record=record,
                previous_state=waiting_state,
                store=store,
                now=now,
            )
            processed.append(record.broker_id)

    if processed:
        log.info(
            "poll_timeout_processed",
            count=len(processed),
            timeout_days=timeout_days,
        )
    return processed


def _is_stale(record: OptOutRecord, now: datetime, timeout_days: int) -> bool:
    return (now - as_aware_utc(record.updated_at)).days >= timeout_days


def _send_silent_ping(
    settings: Settings,
    record: OptOutRecord,
    broker_name: str,
    broker_email: str,
    gmail: GmailClient | None,
    store: StateStore,
    now: datetime,
) -> None:
    """Send a friendly status-check ping and transition to the paired state."""
    body = render_silent_ping(broker_name=broker_name, sender_name=settings.sender_name)

    if settings.dry_run or gmail is None:
        log.info(
            "dry_run_silent_ping",
            broker=record.broker_id,
            from_state=record.status.value,
        )
    else:
        # Replies stay in the original Gmail thread, so Gmail preserves the
        # poll label applied by outreach.
        sent = gmail.send(
            to=broker_email,
            subject=f"Re: deletion request for {settings.sender_name}",
            body=body,
            sender=settings.sender_email,
            sender_name=settings.sender_name,
            thread_id=record.thread_id,
        )
        record.last_message_id = sent.message_id

    next_status = PINGED_STATE[record.status]
    validate_transition(record.status, next_status)
    record.status = next_status
    record.updated_at = now
    store.upsert(record)
    log.info(
        "poll_silent_ping_sent",
        broker=record.broker_id,
        new_state=next_status.value,
    )


def _escalate_to_needs_manual(
    record: OptOutRecord,
    previous_state: BrokerStatus,
    store: StateStore,
    now: datetime,
) -> None:
    validate_transition(record.status, BrokerStatus.NEEDS_MANUAL)
    record.notes = f"escalated after two silent periods on {previous_state.value}"
    record.status = BrokerStatus.NEEDS_MANUAL
    record.updated_at = now
    store.upsert(record)
    log.warning(
        "poll_timeout_escalated",
        broker=record.broker_id,
        previous_state=previous_state.value,
    )
