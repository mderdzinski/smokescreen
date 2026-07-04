"""Tests for email templates."""

from smokescreen.email.templates import (
    render_initial_opt_out,
    render_silent_ping,
    render_verification_profile_follow_up,
)


def test_initial_opt_out_template():
    result = render_initial_opt_out(
        broker_name="Spokeo",
        sender_name="John Doe",
        sender_email="john@example.com",
    )
    assert "Spokeo" in result
    assert "John Doe" in result
    assert "john@example.com" in result
    assert "deletion" in result.lower()


def test_follow_up_response_template():
    result = render_verification_profile_follow_up(
        broker_name="Spokeo",
        sender_name="John Doe",
        verification_lines=["Home address: 1 Main St; Springfield, CA 90210"],
    )
    assert "Spokeo" in result
    assert "John Doe" in result
    assert "Home address: 1 Main St" in result
    assert "attached" not in result.lower()


def test_verification_follow_up_includes_documents_offer():
    result = render_verification_profile_follow_up(
        broker_name="Spokeo",
        sender_name="John Doe",
        verification_lines=[],
        document_labels=["Utility Bill", "Driver License"],
    )
    assert "Spokeo" in result
    assert "Available documents on request: Utility Bill, Driver License" in result
    assert "attached" not in result.lower()


def test_silent_ping_template():
    result = render_silent_ping(broker_name="Spokeo", sender_name="John Doe")
    assert "Spokeo" in result
    assert "John Doe" in result
    assert "follow" in result.lower() or "status" in result.lower()
