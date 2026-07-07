"""Tests for the AI classifier with mocked AI clients."""

from unittest.mock import MagicMock

from smokescreen.ai.classifier import classify_reply, classify_reply_gemini
from smokescreen.models import ReplyClassification, VerificationField


def _mock_client(response_text: str) -> MagicMock:
    client = MagicMock()
    content_block = MagicMock()
    content_block.text = response_text
    client.messages.create.return_value = MagicMock(content=[content_block])
    return client


def _mock_gemini_client(response_text: str) -> MagicMock:
    client = MagicMock()
    client.models.generate_content.return_value = MagicMock(text=response_text)
    return client


def _anthropic_prompt(client: MagicMock) -> str:
    return client.messages.create.call_args.kwargs["messages"][0]["content"]


def test_classify_acknowledgment():
    client = _mock_client("ACKNOWLEDGMENT")
    result = classify_reply(
        client,
        "claude-sonnet-4-20250514",
        "Spokeo",
        "Re: Request",
        "We received your request.",
    )
    assert result.classification == ReplyClassification.ACKNOWLEDGMENT


def test_classify_info_request():
    client = _mock_client("INFO_REQUEST")
    result = classify_reply(
        client,
        "claude-sonnet-4-20250514",
        "Spokeo",
        "Verification",
        "Please send ID.",
    )
    assert result.classification == ReplyClassification.INFO_REQUEST
    assert result.requested_fields == []


def test_classify_info_request_requested_fields_json():
    client = _mock_client(
        '{"classification":"INFO_REQUEST","requested_fields":["home_address","phone_number"],"other_details":""}'
    )
    result = classify_reply(
        client,
        "claude-sonnet-4-20250514",
        "Spokeo",
        "Verification",
        "Please provide address and phone.",
    )
    assert result.classification == ReplyClassification.INFO_REQUEST
    assert result.requested_fields == [
        VerificationField.HOME_ADDRESS,
        VerificationField.PHONE_NUMBER,
    ]
    assert result.other_details == ""


def test_classify_completed():
    client = _mock_client("COMPLETED")
    result = classify_reply(
        client,
        "claude-sonnet-4-20250514",
        "Spokeo",
        "Done",
        "Your data has been deleted.",
    )
    assert result.classification == ReplyClassification.COMPLETED


def test_classify_unknown_falls_back_to_needs_manual():
    client = _mock_client("SOME_GARBAGE_OUTPUT")
    result = classify_reply(
        client,
        "claude-sonnet-4-20250514",
        "Spokeo",
        "Re: Request",
        "Unclear response.",
    )
    assert result.classification == ReplyClassification.NEEDS_MANUAL


def test_classifier_receives_full_thread_history():
    client = _mock_client(
        '{"classification":"INFO_REQUEST",'
        '"requested_fields":["phone_number"],'
        '"other_details":""}'
    )

    result = classify_reply(
        client,
        "claude-sonnet-4-20250514",
        "Spokeo",
        "Re: Verification",
        "Can you also send your phone number?",
        thread_history=[
            {
                "direction": "outbound",
                "sender_email": "me@example.com",
                "subject": "Opt out request",
                "body": "Please remove my profile.",
            },
            {
                "direction": "inbound",
                "sender_email": "privacy@spokeo.com",
                "subject": "Verification",
                "body": "Please provide your home address.",
            },
            {
                "direction": "outbound",
                "sender_email": "me@example.com",
                "subject": "Re: Verification",
                "body": "My home address is 123 Oak Street.",
            },
            {
                "direction": "inbound",
                "sender_email": "privacy@spokeo.com",
                "subject": "Re: Verification",
                "body": "Can you also send your phone number?",
            },
        ],
    )

    prompt = _anthropic_prompt(client)
    assert result.classification == ReplyClassification.INFO_REQUEST
    assert result.requested_fields == [VerificationField.PHONE_NUMBER]
    assert "[1] outbound from us" in prompt
    assert "[2] inbound from privacy@spokeo.com" in prompt
    assert "My home address is 123 Oak Street." in prompt
    assert "full parsed body:\nCan you also send your phone number?" in prompt


