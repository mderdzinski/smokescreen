"""Compose AI-generated replies to broker emails."""

from __future__ import annotations

import structlog
from anthropic import Anthropic

from smokescreen.ai.prompts import COMPOSER_SYSTEM, COMPOSER_USER
from smokescreen.models import ReplyClassification

log = structlog.get_logger()


def compose_reply(
    client: Anthropic,
    model: str,
    broker_name: str,
    classification: ReplyClassification,
    broker_reply: str,
    sender_name: str,
) -> str:
    """Compose a reply to a broker's email.

    Only the email text is sent to Claude — never attachments or identity docs.
    """
    response = client.messages.create(
        model=model,
        max_tokens=500,
        system=COMPOSER_SYSTEM,
        messages=[
            {
                "role": "user",
                "content": COMPOSER_USER.format(
                    broker_name=broker_name,
                    classification=classification.value,
                    broker_reply=broker_reply,
                    sender_name=sender_name,
                ),
            }
        ],
    )

    reply_text = response.content[0].text.strip()
    log.info("reply_composed", broker=broker_name, length=len(reply_text))
    return reply_text
