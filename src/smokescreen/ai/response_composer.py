"""Compose structured response skeletons for broker replies."""

from __future__ import annotations

import enum
import json
import re
from collections.abc import Mapping
from typing import Any

import structlog
from google.genai import types
from jinja2 import Environment
from pydantic import BaseModel, field_validator

from smokescreen.models import ReplyAnalysis

log = structlog.get_logger()

_env = Environment(autoescape=False)


class ResponseTargetAction(str, enum.Enum):
    """High-level action the outbound response should perform."""

    INFO_RESPONSE = "INFO_RESPONSE"
    SILENT_PING = "SILENT_PING"
    REJECTION_REBUTTAL = "REJECTION_REBUTTAL"


class ResponseSkeleton(BaseModel):
    """LLM-produced response skeleton with local placeholder slots."""

    subject: str
    body: str
    notes: str = ""

    @field_validator("subject", "body")
    @classmethod
    def _must_not_be_blank(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("must not be blank")
        return stripped

    @field_validator("notes", mode="before")
    @classmethod
    def _notes_default(cls, value: object) -> str:
        return "" if value is None else str(value).strip()


RESPONSE_COMPOSER_SYSTEM = """\
You are a privacy assistant that composes email replies to data brokers.
Given the broker message and target action, produce JSON with subject, body,
and notes fields. The subject and body may contain Jinja2 double-brace
placeholder tokens that Smokescreen will substitute locally. Do not include
specific PII values yourself. Keep responses professional, concise, and cite
CCPA where relevant. Return only valid JSON.
"""

_ALLOWED_PLACEHOLDERS = """\
Allowed placeholders:
- {{ broker_name }} for the broker's display name
- {{ broker_subject }} for the broker's latest subject when replying
- {{ sender_name }} for the sender's name
- {{ verification_lines }} for locally rendered requested verification lines
- {{ document_labels }} for locally rendered available document labels
- {{ requested_fields }} for a locally rendered requested-field list
- {{ missing_fields }} for a locally rendered missing-field list
- {{ additional_notes }} for locally stored non-document verification notes
Do not invent or include actual personal values. Use placeholders instead.
"""

_TARGET_INSTRUCTIONS = {
    ResponseTargetAction.INFO_RESPONSE: (
        "Acknowledge the broker's request and provide the requested fields "
        "through placeholders, especially {{ verification_lines }}. Do not "
        "ask for documents or mention attachments."
    ),
    ResponseTargetAction.SILENT_PING: (
        "Send a brief status check on the pending deletion request. Ask the "
        "broker to confirm status or identify anything still needed."
    ),
    ResponseTargetAction.REJECTION_REBUTTAL: (
        "Politely challenge the rejection and ask the broker to process the "
        "deletion request or explain the legal basis for refusing it. Cite "
        "CCPA where appropriate."
    ),
}


def compose_response_skeleton(
    *,
    client: Any,
    provider: str,
    model: str,
    broker_name: str,
    broker_subject: str,
    broker_body: str,
    classifier_result: ReplyAnalysis,
    target_action: ResponseTargetAction | str,
    user_context: str | None = None,
) -> ResponseSkeleton:
    """Ask the configured LLM provider for a structured response skeleton.

    The prompt accepts only broker reply text, classifier output, broker name,
    and target action. Verification Profile data, sender name/email, attachment
    content, and historical store data are intentionally not parameters.
    """
    target = ResponseTargetAction(target_action)
    user_prompt = build_response_composer_user_prompt(
        broker_name=broker_name,
        broker_subject=broker_subject,
        broker_body=broker_body,
        classifier_result=classifier_result,
        target_action=target,
        user_context=user_context,
    )

    normalized_provider = provider.strip().lower()
    if normalized_provider == "anthropic":
        response = client.messages.create(
            model=model,
            max_tokens=700,
            system=RESPONSE_COMPOSER_SYSTEM,
            messages=[{"role": "user", "content": user_prompt}],
        )
        skeleton = _skeleton_from_text(_anthropic_response_text(response))
    elif normalized_provider == "gemini":
        response = client.models.generate_content(
            model=model,
            contents=user_prompt,
            config=types.GenerateContentConfig(
                max_output_tokens=700,
                system_instruction=RESPONSE_COMPOSER_SYSTEM,
                temperature=0,
            ),
        )
        skeleton = _skeleton_from_text(_gemini_response_text(response))
    else:
        raise ValueError(f"Unknown AI provider: {provider}")

    log.info(
        "response_skeleton_composed",
        broker=broker_name,
        target_action=target.value,
        provider=normalized_provider,
    )
    return skeleton


def build_response_composer_user_prompt(
    *,
    broker_name: str,
    broker_subject: str,
    broker_body: str,
    classifier_result: ReplyAnalysis,
    target_action: ResponseTargetAction | str,
    user_context: str | None = None,
) -> str:
    """Build the privacy-preserving user prompt for response composition."""
    target = ResponseTargetAction(target_action)
    trimmed_user_context = (user_context or "").strip()
    classifier_payload = {
        "classification": classifier_result.classification.value,
        "requested_fields": [
            field.value if hasattr(field, "value") else str(field)
            for field in classifier_result.requested_fields
        ],
        "other_details": classifier_result.other_details,
    }
    user_context_section = ""
    if target == ResponseTargetAction.REJECTION_REBUTTAL and trimmed_user_context:
        user_context_section = (
            "The user provides this additional context to strengthen the "
            "rebuttal. Integrate it politely without adding stored profile "
            "values, sender email, or other stored PII:\n"
            f"{trimmed_user_context}\n\n"
        )
    return (
        f"Target action: {target.value}\n"
        f"Broker name: {broker_name}\n\n"
        "Broker reply excerpt (truncated):\n"
        f"{_broker_reply_excerpt(broker_subject, broker_body)}\n\n"
        f"{user_context_section}"
        "Classifier result JSON:\n"
        f"{json.dumps(classifier_payload, sort_keys=True)}\n\n"
        f"{_ALLOWED_PLACEHOLDERS}\n"
        "Action-specific instruction:\n"
        f"{_TARGET_INSTRUCTIONS[target]}\n\n"
        "Return JSON exactly in this shape:\n"
        '{"subject":"...","body":"...","notes":"..."}'
    )


def render_response_skeleton(
    skeleton: ResponseSkeleton,
    placeholders: Mapping[str, object],
) -> ResponseSkeleton:
    """Render an LLM skeleton locally with caller-supplied placeholder values."""
    return ResponseSkeleton(
        subject=_env.from_string(skeleton.subject).render(**placeholders),
        body=_env.from_string(skeleton.body).render(**placeholders),
        notes=skeleton.notes,
    )


def _broker_reply_excerpt(subject: str, body: str, limit: int = 500) -> str:
    subject = subject.strip()
    body = body.strip()
    parts = []
    if subject:
        parts.append(f"Subject: {subject}")
    if body:
        parts.append(f"Body: {body}")
    text = "\n".join(parts).strip() or "(no broker reply text provided)"
    if len(text) <= limit:
        return text
    return f"{text[:limit].rstrip()}..."


def _skeleton_from_text(text: str) -> ResponseSkeleton:
    parsed = _parse_json_payload(text.strip())
    if parsed is None:
        raise ValueError("LLM response did not contain a JSON object")
    return ResponseSkeleton.model_validate(parsed)


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


def _anthropic_response_text(response: Any) -> str:
    content = getattr(response, "content", [])
    if not content:
        return ""
    return str(getattr(content[0], "text", ""))


def _gemini_response_text(response: Any) -> str:
    text = getattr(response, "text", "")
    return "" if text is None else str(text)
