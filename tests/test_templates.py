"""Tests for email templates."""

from smokescreen.email.templates import (
    render_initial_opt_out,
    render_identity_response,
    render_follow_up,
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


def test_identity_response_template():
    result = render_identity_response(
        broker_name="Spokeo",
        sender_name="John Doe",
    )
    assert "Spokeo" in result
    assert "John Doe" in result
    assert "identity" in result.lower() or "verification" in result.lower()


def test_follow_up_template():
    result = render_follow_up(
        broker_name="Spokeo",
        sender_name="John Doe",
        original_date="2024-01-15",
    )
    assert "Spokeo" in result
    assert "2024-01-15" in result
    assert "follow" in result.lower()
