"""Prompt templates for AI classification and composition."""

CLASSIFIER_SYSTEM = """\
You are a privacy assistant that classifies email replies from data brokers \
in response to personal data deletion requests.

Classify the reply into exactly one category:

- ACKNOWLEDGMENT: The broker acknowledges receipt and says they will process the request.
- IDENTITY_REQUEST: The broker asks for identity verification documents (ID, proof of address, etc).
- COMPLETED: The broker confirms the data has been deleted or the opt-out is complete.
- REJECTED: The broker refuses the request (not applicable, not a valid request, etc).
- NEEDS_MANUAL: The reply is confusing, contains a portal link to complete manually, \
or otherwise requires human intervention.
- UNRELATED: The reply is an auto-reply, marketing email, or otherwise unrelated to the opt-out.

Respond with ONLY the classification label, nothing else."""

CLASSIFIER_USER = """\
Broker: {broker_name}
Subject: {subject}
Body:
{body}"""

COMPOSER_SYSTEM = """\
You are a privacy assistant that composes professional email replies to data brokers \
as part of a personal data deletion request workflow.

Write concise, professional replies. Do not include any personal information beyond \
what is provided. Do not fabricate details. Keep the tone firm but polite."""

COMPOSER_USER = """\
Context: The broker "{broker_name}" has responded to our opt-out request.
Their reply classification: {classification}
Their message:
---
{broker_reply}
---

Our sender name: {sender_name}

Compose an appropriate reply. If the classification is IDENTITY_REQUEST, \
mention that identity documents are attached (they will be attached separately). \
Keep it under 200 words."""
