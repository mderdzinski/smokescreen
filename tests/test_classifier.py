"""Tests for the AI classifier with mocked AI clients."""

from unittest.mock import MagicMock

from smokescreen.ai.classifier import classify_reply, classify_reply_gemini
from smokescreen.models import ReplyClassification


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


def test_classify_acknowledgment():
    client = _mock_client("ACKNOWLEDGMENT")
    result = classify_reply(
        client,
        "claude-sonnet-4-20250514",
        "Spokeo",
        "Re: Request",
        "We received your request.",
    )
    assert result == ReplyClassification.ACKNOWLEDGMENT


def test_classify_identity_request():
    client = _mock_client("IDENTITY_REQUEST")
    result = classify_reply(
        client,
        "claude-sonnet-4-20250514",
        "Spokeo",
        "Verification",
        "Please send ID.",
    )
    assert result == ReplyClassification.IDENTITY_REQUEST


def test_classify_completed():
    client = _mock_client("COMPLETED")
    result = classify_reply(
        client,
        "claude-sonnet-4-20250514",
        "Spokeo",
        "Done",
        "Your data has been deleted.",
    )
    assert result == ReplyClassification.COMPLETED


def test_classify_unknown_falls_back_to_needs_manual():
    client = _mock_client("SOME_GARBAGE_OUTPUT")
    result = classify_reply(
        client,
        "claude-sonnet-4-20250514",
        "Spokeo",
        "Re: Request",
        "Unclear response.",
    )
    assert result == ReplyClassification.NEEDS_MANUAL


def test_classify_gemini_completed():
    client = _mock_gemini_client("COMPLETED")
    result = classify_reply_gemini(
        client,
        "gemini-3.1-flash-lite",
        "Spokeo",
        "Done",
        "Your data has been deleted.",
    )

    assert result == ReplyClassification.COMPLETED
    call = client.models.generate_content.call_args.kwargs
    assert call["model"] == "gemini-3.1-flash-lite"
    assert "Spokeo" in call["contents"]
    assert call["config"].max_output_tokens == 50
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
    assert result == ReplyClassification.NEEDS_MANUAL
