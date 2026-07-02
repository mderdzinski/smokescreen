"""Classify broker email replies using configured AI providers."""

from __future__ import annotations

from typing import Any

import structlog
from anthropic import Anthropic
from google.genai import types

from smokescreen.ai.prompts import CLASSIFIER_SYSTEM, CLASSIFIER_USER
from smokescreen.models import ReplyClassification

log = structlog.get_logger()

_VALID_LABELS = {c.value for c in ReplyClassification}


def classify_reply(
    client: Anthropic,
    model: str,
    broker_name: str,
    subject: str,
    body: str,
) -> ReplyClassification:
    """Classify a broker's email reply.

    Only the email text is sent to Claude, never attachments or identity docs.
    """
    response = client.messages.create(
        model=model,
        max_tokens=50,
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

    label = response.content[0].text.strip().upper()
    return _classification_from_label(label, broker_name)


def classify_reply_gemini(
    client: Any,
    model: str,
    broker_name: str,
    subject: str,
    body: str,
) -> ReplyClassification:
    """Classify a broker's email reply with Vertex AI Gemini.

    Only the email text is sent to Gemini, never attachments or identity docs.
    """
    response = client.models.generate_content(
        model=model,
        contents=CLASSIFIER_USER.format(
            broker_name=broker_name,
            subject=subject,
            body=body,
        ),
        config=types.GenerateContentConfig(
            max_output_tokens=50,
            system_instruction=CLASSIFIER_SYSTEM,
            temperature=0,
        ),
    )

    label = _gemini_response_text(response).strip().upper()
    return _classification_from_label(label, broker_name)


def _gemini_response_text(response: Any) -> str:
    text = getattr(response, "text", "")
    return "" if text is None else str(text)


def _classification_from_label(label: str, broker_name: str) -> ReplyClassification:
    if label not in _VALID_LABELS:
        log.warning("unknown_classification", label=label, broker=broker_name)
        return ReplyClassification.NEEDS_MANUAL

    return ReplyClassification(label)