def test_classifier_awaiting_response_when_we_replied_with_all_info():
    client = _mock_client("AWAITING_RESPONSE")

    result = classify_reply(
        client,
        "claude-sonnet-4-20250514",
        "BeenVerified",
        "Verification needed",
        "Please send your home address.",
        thread_history=[
            {
                "direction": "inbound",
                "sender_email": "privacy@beenverified.com",
                "subject": "Verification needed",
                "body": "Please send your home address.",
            },
            {
                "direction": "outbound",
                "sender_email": "me@example.com",
                "subject": "Re: Verification needed",
                "body": "My home address is 123 Oak Street.",
            },
        ],
    )

    system_prompt = client.messages.create.call_args.kwargs["system"]
    assert "AWAITING_RESPONSE" in system_prompt
    assert result.classification == ReplyClassification.ACKNOWLEDGMENT


def test_classifier_completed_when_broker_confirms_after_our_reply():
    client = _mock_client("COMPLETED")

    result = classify_reply(
        client,
        "claude-sonnet-4-20250514",
        "BeenVerified",
        "Re: Verification needed",
        "Your opt-out is complete.",
        thread_history=[
            {
                "direction": "inbound",
                "sender_email": "privacy@beenverified.com",
                "subject": "Verification needed",
                "body": "Please send your home address.",
            },
            {
                "direction": "outbound",
                "sender_email": "me@example.com",
                "subject": "Re: Verification needed",
                "body": "My home address is 123 Oak Street.",
            },
            {
                "direction": "inbound",
                "sender_email": "privacy@beenverified.com",
                "subject": "Re: Verification needed",
                "body": "Your opt-out is complete.",
            },
        ],
    )

    prompt = _anthropic_prompt(client)
    assert result.classification == ReplyClassification.COMPLETED
    assert "My home address is 123 Oak Street." in prompt
    assert "full parsed body:\nYour opt-out is complete." in prompt


def test_classifier_new_info_request_when_broker_asks_for_more_after_our_reply():
    client = _mock_client(
        '{"classification":"INFO_REQUEST",'
        '"requested_fields":["phone_number"],'
        '"other_details":""}'
    )

    result = classify_reply(
        client,
        "claude-sonnet-4-20250514",
        "BeenVerified",
        "Re: Verification needed",
        "Please also send your phone number.",
        thread_history=[
            {
                "direction": "inbound",
                "sender_email": "privacy@beenverified.com",
                "subject": "Verification needed",
                "body": "Please send your home address.",
            },
            {
                "direction": "outbound",
                "sender_email": "me@example.com",
                "subject": "Re: Verification needed",
                "body": "My home address is 123 Oak Street.",
            },
            {
                "direction": "inbound",
                "sender_email": "privacy@beenverified.com",
                "subject": "Re: Verification needed",
                "body": "Please also send your phone number.",
            },
        ],
    )

    assert result.classification == ReplyClassification.INFO_REQUEST
    assert result.requested_fields == [VerificationField.PHONE_NUMBER]
    assert result.other_details == ""


def test_classifier_no_regression_when_no_prior_outbound_messages():
    client = _mock_client(
        '{"classification":"INFO_REQUEST",'
        '"requested_fields":["documents"],'
        '"other_details":""}'
    )

    result = classify_reply(
        client,
        "claude-sonnet-4-20250514",
        "Spokeo",
        "Verification",
        "Please send ID.",
    )

    prompt = _anthropic_prompt(client)
    assert result.classification == ReplyClassification.INFO_REQUEST
    assert result.requested_fields == [VerificationField.DOCUMENTS]
    assert "full parsed body:\nPlease send ID." in prompt


def test_classify_gemini_completed():
    client = _mock_gemini_client("COMPLETED")
    result = classify_reply_gemini(
        client,
        "gemini-3.1-flash-lite",
        "Spokeo",
        "Done",
        "Your data has been deleted.",
    )

    assert result.classification == ReplyClassification.COMPLETED
    call = client.models.generate_content.call_args.kwargs
    assert call["model"] == "gemini-3.1-flash-lite"
    assert "Spokeo" in call["contents"]
    assert call["config"].max_output_tokens == 250
    assert call["config"].system_instruction


def test_classify_gemini_unknown_falls_back_to_needs_manual():
    client = _mock_gemini_client("NOT_A_LABEL")
    result = classify_reply_gemini(
        client,
        "gemini-3.1-flash-lite",
        "Spokeo",
        "Re: Request",
        "Unclear response.",
    )
    assert result.classification == ReplyClassification.NEEDS_MANUAL
