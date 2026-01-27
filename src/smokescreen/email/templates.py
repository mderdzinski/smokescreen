"""Jinja2 email templates for opt-out requests."""

from __future__ import annotations

from jinja2 import Environment

_env = Environment(autoescape=False)

INITIAL_OPT_OUT = _env.from_string("""\
Dear {{ broker_name }} Privacy Team,

I am writing to request the removal of my personal information from your database \
and any associated services, pursuant to applicable data privacy laws including the \
California Consumer Privacy Act (CCPA) and similar state-level privacy regulations.

My details:
- Full Name: {{ sender_name }}
- Email: {{ sender_email }}

Please confirm the deletion of my personal data within 30 days as required by law. \
I request that you:

1. Delete all personal information you have collected about me
2. Direct any service providers who have received my data to delete it
3. Confirm completion of this request in writing

If you require additional verification of my identity, please let me know and I will \
provide the necessary documentation.

Thank you for your prompt attention to this matter.

Sincerely,
{{ sender_name }}
""")

IDENTITY_RESPONSE = _env.from_string("""\
Dear {{ broker_name }} Privacy Team,

Thank you for your response. As requested, I am providing identity verification \
documentation to proceed with my data deletion request.

Please find the attached identity document(s). I trust this satisfies your \
verification requirements.

I look forward to confirmation that my data has been removed.

Sincerely,
{{ sender_name }}
""")

FOLLOW_UP = _env.from_string("""\
Dear {{ broker_name }} Privacy Team,

I am following up on my data deletion request sent on {{ original_date }}. \
I have not yet received confirmation that my personal information has been removed.

As a reminder, applicable privacy laws require a response within 30 days of the \
original request. I would appreciate an update on the status of my request.

Thank you,
{{ sender_name }}
""")


def render_initial_opt_out(
    broker_name: str, sender_name: str, sender_email: str
) -> str:
    return INITIAL_OPT_OUT.render(
        broker_name=broker_name,
        sender_name=sender_name,
        sender_email=sender_email,
    )


def render_identity_response(broker_name: str, sender_name: str) -> str:
    return IDENTITY_RESPONSE.render(
        broker_name=broker_name,
        sender_name=sender_name,
    )


def render_follow_up(
    broker_name: str, sender_name: str, original_date: str
) -> str:
    return FOLLOW_UP.render(
        broker_name=broker_name,
        sender_name=sender_name,
        original_date=original_date,
    )
