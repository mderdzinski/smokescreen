from smokescreen.email.reply_parser import parse_latest_reply


def test_reply_parser_strips_gmail_quoted_history():
    body = """Please use the privacy portal to finish this request.

On Sat, Jul 4, 2026 at 1:53 PM Mark Derdzinski <mark@example.com> wrote:
> Please delete my profile.
> This is quoted outreach."""

    assert (
        parse_latest_reply(body)
        == "Please use the privacy portal to finish this request."
    )


def test_reply_parser_handles_outlook_separator():
    body = """We need a signed authorization form before proceeding.

-----Original Message-----
From: Mark Derdzinski <mark@example.com>
Sent: Saturday, July 4, 2026 1:53 PM
To: Privacy Team <privacy@example.com>
Subject: Deletion request

Please delete my profile."""

    assert (
        parse_latest_reply(body)
        == "We need a signed authorization form before proceeding."
    )


def test_reply_parser_handles_mobile_reply():
    body = """We have removed the profile from our site.

Sent from my iPhone

On Jul 4, 2026, at 1:53 PM, Mark Derdzinski <mark@example.com> wrote:
> Please delete my profile."""

    assert parse_latest_reply(body) == "We have removed the profile from our site."


def test_reply_parser_handles_no_quoted_history_intact():
    body = """We need the phone number shown in the listing.

Please send it to this address and we will continue processing."""

    assert parse_latest_reply(body) == body
