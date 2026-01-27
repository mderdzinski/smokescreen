"""Classify broker email replies using Claude."""

from __future__ import annotations

import structlog
from anthropic import Anthropic

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

    Only the email text is sent to Claude — never attachments or identity docs.
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

    if label not in _VALID_LABELS:
        log.warning("unknown_classification", label=label, broker=broker_name)
        return ReplyClassification.NEEDS_MANUAL

    return ReplyClassification(label)
