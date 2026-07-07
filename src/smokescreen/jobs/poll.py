"""Poll job: check inbox for broker replies, classify, respond, update state."""

from __future__ import annotations

import re
from datetime import datetime
from email.utils import parseaddr
from typing import Any

import structlog
from anthropic import Anthropic
from google import genai

from smokescreen.ai.classifier import classify_reply, classify_reply_gemini
from smokescreen.ai.response_composer import (
    ResponseTargetAction,
    compose_response_skeleton,
    render_response_skeleton,
)
from smokescreen.brokers.registry import BrokerRegistry
from smokescreen.config import Settings
from smokescreen.email.client import GmailClient
from smokescreen.email.reply_parser import parse_latest_reply
from smokescreen.email.templates import (
    render_rejection_rebuttal,
    render_silent_ping,
    render_verification_profile_follow_up,
)
from smokescreen.models import (
    Broker,
    BrokerStatus,
    EmailMessage,
    NeedsManualReason,
    OptOutRecord,
    PendingWhitelistEntry,
    ReplyAnalysis,
    ReplyClassification,
    VerificationAddress,
    VerificationDocument,
    VerificationField,
    VerificationProfile,
    as_aware_utc,
    utc_now,
)
from smokescreen.state.machine import PINGED_STATE, WAITING_STATES, validate_transition
from smokescreen.state.store import StateStore

log = structlog.get_logger()

BROKER_REPLY_EXCERPT_LIMIT = 1500
_BOILERPLATE_FALLBACK_PREFIX = "Reply excerpt may include boilerplate:\n"
_CLASSIFIER_SUMMARY_KEYS = (
    "other_details",
    "structured_summary",
    "summary",
    "request_summary",
    "manual_review_summary",
    "details",
)
_BOILERPLATE_MARKER_RE = re.compile(
    "|".join(
        re.escape(marker)
        for marker in (
            "This is an automated message",
            "This email is an autoreply",
            "THIS EMAIL RESPONSE IS AN AUTOREPLY",
            "Automatic reply",
            "Out of office",
            "How would you rate",
            "rate our support",
            "customer satisfaction survey",
            "Please take a moment to answer",
            "Please reply above this line",
        )
    ),
    re.IGNORECASE,
)
_TICKETING_SEPARATOR_RE = re.compile(
    r"^\s*##\s*In replies all text above this line is added to the ticket\s*##\s*$",
    re.IGNORECASE,
)
_HORIZONTAL_RULE_RE = re.compile(r"^\s*[-=_*]{3,}\s*$")
_ORIGINAL_MESSAGE_RE = re.compile(
    r"^\s*-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,}\s*$",
    re.IGNORECASE,
)
_EMAIL_QUOTED_SEPARATOR_RE = re.compile(r"^\s*On .+\bwrote:\s*$", re.IGNORECASE)
_EMAIL_HEADER_RE = re.compile(
    r"^\s*(?:from|sent|to|subject|date|cc):\s+.+$", re.IGNORECASE
)
_URL_ONLY_RE = re.compile(r"^\s*(?:https?://|www\.)\S+\s*$", re.IGNORECASE)

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
    BrokerStatus.REJECTED_REBUTTED,
}

