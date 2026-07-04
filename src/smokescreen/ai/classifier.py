"""Classify broker email replies using configured AI providers."""

from __future__ import annotations

import json
import re
from typing import Any

import structlog
from anthropic import Anthropic
from google.genai import types

from smokescreen.ai.prompts import CLASSIFIER_SYSTEM, CLASSIFIER_USER
from smokescreen.models import ReplyAnalysis, ReplyClassification, VerificationField

log = structlog.get_logger()

_VALID_LABELS = {c.value for c in ReplyClassification}


def classify_reply(
    client: Anthropic,
    model: str,
    broker_name: str,
    subject: str,
    body: str,
) -> ReplyAnalysis:
    """Classify a broker's email reply.

    Only the email text is sent to Claude, never attachments or verification data.
    """
    response = client.messages.create(
        model=model,
        max_tokens=250,
        system=CLASSIFIER_SYSTEM,
        messages=[
            {
                "role": "user",
                "content": CLASSIFIER_USER.format(
                    broker_name=broker_name,
                    subject=subject,
                    body=body,
                ),
            }
        ],
    )

    return _analysis_from_text(response.content[0].text, broker_name)


def classify_reply_gemini(
    client: Any,
    model: str,
    broker_name: str,
    subject: str,
    body: str,
) -> ReplyAnalysis:
    """Classify a broker's email reply with Vertex AI Gemini.

    Only the email text is sent to Gemini, never attachments or verification data.
    """
    response = client.models.generate_content(
        model=model,
        contents=CLASSIFIER_USER.format(
            broker_name=broker_name,
            subject=subject,
            body=body,
        ),
        config=types.GenerateContentConfig(
            max_output_tokens=250,
            system_instruction=CLASSIFIER_SYSTEM,
            temperature=0,
        ),
    )

    return _analysis_from_text(_gemini_response_text(response), broker_name)


def _gemini_response_text(response: Any) -> str:
    text = getattr(response, "text", "")
    return "" if text is None else str(text)


def _analysis_from_text(text: str, broker_name: str) -> ReplyAnalysis:
    stripped = text.strip()
    parsed = _parse_json_payload(stripped)
    if parsed is not None:
        return _analysis_from_payload(parsed, broker_name)
    return ReplyAnalysis(
        classification=_classification_from_label(stripped, broker_name)
    )


def _parse_json_payload(text: str) -> dict[str, Any] | None:
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, flags=re.DOTALL)
        if not match:
            return None
        try:
            parsed = json.loads(match.group(0))
        except json.JSONDecodeError:
            return None
    return parsed if isinstance(parsed, dict) else None


def _analysis_from_payload(payload: dict[str, Any], broker_name: str) -> ReplyAnalysis:
    classification = _classification_from_label(
        str(payload.get("classification", "")), broker_name
    )
    if classification != ReplyClassification.INFO_REQUEST:
        return ReplyAnalysis(classification=classification)

    raw_fields = payload.get("requested_fields", [])
    if not isinstance(raw_fields, list):
        raw_fields = []

    requested_fields: list[VerificationField] = []
    seen: set[VerificationField] = set()
    other_details = str(payload.get("other_details") or "").strip()
    for raw in raw_fields:
        field = _verification_field_from_raw(raw)
        if field is None:
            field = VerificationField.OTHER
            if not other_details and raw is not None:
                other_details = str(raw)
        if field in seen:
            continue
        seen.add(field)
        requested_fields.append(field)

    return ReplyAnalysis(
        classification=classification,
        requested_fields=requested_fields,
        other_details=other_details,
    )


def _verification_field_from_raw(value: object) -> VerificationField | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower().replace("-", "_").replace(" ", "_")
    aliases = {
        "address": VerificationField.HOME_ADDRESS,
        "addresses": VerificationField.HOME_ADDRESS,
        "home_addresses": VerificationField.HOME_ADDRESS,
        "phone": VerificationField.PHONE_NUMBER,
        "phones": VerificationField.PHONE_NUMBER,
        "phone_numbers": VerificationField.PHONE_NUMBER,
        "email": VerificationField.EMAIL_ALIAS,
        "emails": VerificationField.EMAIL_ALIAS,
        "email_aliases": VerificationField.EMAIL_ALIAS,
        "previous_email": VerificationField.EMAIL_ALIAS,
        "previous_emails": VerificationField.EMAIL_ALIAS,
        "dob": VerificationField.DATE_OF_BIRTH,
        "date_of_birth": VerificationField.DATE_OF_BIRTH,
        "ssn_last4": VerificationField.LAST_FOUR_SSN,
        "ssn_last_4": VerificationField.LAST_FOUR_SSN,
        "last_4_ssn": VerificationField.LAST_FOUR_SSN,
        "last_four_ssn": VerificationField.LAST_FOUR_SSN,
        "employer": VerificationField.EMPLOYER_NAME,
        "employer_name": VerificationField.EMPLOYER_NAME,
        "document": VerificationField.DOCUMENTS,
        "documents": VerificationField.DOCUMENTS,
        "government_id": VerificationField.DOCUMENTS,
        "id": VerificationField.DOCUMENTS,
        "proof_of_address": VerificationField.DOCUMENTS,
        "other": VerificationField.OTHER,
    }
    if normalized in aliases:
        return aliases[normalized]
    try:
        return VerificationField(normalized)
    except ValueError:
        return None


def _classification_from_label(label: str, broker_name: str) -> ReplyClassification:
    label = label.strip().upper()
    if label == "INFO_REQUESTED":
        label = ReplyClassification.INFO_REQUEST.value
    if label not in _VALID_LABELS:
        log.warning("unknown_classification", label=label, broker=broker_name)
        return ReplyClassification.NEEDS_MANUAL

    return ReplyClassification(label)
