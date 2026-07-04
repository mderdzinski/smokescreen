"""Tests for structured broker response composition."""

from unittest.mock import MagicMock

from smokescreen.ai.response_composer import (
    ResponseSkeleton,
    ResponseTargetAction,
    build_response_composer_user_prompt,
    compose_response_skeleton,
    render_response_skeleton,
)
from smokescreen.models import ReplyAnalysis, ReplyClassification, VerificationField


def _mock_client(response_text: str) -> MagicMock:
    client = MagicMock()
    content_block = MagicMock()
    content_block.text = response_text
    client.messages.create.return_value = MagicMock(content=[content_block])
    return client


def test_composer_llm_call_excludes_pii():
    client = _mock_client(
        '{"subject":"Re: {{ broker_subject }}",'
        '"body":"Dear {{ broker_name }},\\n{{ verification_lines }}",'
        '"notes":"uses placeholders"}'
    )

    compose_response_skeleton(
        client=client,
        provider="anthropic",
        model="claude-sonnet-4-20250514",
        broker_name="Labeled Broker",
        broker_subject="Identity verification",
        broker_body="Please provide your address and phone number.",
        classifier_result=ReplyAnalysis(
            classification=ReplyClassification.INFO_REQUEST,
            requested_fields=[
                VerificationField.HOME_ADDRESS,
                VerificationField.PHONE_NUMBER,
            ],
            other_details="",
        ),
        target_action=ResponseTargetAction.INFO_RESPONSE,
    )

    call = client.messages.create.call_args.kwargs
    prompt_payload = str(call["system"]) + "\n" + str(call["messages"])
    for pii in (
        "Jane Doe",
        "jane@example.com",
        "1 Main St",
        "+1 555 0100",
        "1234",
    ):
        assert pii not in prompt_payload

    assert "Labeled Broker" in prompt_payload
    assert "home_address" in prompt_payload
    assert "phone_number" in prompt_payload


def test_composer_output_placeholders_substituted_locally():
    skeleton = ResponseSkeleton(
        subject="Re: {{ broker_subject }}",
        body=(
            "Dear {{ broker_name }} Privacy Team,\n\n"
            "{{ verification_lines }}\n\n"
            "Sincerely,\n{{ sender_name }}"
        ),
        notes="placeholder skeleton",
    )

    rendered = render_response_skeleton(
        skeleton,
        {
            "broker_name": "Labeled Broker",
            "broker_subject": "Identity verification",
            "sender_name": "Jane Doe",
            "verification_lines": "- Home address: 1 Main St\n- Phone: +1 555 0100",
        },
    )

    assert rendered.subject == "Re: Identity verification"
    assert "Jane Doe" in rendered.body
    assert "1 Main St" in rendered.body
    assert "+1 555 0100" in rendered.body


def test_composer_rejection_rebuttal_uses_user_context():
    prompt = build_response_composer_user_prompt(
        broker_name="Labeled Broker",
        broker_subject="Request rejected",
        broker_body="We reject this request as invalid.",
        classifier_result=ReplyAnalysis(
            classification=ReplyClassification.REJECTED,
            requested_fields=[],
            other_details="Broker claimed no matching record.",
        ),
        target_action=ResponseTargetAction.REJECTION_REBUTTAL,
        user_context="The listing exposes a minor household member.",
    )

    assert "Target action: REJECTION_REBUTTAL" in prompt
    assert "The listing exposes a minor household member." in prompt
    assert "strengthen the rebuttal" in prompt
    assert "sender email" in prompt