_PROFILE_FIELD_LABELS = {
    VerificationField.HOME_ADDRESS: "Home address",
    VerificationField.PHONE_NUMBER: "Phone number",
    VerificationField.EMAIL_ALIAS: "Email alias",
    VerificationField.DATE_OF_BIRTH: "Date of birth",
    VerificationField.LAST_FOUR_SSN: "Last four SSN",
    VerificationField.EMPLOYER_NAME: "Employer name",
    VerificationField.DOCUMENTS: "Documents",
    VerificationField.OTHER: "Other",
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
        try:
            result = _process_poll_record(
                settings=settings,
                record=record,
                registry=registry,
                store=store,
                gmail=gmail,
                ai_client=ai_client,
                labeled_thread_ids=labeled_thread_ids,
            )
        except Exception as exc:
            _log_record_exception("poll_record_processing_failed", record, exc)
            continue
        if result:
            processed.append(record.broker_id)

    # Idempotent timeout sweep: run after regular reply processing so that a
    # broker whose reply landed in the same poll doesn't get a ping in the
    # same run (its updated_at just moved).
    processed.extend(run_timeout_escalation(settings, registry, store, gmail))

    return processed


def _process_poll_record(
    *,
    settings: Settings,
    record: OptOutRecord,
    registry: BrokerRegistry,
    store: StateStore,
    gmail: GmailClient | None,
    ai_client: Any | None,
    labeled_thread_ids: set[str] | None,
) -> bool:
    broker = registry.get(record.broker_id)
    if broker is None:
        log.warning("poll_unknown_broker", broker_id=record.broker_id)
        return False

    if record.thread_id is None:
        log.warning("poll_no_thread", broker_id=record.broker_id)
        return False

    broker_sender_domains = _broker_sender_domains(broker)
    log.info(
        "poll_record_thread_id",
        broker_id=record.broker_id,
        thread_id=record.thread_id,
        poll_label=settings.poll_label,
    )

    if labeled_thread_ids is not None and record.thread_id not in labeled_thread_ids:
        log.info(
            "poll_thread_not_in_label",
            broker_id=record.broker_id,
            thread_id=record.thread_id,
            poll_label=settings.poll_label,
        )
        if not _retarget_record_to_domain_reply_thread(
            settings=settings,
            record=record,
            broker=broker,
            gmail=gmail,
            broker_sender_domains=broker_sender_domains,
            allow_current_thread=True,
        ):
            return False

    result = _process_thread(
        settings=settings,
        record=record,
        broker_name=broker.name,
        broker_email=broker.privacy_email,
        broker_sender_domains=broker_sender_domains,
        store=store,
        gmail=gmail,
        ai_client=ai_client,
    )
    if not result and _retarget_record_to_domain_reply_thread(
        settings=settings,
        record=record,
        broker=broker,
        gmail=gmail,
        broker_sender_domains=broker_sender_domains,
        allow_current_thread=False,
    ):
        result = _process_thread(
            settings=settings,
            record=record,
            broker_name=broker.name,
            broker_email=broker.privacy_email,
            broker_sender_domains=broker_sender_domains,
            store=store,
            gmail=gmail,
            ai_client=ai_client,
        )
    return result


def _log_record_exception(
    event: str,
    record: OptOutRecord,
    exc: Exception,
    **context: object,
) -> None:
    log.exception(
        event,
        broker_id=record.broker_id,
        error_type=type(exc).__name__,
        error_message=str(exc),
        **context,
    )


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
        log.info(
            "poll_thread_labeled_ids",
            poll_label=label,
            thread_count=0,
            sample_thread_ids=[],
        )
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
    log.info(
        "poll_thread_labeled_ids",
        poll_label=label,
        thread_count=len(thread_ids),
        sample_thread_ids=sorted(thread_ids)[:10],
    )
    return thread_ids


def _poll_label_query(label: str) -> str:
    """Build a Gmail search query for a user-configured label."""
    if any(c.isspace() for c in label):
        escaped = label.replace('"', r"\"")
        return f'label:"{escaped}"'
    return f"label:{label}"


def _retarget_record_to_domain_reply_thread(
    *,
    settings: Settings,
    record: OptOutRecord,
    broker: Broker,
    gmail: GmailClient | None,
    broker_sender_domains: set[str],
    allow_current_thread: bool,
) -> bool:
    """Move a record to a broker-domain reply thread discovered from inbox search."""
    if gmail is None:
        return False

    match = _find_domain_reply_message(
        settings=settings,
        record=record,
        gmail=gmail,
        broker_sender_domains=broker_sender_domains,
        allow_current_thread=allow_current_thread,
    )
    if match is None:
        return False

    message, matched_domain = match
    previous_thread_id = record.thread_id
    record.thread_id = message.thread_id
    _label_domain_reply_thread(
        settings=settings,
        gmail=gmail,
        broker_id=record.broker_id,
        thread_id=message.thread_id,
    )
    log.info(
        "poll_domain_reply_thread_matched",
        broker_id=record.broker_id,
        broker_name=broker.name,
        previous_thread_id=previous_thread_id,
        thread_id=message.thread_id,
        message_id=message.message_id,
        sender=_sender_address(message.sender),
        matched_domain=matched_domain,
    )
    return True


def _find_domain_reply_message(
    *,
    settings: Settings,
    record: OptOutRecord,
    gmail: GmailClient,
    broker_sender_domains: set[str],
    allow_current_thread: bool,
) -> tuple[EmailMessage, str] | None:
    """Find the newest inbox message from a broker-owned sender domain."""
    if not broker_sender_domains:
        return None

    candidates: list[tuple[EmailMessage, str]] = []
    seen_message_ids: set[str] = set()
    sender_email = _sender_address(settings.sender_email)

    for domain in sorted(broker_sender_domains):
        query = _domain_reply_query(domain)
        message_ids = gmail.search(query)
        log.info(
            "poll_domain_reply_search",
            broker_id=record.broker_id,
            domain=domain,
            query=query,
            message_count=len(message_ids),
        )
        for message_id in message_ids:
            if message_id in seen_message_ids:
                continue
            seen_message_ids.add(message_id)

            message = gmail.get_message(message_id)
            if not message.thread_id:
                continue
            if message.message_id == record.last_message_id:
                continue
            if not allow_current_thread and message.thread_id == record.thread_id:
                continue

            message_sender = _sender_address(message.sender)
            if message_sender == sender_email and not settings.allow_self_reply:
                continue

            matched_domain = _matching_sender_domain(
                message.sender, broker_sender_domains
            )
            if matched_domain is None:
                continue
            candidates.append((message, matched_domain))

    if not candidates:
        return None

    dated = [(message, domain) for message, domain in candidates if message.date]
    if dated:
        return max(dated, key=lambda item: as_aware_utc(item[0].date).timestamp())
    return candidates[0]


def _domain_reply_query(domain: str) -> str:
    return f"in:inbox from:{domain}"


def _label_domain_reply_thread(
    *,
    settings: Settings,
    gmail: GmailClient,
    broker_id: str,
    thread_id: str,
) -> None:
    """Apply the poll label to a discovered reply thread without blocking poll."""
    label = settings.poll_label.strip()
    if not label:
        return
    if not thread_id:
        log.warning(
            "poll_label_apply_failed",
            broker_id=broker_id,
            thread_id=thread_id,
            label=label,
            reason="missing_thread_id",
        )
        return

    try:
        gmail.label_thread(thread_id, label)
    except Exception as exc:
        log.warning(
            "poll_label_apply_failed",
            broker_id=broker_id,
            thread_id=thread_id,
            label=label,
            error=str(exc),
        )
        return

    log.info(
        "poll_thread_labeled",
        broker_id=broker_id,
        thread_id=thread_id,
        label=label,
    )


def _process_thread(
    settings: Settings,
    record: OptOutRecord,
    broker_name: str,
    broker_email: str,
    store: StateStore,
    gmail: GmailClient | None,
    ai_client: Any | None,
    broker_sender_domains: set[str] | None = None,
) -> bool:
    """Process a single broker's thread. Returns True if any action was taken."""
    if gmail is None:
        return False

    thread = gmail.get_thread(record.thread_id)
    if not thread:
        return False

    latest_thread_message = thread[-1]
    if _message_already_processed(record, latest_thread_message):
        log.info(
            "poll_message_already_processed",
            broker=record.broker_id,
            message_id=latest_thread_message.message_id,
            thread_id=record.thread_id,
        )
        return False

    # Find the latest message we haven't processed
    sender_email = _sender_address(settings.sender_email)
    new_messages = []
    for message in thread:
        if _message_already_processed(record, message):
            continue

        message_sender = _sender_address(message.sender)
        if message_sender == sender_email:
            if not settings.allow_self_reply:
                continue
            log.warning(
                "self_reply_bypass_active",
                broker=record.broker_id,
                sender=message_sender,
            )

        new_messages.append(message)

    if not new_messages:
        return False

    latest = new_messages[-1]
    latest_reply_body = parse_latest_reply(latest.body)
    log.info(
        "poll_new_message",
        broker=record.broker_id,
        from_=latest.sender,
        subject=latest.subject,
    )

    # Whitelist check: only process replies from whitelisted senders
    latest_sender = _sender_address(latest.sender)
    sender_matched_domain = _matching_sender_domain(
        latest_sender, broker_sender_domains or set()
    )
    if not store.is_whitelisted(latest_sender) and sender_matched_domain is None:
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
        if _needs_manual_already_recorded(record, latest):
            return False
        transition_to_needs_manual(
            record,
            reason_code="untrusted_sender_reply",
            short_summary=f"Reply came from untrusted sender {latest_sender}.",
            notes=(
                f"Reply received from untrusted sender {latest_sender} - "
                "approve in Trusted Senders if legitimate"
            ),
            broker_reply_excerpt=_broker_reply_excerpt(latest, latest_reply_body),
            raw_reply_body=latest.body,
        )
        _upsert_processed_broker_reply(store, record, latest)
        log.warning(
            "poll_needs_manual_untrusted_sender",
            broker=record.broker_id,
            sender=latest_sender,
        )
        return True

    if sender_matched_domain is not None:
        log.info(
            "poll_sender_domain_trusted",
            broker=record.broker_id,
            sender=latest_sender,
            matched_domain=sender_matched_domain,
        )

    if ai_client is None:
        notes = _missing_classifier_notes(settings)
        log.warning(
            "poll_no_ai_classifier",
            broker=record.broker_id,
            provider=settings.ai_provider,
        )
        if _needs_manual_already_recorded(record, latest):
            return False
        transition_to_needs_manual(
            record,
            reason_code="other",
            short_summary=notes,
            notes=notes,
            broker_reply_excerpt=_broker_reply_excerpt(latest, latest_reply_body),
            raw_reply_body=latest.body,
            classifier_output={
                "provider": settings.ai_provider,
                "error": "classifier_unavailable",
            },
        )
        _upsert_processed_broker_reply(store, record, latest)
        return True

    # Classify the reply
    if settings.ai_provider == "anthropic":
        analysis = classify_reply(
            client=ai_client,
            model=settings.anthropic_model,
            broker_name=broker_name,
            subject=latest.subject,
            body=latest_reply_body,
        )
    else:
        analysis = classify_reply_gemini(
            client=ai_client,
            model=settings.gemini_model,
            broker_name=broker_name,
            subject=latest.subject,
            body=latest_reply_body,
        )

    log.info(
        "poll_classified",
        broker=record.broker_id,
        classification=analysis.classification.value,
        requested_fields=[field.value for field in analysis.requested_fields],
        provider=settings.ai_provider,
    )

    return _handle_classification(
        settings=settings,
        record=record,
        broker_name=broker_name,
        broker_email=broker_email,
        latest=latest,
        latest_reply_body=latest_reply_body,
        analysis=analysis,
        store=store,
        gmail=gmail,
        ai_client=ai_client,
    )


def _message_already_processed(record: OptOutRecord, message: EmailMessage) -> bool:
    return bool(message.message_id and message.message_id == record.last_message_id)


def _upsert_processed_broker_reply(
    store: StateStore,
    record: OptOutRecord,
    message: EmailMessage,
) -> None:
    record.last_message_id = message.message_id
    store.upsert(record)


def _needs_manual_already_recorded(
    record: OptOutRecord,
    message: EmailMessage,
) -> bool:
    if record.status != BrokerStatus.NEEDS_MANUAL:
        return False
    if not _message_already_processed(record, message):
        return False
    log.info(
        "poll_needs_manual_already_recorded",
        broker=record.broker_id,
        message_id=message.message_id,
    )
    return True


def _missing_classifier_notes(settings: Settings) -> str:
    if settings.ai_provider == "anthropic":
        return "No Anthropic API key configured"
    return f"No AI classifier configured for provider: {settings.ai_provider}"


def _sender_address(sender: str) -> str:
    """Return the bare address from a raw email sender header."""
    parsed = parseaddr(sender)[1]
    return (parsed or sender).strip().lower()


def _broker_sender_domains(broker: Broker) -> set[str]:
    """Return domains trusted for replies from this broker."""
    domains = [
        broker.domain,
        *broker.aliases,
        _domain_from_email(broker.privacy_email),
    ]
    return {domain for raw in domains if (domain := _normalize_domain(raw))}


def _domain_from_email(email: str) -> str:
    address = _sender_address(email)
    if "@" not in address:
        return ""
    return address.rsplit("@", 1)[1]


def _matching_sender_domain(sender: str, allowed_domains: set[str]) -> str | None:
    sender_domain = _domain_from_email(sender)
    if not sender_domain:
        return None
    for domain in sorted(allowed_domains, key=len, reverse=True):
        if _domain_matches(sender_domain, domain):
            return domain
    return None


def _domain_matches(sender_domain: str, allowed_domain: str) -> bool:
    sender_domain = _normalize_domain(sender_domain)
    allowed_domain = _normalize_domain(allowed_domain)
    return sender_domain == allowed_domain or sender_domain.endswith(
        f".{allowed_domain}"
    )


def _normalize_domain(domain: str) -> str:
    return domain.strip().lower().rstrip(".")


def _handle_classification(
    settings: Settings,
    record: OptOutRecord,
    broker_name: str,
    broker_email: str,
    latest: EmailMessage,
    latest_reply_body: str,
    analysis: ReplyAnalysis,
    store: StateStore,
    gmail: GmailClient,
    ai_client: Any | None,
) -> bool:
    """Handle a classified reply. Returns True if action was taken."""
    now = utc_now()
    classification = analysis.classification
    if _needs_manual_already_recorded(record, latest):
        return False

    if classification == ReplyClassification.COMPLETED:
        validate_transition(record.status, BrokerStatus.COMPLETED)
        record.status = BrokerStatus.COMPLETED
        record.last_completed_at = now
        record.updated_at = now
        _upsert_processed_broker_reply(store, record, latest)
        log.info("poll_completed", broker=record.broker_id)
        return True

    if classification == ReplyClassification.REJECTED:
        if record.status == BrokerStatus.REJECTED_REBUTTED:
            validate_transition(record.status, BrokerStatus.REJECTED)
            record.status = BrokerStatus.REJECTED
            record.updated_at = now
            _upsert_processed_broker_reply(store, record, latest)
            log.info("poll_rejected_after_rebuttal", broker=record.broker_id)
            return True

        record.last_message_id = latest.message_id
        classifier_output = _classifier_output(analysis)
        transition_to_needs_manual(
            record,
            reason_code="broker_rejected",
            short_summary=(
                "Broker rejected the deletion request. Review and choose to "
                "accept or escalate."
            ),
            notes=_manual_review_notes(latest),
            broker_reply_excerpt=_broker_reply_excerpt(
                latest,
                latest_reply_body,
                classifier_output=classifier_output,
            ),
            raw_reply_body=latest.body,
            classifier_output=classifier_output,
            missing_fields=[],
            now=now,
        )
        _upsert_processed_broker_reply(store, record, latest)
        log.info("poll_rejected_needs_manual", broker=record.broker_id)
        return True

    if classification == ReplyClassification.NEEDS_MANUAL:
        record.last_message_id = latest.message_id
        classifier_output = _classifier_output(analysis)
        transition_to_needs_manual(
            record,
            reason_code="classifier_returned_needs_manual",
            short_summary="Classifier flagged the broker reply for manual review.",
            notes=_manual_review_notes(latest),
            broker_reply_excerpt=_broker_reply_excerpt(
                latest,
                latest_reply_body,
                classifier_output=classifier_output,
            ),
            raw_reply_body=latest.body,
            classifier_output=classifier_output,
            now=now,
        )
        _upsert_processed_broker_reply(store, record, latest)
        log.info("poll_needs_manual", broker=record.broker_id)
        return True

    if classification == ReplyClassification.UNRELATED:
        # Ignore unrelated messages, just update tracking
        record.updated_at = now
        _upsert_processed_broker_reply(store, record, latest)
        return False

    if classification == ReplyClassification.ACKNOWLEDGMENT:
        validate_transition(record.status, BrokerStatus.AWAITING_RESPONSE)
        record.status = BrokerStatus.AWAITING_RESPONSE
        record.updated_at = now
        _upsert_processed_broker_reply(store, record, latest)
        log.info("poll_ack_awaiting", broker=record.broker_id)
        return True

    if classification == ReplyClassification.INFO_REQUEST:
        return _handle_info_request(
            settings=settings,
            record=record,
            broker_name=broker_name,
            broker_email=broker_email,
            latest=latest,
            latest_reply_body=latest_reply_body,
            requested_fields=analysis.requested_fields,
            other_details=analysis.other_details,
            store=store,
            gmail=gmail,
            ai_client=ai_client,
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


def _broker_reply_excerpt(
    message: EmailMessage,
    latest_reply_body: str | None = None,
    *,
    classifier_output: dict[str, Any] | None = None,
) -> str:
    classifier_summary = _classifier_summary_excerpt(classifier_output or {})
    if classifier_summary:
        return _truncate_reply_excerpt(classifier_summary)

    parsed_body = (
        latest_reply_body
        if latest_reply_body is not None
        else parse_latest_reply(message.body)
    )
    fallback_body = parsed_body.strip() or message.subject.strip()
    for source in (parsed_body, message.body):
        body = _useful_reply_excerpt(source)
        if body:
            return _truncate_reply_excerpt(body)
    if fallback_body:
        return _truncate_reply_excerpt(f"{_BOILERPLATE_FALLBACK_PREFIX}{fallback_body}")
    return ""


def _classifier_summary_excerpt(classifier_output: dict[str, Any]) -> str:
    for key in _CLASSIFIER_SUMMARY_KEYS:
        value = classifier_output.get(key)
        if not isinstance(value, str):
            continue
        summary = value.strip()
        if summary:
            return f"Classifier summary: {summary}"
    return ""


def _useful_reply_excerpt(raw_body: str) -> str:
    body = _normalize_reply_body(raw_body)
    if not body:
        return ""

    candidates = _reply_excerpt_candidates(body)
    for candidate in candidates:
        useful = _clean_reply_excerpt_candidate(candidate)
        if useful and not _starts_with_boilerplate(useful):
            return useful
    return ""


def _reply_excerpt_candidates(body: str) -> list[str]:
    lines = body.splitlines()
    candidates: list[str] = []
    for index, line in enumerate(lines):
        if _is_reply_separator(line):
            candidates.append("\n".join(lines[index + 1 :]))
    candidates.append(body)
    return candidates


def _clean_reply_excerpt_candidate(candidate: str) -> str:
    lines = candidate.splitlines()
    cleaned: list[str] = []
    seen_content = False

    for raw_line in lines:
        line = raw_line.strip()
        if line.startswith(">"):
            line = line.lstrip("> ").strip()
        if not line:
            if seen_content:
                cleaned.append("")
            continue
        if not seen_content and _is_boilerplate_line(line):
            continue
        if not seen_content and _is_reply_separator(line):
            continue
        if not seen_content and _EMAIL_HEADER_RE.match(line):
            continue
        if not seen_content and _URL_ONLY_RE.match(line):
            continue
        cleaned.append(line)
        seen_content = True

    return _trim_reply_excerpt_lines(cleaned)


def _normalize_reply_body(body: str) -> str:
    return body.replace("\r\n", "\n").replace("\r", "\n").strip()


def _trim_reply_excerpt_lines(lines: list[str]) -> str:
    start = 0
    end = len(lines)
    while start < end and not lines[start].strip():
        start += 1
    while end > start and not lines[end - 1].strip():
        end -= 1
    return "\n".join(lines[start:end]).strip()


def _starts_with_boilerplate(body: str) -> bool:
    leading = "\n".join(body.splitlines()[:4])
    return bool(_BOILERPLATE_MARKER_RE.search(leading))


def _is_boilerplate_line(line: str) -> bool:
    return bool(_BOILERPLATE_MARKER_RE.search(line))


def _is_reply_separator(line: str) -> bool:
    return bool(
        _TICKETING_SEPARATOR_RE.match(line)
        or _HORIZONTAL_RULE_RE.match(line)
        or _ORIGINAL_MESSAGE_RE.match(line)
        or _EMAIL_QUOTED_SEPARATOR_RE.match(line)
    )


def _truncate_reply_excerpt(body: str) -> str:
    return body[:BROKER_REPLY_EXCERPT_LIMIT]


def _classifier_output(analysis: ReplyAnalysis) -> dict[str, Any]:
    return {
        "classification": analysis.classification.value,
        "requested_fields": [field.value for field in analysis.requested_fields],
        "other_details": analysis.other_details,
    }


def transition_to_needs_manual(
    record: OptOutRecord,
    *,
    reason_code: str,
    short_summary: str,
    notes: str | None = None,
    broker_reply_excerpt: str = "",
    raw_reply_body: str | None = None,
    classifier_output: dict[str, Any] | None = None,
    missing_fields: list[str] | None = None,
    now: datetime | None = None,
) -> None:
    """Atomically remember state and reason before moving to manual review."""
    transitioned_at = now or utc_now()
    previous_status = record.status
    validate_transition(previous_status, BrokerStatus.NEEDS_MANUAL)
    record.previous_status = previous_status
    record.status = BrokerStatus.NEEDS_MANUAL
    if notes is not None:
        record.notes = notes
    record.needs_manual_reason = NeedsManualReason(
        reason_code=reason_code,
        short_summary=short_summary,
        broker_reply_excerpt=broker_reply_excerpt[:BROKER_REPLY_EXCERPT_LIMIT],
        raw_reply_body=raw_reply_body,
        classifier_output=classifier_output or {},
        missing_fields=missing_fields or [],
        transitioned_at=transitioned_at,
    )
    record.updated_at = transitioned_at


def _handle_info_request(
    settings: Settings,
    record: OptOutRecord,
    broker_name: str,
    broker_email: str,
    latest: EmailMessage,
    latest_reply_body: str,
    requested_fields: list[VerificationField],
    other_details: str,
    store: StateStore,
    gmail: GmailClient,
    ai_client: Any | None,
) -> bool:
    """Handle a broker follow-up requesting additional information."""
    now = utc_now()

    if record.status == BrokerStatus.FOLLOW_UP_SENT and _message_already_processed(
        record, latest
    ):
        log.info(
            "poll_follow_up_already_sent",
            broker=record.broker_id,
            message_id=latest.message_id,
        )
        return False

    if record.retries >= settings.max_retries:
        record.status = BrokerStatus.FAILED
        record.notes = "Max retries exceeded"
        record.updated_at = now
        _upsert_processed_broker_reply(store, record, latest)
        log.warning("poll_max_retries", broker=record.broker_id)
        return True

    requested_fields = _dedupe_requested_fields(requested_fields)
    profile = store.get_verification_profile()
    missing_fields, manual_reason = _profile_gap(
        profile=profile,
        requested_fields=requested_fields,
        other_details=other_details,
    )
    record.requested_fields = [field.value for field in requested_fields]
    record.missing_fields = [field.value for field in missing_fields]
    record.requested_other_details = other_details.strip()

    if missing_fields:
        classifier_output = {
            "classification": ReplyClassification.INFO_REQUEST.value,
            "requested_fields": [field.value for field in requested_fields],
            "other_details": other_details,
        }
        transition_to_needs_manual(
            record,
            reason_code=_info_request_reason_code(missing_fields),
            short_summary=_info_request_short_summary(
                missing_fields=missing_fields,
                manual_reason=manual_reason,
            ),
            notes=_info_request_manual_notes(
                requested_fields=requested_fields,
                missing_fields=missing_fields,
                reason=manual_reason,
                latest=latest,
                other_details=other_details,
            ),
            broker_reply_excerpt=_broker_reply_excerpt(
                latest,
                latest_reply_body,
                classifier_output=classifier_output,
            ),
            raw_reply_body=latest.body,
            classifier_output=classifier_output,
            missing_fields=[field.value for field in missing_fields],
            now=now,
        )
        _upsert_processed_broker_reply(store, record, latest)
        log.info(
            "poll_info_request_needs_manual",
            broker=record.broker_id,
            requested_fields=record.requested_fields,
            missing_fields=record.missing_fields,
        )
        return True

    validate_transition(record.status, BrokerStatus.INFO_REQUESTED)
    record.status = BrokerStatus.INFO_REQUESTED
    record.notes = _info_request_sent_notes(requested_fields)
    record.updated_at = now
    _upsert_processed_broker_reply(store, record, latest)

    verification_lines = _verification_lines(profile, requested_fields)
    fallback_body = render_verification_profile_follow_up(
        broker_name=broker_name,
        sender_name=settings.sender_name,
        verification_lines=verification_lines,
        document_labels=_requested_document_labels(profile, requested_fields),
    )
    subject, body = _compose_or_fallback(
        settings=settings,
        ai_client=ai_client,
        broker_name=broker_name,
        broker_subject=latest.subject,
        broker_body=latest.body,
        classifier_result=ReplyAnalysis(
            classification=ReplyClassification.INFO_REQUEST,
            requested_fields=requested_fields,
            other_details=other_details,
        ),
        target_action=ResponseTargetAction.INFO_RESPONSE,
        placeholders=_response_placeholders(
            settings=settings,
            broker_name=broker_name,
            broker_subject=latest.subject,
            verification_lines=verification_lines,
            requested_fields=_format_field_list(requested_fields),
            document_labels=_requested_document_labels(profile, requested_fields),
        ),
        fallback_subject=f"Re: {latest.subject}",
        fallback_body=fallback_body,
    )

    if settings.dry_run:
        log.info("dry_run_follow_up_reply", broker=record.broker_id)
    else:
        # Replies stay in the original Gmail thread, so Gmail preserves the
        # poll label applied by outreach.
        gmail.send(
            to=broker_email,
            subject=subject,
            body=body,
            sender=settings.sender_email,
            sender_name=settings.sender_name,
            thread_id=record.thread_id,
        )

    validate_transition(record.status, BrokerStatus.FOLLOW_UP_SENT)
    record.status = BrokerStatus.FOLLOW_UP_SENT
    record.missing_fields = []
    record.retries += 1
    record.updated_at = utc_now()
    _upsert_processed_broker_reply(store, record, latest)

    log.info("poll_follow_up_sent", broker=record.broker_id, retries=record.retries)
    return True


def _handle_rejection_rebuttal(
    settings: Settings,
    record: OptOutRecord,
    broker_name: str,
    broker_email: str,
    latest: EmailMessage,
    analysis: ReplyAnalysis,
    store: StateStore,
    gmail: GmailClient | None,
    ai_client: Any | None,
    user_context: str | None = None,
) -> bool:
    """Send one polite rebuttal before accepting a broker rejection as terminal."""
    fallback_body = render_rejection_rebuttal(
        broker_name=broker_name,
        sender_name=settings.sender_name,
    )
    subject, body = _compose_or_fallback(
        settings=settings,
        ai_client=ai_client,
        broker_name=broker_name,
        broker_subject=latest.subject,
        broker_body=latest.body,
        classifier_result=analysis,
        target_action=ResponseTargetAction.REJECTION_REBUTTAL,
        user_context=user_context,
        placeholders=_response_placeholders(
            settings=settings,
            broker_name=broker_name,
            broker_subject=latest.subject,
        ),
        fallback_subject=f"Re: {latest.subject}",
        fallback_body=fallback_body,
    )

    if settings.dry_run:
        log.info("dry_run_rejection_rebuttal", broker=record.broker_id)
    else:
        if gmail is None:
            log.error("no_gmail_client", broker=record.broker_id)
            return False
        gmail.send(
            to=broker_email,
            subject=subject,
            body=body,
            sender=settings.sender_email,
            sender_name=settings.sender_name,
            thread_id=record.thread_id,
        )

    validate_transition(record.status, BrokerStatus.REJECTED_REBUTTED)
    record.status = BrokerStatus.REJECTED_REBUTTED
    record.previous_status = None
    record.needs_manual_reason = None
    record.notes = "Broker rejection rebutted once; waiting for broker response."
    record.updated_at = utc_now()
    _upsert_processed_broker_reply(store, record, latest)
    log.info("poll_rejection_rebuttal_sent", broker=record.broker_id)
    return True


def _compose_or_fallback(
    *,
    settings: Settings,
    ai_client: Any | None,
    broker_name: str,
    broker_subject: str,
    broker_body: str,
    classifier_result: ReplyAnalysis,
    target_action: ResponseTargetAction,
    user_context: str | None = None,
    placeholders: dict[str, object],
    fallback_subject: str,
    fallback_body: str,
) -> tuple[str, str]:
    """Compose via LLM, render locally, and fall back to templates on any error."""
    if ai_client is None:
        log.warning(
            "response_composer_fallback",
            broker=broker_name,
            target_action=target_action.value,
            provider=settings.ai_provider,
            reason="no AI client configured",
        )
        return fallback_subject, fallback_body

    model = (
        settings.anthropic_model
        if settings.ai_provider == "anthropic"
        else settings.gemini_model
    )
    try:
        skeleton = compose_response_skeleton(
            client=ai_client,
            provider=settings.ai_provider,
            model=model,
            broker_name=broker_name,
            broker_subject=broker_subject,
            broker_body=broker_body,
            classifier_result=classifier_result,
            target_action=target_action,
            user_context=user_context,
        )
        rendered = render_response_skeleton(skeleton, placeholders)
    except Exception as exc:
        log.warning(
            "response_composer_fallback",
            broker=broker_name,
            target_action=target_action.value,
            provider=settings.ai_provider,
            reason=str(exc),
        )
        return fallback_subject, fallback_body

    return rendered.subject, rendered.body


def _response_placeholders(
    *,
    settings: Settings,
    broker_name: str,
    broker_subject: str,
    verification_lines: list[str] | None = None,
    requested_fields: str = "",
    missing_fields: str = "",
    document_labels: list[str] | None = None,
) -> dict[str, object]:
    verification_lines = verification_lines or []
    document_labels = document_labels or []
    return {
        "broker_name": broker_name,
        "broker_subject": broker_subject,
        "sender_name": settings.sender_name,
        "verification_lines": _bullet_lines(verification_lines),
        "verification_line_items": verification_lines,
        "requested_fields": requested_fields,
        "missing_fields": missing_fields,
        "document_labels": ", ".join(document_labels),
        "document_label_items": document_labels,
        "additional_notes": "",
    }


def _bullet_lines(lines: list[str]) -> str:
    return "\n".join(f"- {line}" for line in lines if line.strip())


def _dedupe_requested_fields(
    requested_fields: list[VerificationField],
) -> list[VerificationField]:
    deduped: list[VerificationField] = []
    seen: set[VerificationField] = set()
    for field in requested_fields:
        if field in seen:
            continue
        seen.add(field)
        deduped.append(field)
    return deduped


def _profile_gap(
    profile: VerificationProfile,
    requested_fields: list[VerificationField],
    other_details: str,
) -> tuple[list[VerificationField], str]:
    if not requested_fields:
        return (
            [VerificationField.OTHER],
            (
                "Broker requested more information, but Smokescreen could not "
                "identify the exact fields."
            ),
        )

    missing_fields: list[VerificationField] = []
    reasons: list[str] = []
    if VerificationField.OTHER in requested_fields:
        missing_fields.append(VerificationField.OTHER)
        detail = other_details.strip()
        reasons.append(
            f"Broker requested other information: {detail}."
            if detail
            else (
                "Broker requested information outside the supported verification "
                "profile fields."
            )
        )

    for field in requested_fields:
        if field == VerificationField.OTHER:
            continue
        if not _profile_has_field(profile, field):
            missing_fields.append(field)
            if field == VerificationField.DOCUMENTS:
                reasons.append(
                    "documents-not-available: The verification profile does not "
                    "list any available document labels."
                )

    if not reasons and missing_fields:
        reasons.append(
            "The verification profile is missing one or more requested fields."
        )

    return _dedupe_requested_fields(missing_fields), " ".join(reasons)


def _profile_has_field(
    profile: VerificationProfile,
    field: VerificationField,
) -> bool:
    if field == VerificationField.HOME_ADDRESS:
        return bool(_complete_home_addresses(profile))
    if field == VerificationField.PHONE_NUMBER:
        return any(value.strip() for value in profile.phone_numbers)
    if field == VerificationField.EMAIL_ALIAS:
        return any(value.strip() for value in profile.email_aliases)
    if field == VerificationField.DATE_OF_BIRTH:
        return bool((profile.date_of_birth or "").strip())
    if field == VerificationField.LAST_FOUR_SSN:
        return bool((profile.last_four_ssn or "").strip())
    if field == VerificationField.EMPLOYER_NAME:
        return bool((profile.employer_name or "").strip())
    if field == VerificationField.DOCUMENTS:
        return bool(_available_document_labels(profile))
    return False


def _complete_home_addresses(
    profile: VerificationProfile,
) -> list[VerificationAddress]:
    return [
        address
        for address in profile.home_addresses
        if address.street.strip()
        and address.city.strip()
        and address.state.strip()
        and address.zip.strip()
    ]


def _verification_lines(
    profile: VerificationProfile,
    requested_fields: list[VerificationField],
) -> list[str]:
    lines: list[str] = []
    for field in requested_fields:
        if field == VerificationField.HOME_ADDRESS:
            for index, address in enumerate(_complete_home_addresses(profile), start=1):
                label = "Home address" if index == 1 else f"Home address {index}"
                lines.append(f"{label}: {_format_address(address)}")
        elif field == VerificationField.PHONE_NUMBER:
            lines.append(
                f"Phone number: {', '.join(_non_empty(profile.phone_numbers))}"
            )
        elif field == VerificationField.EMAIL_ALIAS:
            lines.append(
                f"Email alias: {', '.join(_non_empty(profile.email_aliases))}"
            )
        elif field == VerificationField.DATE_OF_BIRTH:
            lines.append(f"Date of birth: {(profile.date_of_birth or '').strip()}")
        elif field == VerificationField.LAST_FOUR_SSN:
            lines.append(f"Last four SSN: {(profile.last_four_ssn or '').strip()}")
        elif field == VerificationField.EMPLOYER_NAME:
            lines.append(f"Employer name: {(profile.employer_name or '').strip()}")
    return lines


def _format_address(address: VerificationAddress) -> str:
    state_zip = " ".join(
        part for part in [address.state.strip(), address.zip.strip()] if part
    )
    city_line = ", ".join(part for part in [address.city.strip(), state_zip] if part)
    parts = [address.street.strip(), city_line, address.country.strip()]
    return "; ".join(part for part in parts if part)


def _requested_document_labels(
    profile: VerificationProfile,
    requested_fields: list[VerificationField],
) -> list[str]:
    if VerificationField.DOCUMENTS not in requested_fields:
        return []
    return _available_document_labels(profile)


def _available_document_labels(profile: VerificationProfile) -> list[str]:
    return [
        label
        for label in (_document_label(doc) for doc in profile.documents)
        if label
    ]


def _document_label(document: VerificationDocument) -> str:
    return document.label.strip()


def _non_empty(values: list[str]) -> list[str]:
    return [value.strip() for value in values if value.strip()]


def _info_request_sent_notes(requested_fields: list[VerificationField]) -> str:
    return (
        "Broker asked for: "
        f"{_format_field_list(requested_fields)}. "
        "Sent matching fields from the Verification Profile."
    )


def _info_request_manual_notes(
    requested_fields: list[VerificationField],
    missing_fields: list[VerificationField],
    reason: str,
    latest: EmailMessage,
    other_details: str,
) -> str:
    notes = (
        "Broker asked for: "
        f"{_format_field_list(requested_fields) or 'Unclear additional information'}. "
        f"You are missing: {_format_field_list(missing_fields)}."
    )
    if reason:
        notes = f"{notes} {reason}"
    if other_details.strip() and VerificationField.OTHER in missing_fields:
        notes = f"{notes} Details: {other_details.strip()}."
    message_notes = _manual_review_notes(latest)
    return f"{notes}\n\nBroker reply:\n{message_notes}"


def _info_request_reason_code(missing_fields: list[VerificationField]) -> str:
    if VerificationField.DOCUMENTS in missing_fields:
        return "documents_requested_none_available"
    return "info_request_missing_fields"


def _info_request_short_summary(
    *,
    missing_fields: list[VerificationField],
    manual_reason: str,
) -> str:
    if VerificationField.DOCUMENTS in missing_fields:
        return "Broker requested documents, but no documents are available to send."
    fields = _format_field_list(missing_fields)
    if fields:
        return (
            "Broker requested information missing from the Verification Profile: "
            f"{fields}."
        )
    return manual_reason or "Broker requested information Smokescreen cannot provide."


def _format_field_list(fields: list[VerificationField]) -> str:
    return ", ".join(_PROFILE_FIELD_LABELS[field] for field in fields)


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
    composer_client: Any | None = None
    composer_client_built = False

    def response_composer_client() -> Any | None:
        nonlocal composer_client, composer_client_built
        if composer_client_built:
            return composer_client
        composer_client_built = True
        try:
            composer_client = _build_classifier_client(settings)
        except Exception as exc:
            log.warning(
                "response_composer_client_unavailable",
                provider=settings.ai_provider,
                reason=str(exc),
            )
            composer_client = None
        return composer_client

    # Ping first-timeout records (waiting state → paired *_PINGED).
    for status in WAITING_STATES:
        for record in store.list_by_status(status):
            try:
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
                    ai_client=response_composer_client(),
                )
                processed.append(record.broker_id)
            except Exception as exc:
                _log_record_exception(
                    "timeout_record_processing_failed",
                    record,
                    exc,
                    current_status=record.status.value,
                )
                continue

    # Escalate second-timeout records (*_PINGED → NEEDS_MANUAL).
    for waiting_state, pinged_state in PINGED_STATE.items():
        for record in store.list_by_status(pinged_state):
            try:
                if not _is_stale(record, now, timeout_days):
                    continue
                _escalate_to_needs_manual(
                    record=record,
                    previous_state=waiting_state,
                    store=store,
                    now=now,
                )
                processed.append(record.broker_id)
            except Exception as exc:
                _log_record_exception(
                    "timeout_record_processing_failed",
                    record,
                    exc,
                    current_status=record.status.value,
                )
                continue

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
    ai_client: Any | None,
) -> None:
    """Send a friendly status-check ping and transition to the paired state."""
    fallback_subject = f"Re: deletion request for {settings.sender_name}"
    fallback_body = render_silent_ping(
        broker_name=broker_name,
        sender_name=settings.sender_name,
    )
    subject, body = _compose_or_fallback(
        settings=settings,
        ai_client=ai_client,
        broker_name=broker_name,
        broker_subject="",
        broker_body="",
        classifier_result=ReplyAnalysis(
            classification=ReplyClassification.UNRELATED,
        ),
        target_action=ResponseTargetAction.SILENT_PING,
        placeholders=_response_placeholders(
            settings=settings,
            broker_name=broker_name,
            broker_subject="",
        ),
        fallback_subject=fallback_subject,
        fallback_body=fallback_body,
    )

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
            subject=subject,
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
    transition_to_needs_manual(
        record,
        reason_code="timeout_escalation_second_window",
        short_summary="No broker reply after two timeout windows.",
        notes=f"escalated after two silent periods on {previous_state.value}",
        classifier_output={
            "previous_state": previous_state.value,
            "timed_out_status": record.status.value,
        },
        now=now,
    )
    store.upsert(record)
    log.warning(
        "poll_timeout_escalated",
        broker=record.broker_id,
        previous_state=previous_state.value,
    )
