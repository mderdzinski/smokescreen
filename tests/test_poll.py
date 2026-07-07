"""Tests for polling broker reply threads."""
from datetime import datetime, timedelta
from unittest.mock import MagicMock, patch

from smokescreen.brokers.registry import BrokerRegistry
from smokescreen.config import Settings
from smokescreen.jobs.poll import (
    _broker_reply_excerpt,
    _poll_label_query,
    _process_thread,
    run_poll,
    run_timeout_escalation,
)
from smokescreen.models import (
    Broker,
    BrokerStatus,
    EmailMessage,
    OptOutRecord,
    PendingWhitelistStatus,
    VerificationAddress,
    VerificationDocument,
    VerificationProfile,
    WhitelistEntry,
)
from smokescreen.state.sqlite import SQLiteStore


class FakeGmail:
    def __init__(
        self,
        *,
        search_results: list[str] | None = None,
        search_results_by_query: dict[str, list[str]] | None = None,
        messages: dict[str, EmailMessage] | None = None,
        threads: dict[str, list[EmailMessage]] | None = None,
    ) -> None:
        self.search_results = search_results or []
        self.search_results_by_query = search_results_by_query or {}
        self.messages = messages or {}
        self.threads = threads or {}
        self.searches: list[str] = []
        self.fetched_threads: list[str] = []
        self.labeled_threads: list[tuple[str, str]] = []
        self.sent_messages: list[dict] = []

    def search(self, query: str, max_results: int = 50) -> list[str]:
        self.searches.append(query)
        if query in self.search_results_by_query:
            return self.search_results_by_query[query]
        return self.search_results

    def get_message(self, message_id: str) -> EmailMessage:
        return self.messages[message_id]

    def get_thread(self, thread_id: str) -> list[EmailMessage]:
        self.fetched_threads.append(thread_id)
        return self.threads.get(thread_id, [])

    def label_thread(self, thread_id: str, label_name: str) -> None:
        self.labeled_threads.append((thread_id, label_name))

    def send(self, **kwargs) -> EmailMessage:
        self.sent_messages.append(kwargs)
        return EmailMessage(
            message_id="sent-identity",
            thread_id=kwargs.get("thread_id", ""),
            sender=kwargs.get("sender", ""),
            to=kwargs.get("to", ""),
            subject=kwargs.get("subject", ""),
            body=kwargs.get("body", ""),
        )


def _settings(tmp_path, **kwargs) -> Settings:
    data = {
        "sqlite_path": tmp_path / "test.db",
        "sender_email": "me@example.com",
        "sender_name": "Test User",
        "ai_provider": "anthropic",
        "dry_run": False,
    }
    data.update(kwargs)
    return Settings(**data)


def _registry() -> BrokerRegistry:
    return BrokerRegistry(
        [
            Broker(
                id="labeled",
                name="Labeled Broker",
                domain="labeled.example",
                privacy_email="privacy@labeled.example",
            ),
            Broker(
                id="unlabeled",
                name="Unlabeled Broker",
                domain="unlabeled.example",
                privacy_email="privacy@unlabeled.example",
            ),
        ]
    )


def _seed_store(store: SQLiteStore) -> None:
    store.upsert(
        OptOutRecord(
            broker_id="labeled",
            status=BrokerStatus.INITIAL_SENT,
            thread_id="thread-labeled",
            last_message_id="sent-labeled",
        )
    )
    store.upsert(
        OptOutRecord(
            broker_id="unlabeled",
            status=BrokerStatus.INITIAL_SENT,
            thread_id="thread-unlabeled",
            last_message_id="sent-unlabeled",
        )
    )
    store.add_whitelist(
        WhitelistEntry(broker_id="labeled", email="privacy@labeled.example")
    )
    store.add_whitelist(
        WhitelistEntry(broker_id="unlabeled", email="privacy@unlabeled.example")
    )


def _seed_labeled_reply(store: SQLiteStore) -> None:
    store.upsert(
        OptOutRecord(
            broker_id="labeled",
            status=BrokerStatus.INITIAL_SENT,
            thread_id="thread-labeled",
            last_message_id="sent-labeled",
        )
    )
    store.add_whitelist(
        WhitelistEntry(broker_id="labeled", email="privacy@labeled.example")
    )


def _labeled_reply_gmail() -> FakeGmail:
    return FakeGmail(
        threads={
            "thread-labeled": [
                EmailMessage(
                    message_id="sent-labeled",
                    thread_id="thread-labeled",
                    sender="me@example.com",
                    subject="Opt out request",
                    body="Please remove me.",
                ),
                EmailMessage(
                    message_id="reply-labeled",
                    thread_id="thread-labeled",
                    sender="privacy@labeled.example",
                    subject="Re: request",
                    body="We received your request.",
                ),
            ]
        }
    )


def _mock_anthropic_response(label: str) -> MagicMock:
    content_block = MagicMock()
    content_block.text = label
    return MagicMock(content=[content_block])


def _mock_anthropic(label: str) -> MagicMock:
    client = MagicMock()
    client.messages.create.return_value = _mock_anthropic_response(label)
    return client


def _mock_anthropic_sequence(labels: list[str]) -> MagicMock:
    client = MagicMock()
    client.messages.create.side_effect = [
        _mock_anthropic_response(label) for label in labels
    ]
    return client


def _info_request_response(fields: list[str], other_details: str = "") -> str:
    return (
        '{"classification":"INFO_REQUEST",'
        f'"requested_fields":{fields!r},'
        f'"other_details":"{other_details}"'
        "}"
    ).replace("'", '"')


def _mock_gemini(label: str) -> MagicMock:
    client = MagicMock()
    client.models.generate_content.return_value = MagicMock(text=label)
    return client


def _record(
    *,
    broker_id: str = "labeled",
    status: BrokerStatus = BrokerStatus.INITIAL_SENT,
) -> OptOutRecord:
    return OptOutRecord(
        broker_id=broker_id,
        status=status,
        thread_id="thread-labeled",
        last_message_id="sent-labeled",
    )


def test_poll_label_scopes_active_threads(tmp_path):
    settings = _settings(tmp_path, poll_label="custom-label")
    store = SQLiteStore(settings.sqlite_path)
    _seed_store(store)
    gmail = FakeGmail(
        search_results_by_query={"label:custom-label": ["msg-labeled"]},
        messages={
            "msg-labeled": EmailMessage(
                message_id="msg-labeled",
                thread_id="thread-labeled",
            )
        },
        threads={
            "thread-labeled": [
                EmailMessage(
                    message_id="reply-labeled",
                    thread_id="thread-labeled",
                    sender="privacy@labeled.example",
                    subject="Re: request",
                    body="We need more context.",
                )
            ],
            "thread-unlabeled": [
                EmailMessage(
                    message_id="reply-unlabeled",
                    thread_id="thread-unlabeled",
                    sender="privacy@unlabeled.example",
                    subject="Re: request",
                    body="We need more context.",
                )
            ],
        },
    )

    processed = run_poll(settings, _registry(), store, gmail=gmail)

    assert processed == ["labeled"]
    assert gmail.searches == [
        "label:custom-label",
        "in:inbox from:unlabeled.example",
    ]
    assert gmail.fetched_threads == ["thread-labeled"]
    assert store.get("labeled").status == BrokerStatus.NEEDS_MANUAL
    assert store.get("unlabeled").status == BrokerStatus.INITIAL_SENT
    store.close()


def test_blank_poll_label_keeps_thread_only_polling(tmp_path):
    settings = _settings(tmp_path, poll_label="")
    store = SQLiteStore(settings.sqlite_path)
    _seed_store(store)
    gmail = FakeGmail(
        threads={
            "thread-labeled": [
                EmailMessage(
                    message_id="reply-labeled",
                    thread_id="thread-labeled",
                    sender="privacy@labeled.example",
                    subject="Re: request",
                    body="We need more context.",
                )
            ],
            "thread-unlabeled": [
                EmailMessage(
                    message_id="reply-unlabeled",
                    thread_id="thread-unlabeled",
                    sender="privacy@unlabeled.example",
                    subject="Re: request",
                    body="We need more context.",
                )
            ],
        }
    )

    processed = run_poll(settings, _registry(), store, gmail=gmail)

    assert processed == ["labeled", "unlabeled"]
    assert gmail.searches == []
    assert gmail.fetched_threads == ["thread-labeled", "thread-unlabeled"]
    store.close()


def test_poll_label_query_quotes_labels_with_spaces():
    assert _poll_label_query("privacy replies") == 'label:"privacy replies"'


def test_poll_processes_reply_in_new_thread_from_broker_domain(tmp_path):
    settings = _settings(
        tmp_path,
        anthropic_api_key="test-key",
        poll_label="custom-label",
    )
    store = SQLiteStore(settings.sqlite_path)
    store.upsert(
        OptOutRecord(
            broker_id="labeled",
            status=BrokerStatus.INITIAL_SENT,
            thread_id="thread-original",
            last_message_id="sent-original",
        )
    )
    store.add_whitelist(
        WhitelistEntry(broker_id="labeled", email="privacy@labeled.example")
    )
    gmail = FakeGmail(
        search_results_by_query={
            "label:custom-label": ["msg-other"],
            "in:inbox from:labeled.example": ["reply-alt"],
        },
        messages={
            "msg-other": EmailMessage(
                message_id="msg-other",
                thread_id="thread-other",
            ),
            "reply-alt": EmailMessage(
                message_id="reply-alt",
                thread_id="thread-alt",
                sender="Support <case@notifications.labeled.example>",
                subject="Re: request",
                body="Your opt-out request is complete.",
            ),
        },
        threads={
            "thread-alt": [
                EmailMessage(
                    message_id="reply-alt",
                    thread_id="thread-alt",
                    sender="Support <case@notifications.labeled.example>",
                    subject="Re: request",
                    body="Your opt-out request is complete.",
                )
            ]
        },
    )
    anthropic_client = _mock_anthropic("COMPLETED")

    with patch("smokescreen.jobs.poll.Anthropic") as anthropic:
        anthropic.return_value = anthropic_client
        processed = run_poll(settings, _registry(), store, gmail=gmail)

    assert processed == ["labeled"]
    updated = store.get("labeled")
    assert updated.status == BrokerStatus.COMPLETED
    assert updated.thread_id == "thread-alt"
    assert updated.last_message_id == "reply-alt"
    assert gmail.fetched_threads == ["thread-alt"]
    assert gmail.labeled_threads == [("thread-alt", "custom-label")]
    assert store.list_pending_whitelist(PendingWhitelistStatus.PENDING) == []
    anthropic_client.messages.create.assert_called_once()
    store.close()


def test_poll_processes_reply_from_alternate_sender_matching_domain(tmp_path):
    settings = _settings(
        tmp_path,
        anthropic_api_key="test-key",
        poll_label="",
    )
    store = SQLiteStore(settings.sqlite_path)
    _seed_labeled_reply(store)
    gmail = FakeGmail(
        threads={
            "thread-labeled": [
                EmailMessage(
                    message_id="sent-labeled",
                    thread_id="thread-labeled",
                    sender="me@example.com",
                    subject="Opt out request",
                    body="Please remove me.",
                ),
                EmailMessage(
                    message_id="reply-labeled",
                    thread_id="thread-labeled",
                    sender="no-reply@notifications.labeled.example",
                    subject="Re: request",
                    body="Your opt-out request is complete.",
                ),
            ]
        }
    )
    anthropic_client = _mock_anthropic("COMPLETED")

    with patch("smokescreen.jobs.poll.Anthropic") as anthropic:
        anthropic.return_value = anthropic_client
        processed = run_poll(settings, _registry(), store, gmail=gmail)

    assert processed == ["labeled"]
    updated = store.get("labeled")
    assert updated.status == BrokerStatus.COMPLETED
    assert updated.last_message_id == "reply-labeled"
    assert store.list_pending_whitelist(PendingWhitelistStatus.PENDING) == []
    anthropic_client.messages.create.assert_called_once()
    store.close()


def test_poll_updates_last_message_id_after_alternate_sender_reply(tmp_path):
    settings = _settings(
        tmp_path,
        anthropic_api_key="test-key",
        poll_label="custom-label",
    )
    store = SQLiteStore(settings.sqlite_path)
    store.set_verification_profile(
        VerificationProfile(
            home_addresses=[
                VerificationAddress(
                    street="1 Main St",
                    city="Springfield",
                    state="CA",
                    zip="90210",
                    country="US",
                )
            ]
        )
    )
    store.upsert(
        OptOutRecord(
            broker_id="labeled",
            status=BrokerStatus.INITIAL_SENT,
            thread_id="thread-original",
            last_message_id="sent-original",
        )
    )
    gmail = FakeGmail(
        search_results_by_query={
            "label:custom-label": ["msg-other"],
            "in:inbox from:labeled.example": ["reply-alt"],
        },
        messages={
            "msg-other": EmailMessage(
                message_id="msg-other",
                thread_id="thread-other",
            ),
            "reply-alt": EmailMessage(
                message_id="reply-alt",
                thread_id="thread-alt",
                sender="Support <case@notifications.labeled.example>",
                subject="Identity verification",
                body="Please send your home address.",
            ),
        },
        threads={
            "thread-alt": [
                EmailMessage(
                    message_id="reply-alt",
                    thread_id="thread-alt",
                    sender="Support <case@notifications.labeled.example>",
                    subject="Identity verification",
                    body="Please send your home address.",
                )
            ]
        },
    )
    anthropic_client = _mock_anthropic(_info_request_response(["home_address"]))

    with patch("smokescreen.jobs.poll.Anthropic") as anthropic:
        anthropic.return_value = anthropic_client
        first = run_poll(settings, _registry(), store, gmail=gmail)
        second = run_poll(settings, _registry(), store, gmail=gmail)

    assert first == ["labeled"]
    assert second == []
    assert len(gmail.sent_messages) == 1
    updated = store.get("labeled")
    assert updated.status == BrokerStatus.FOLLOW_UP_SENT
    assert updated.thread_id == "thread-alt"
    assert updated.last_message_id == "reply-alt"
    assert anthropic_client.messages.create.call_count == 2
    store.close()


def test_poll_thread_not_in_label_logs_at_info_level(tmp_path):
    settings = _settings(tmp_path, poll_label="custom-label")
    store = SQLiteStore(settings.sqlite_path)
    _seed_labeled_reply(store)
    gmail = FakeGmail(
        search_results_by_query={"label:custom-label": ["msg-other"]},
        messages={
            "msg-other": EmailMessage(
                message_id="msg-other",
                thread_id="thread-other",
            )
        },
    )

    with patch("smokescreen.jobs.poll.log") as log:
        processed = run_poll(settings, _registry(), store, gmail=gmail)

    assert processed == []
    log.info.assert_any_call(
        "poll_thread_not_in_label",
        broker_id="labeled",
        thread_id="thread-labeled",
        poll_label="custom-label",
    )
    log.debug.assert_not_called()
    store.close()


def test_run_poll_defaults_to_gemini_provider(tmp_path):
    settings = Settings(
        sqlite_path=tmp_path / "test.db",
        sender_email="me@example.com",
        sender_name="Test User",
        dry_run=False,
        gemini_project="vertex-project",
        gemini_location="global",
        poll_label="",
    )
    store = SQLiteStore(settings.sqlite_path)
    _seed_labeled_reply(store)
    gmail = _labeled_reply_gmail()
    gemini_classifier = _mock_gemini("ACKNOWLEDGMENT")

    with (
        patch("smokescreen.jobs.poll.Anthropic") as anthropic,
        patch("smokescreen.jobs.poll.genai.Client") as gemini_client,
    ):
        gemini_client.return_value = gemini_classifier
        processed = run_poll(settings, _registry(), store, gmail=gmail)

    assert processed == ["labeled"]
    anthropic.assert_not_called()
    gemini_client.assert_called_once_with(
        vertexai=True,
        project="vertex-project",
        location="global",
    )
    assert (
        gemini_classifier.models.generate_content.call_args.kwargs["model"]
        == "gemini-3.1-flash-lite"
    )
    store.close()


def test_run_poll_accepts_explicit_anthropic_provider(tmp_path):
    settings = _settings(
        tmp_path,
        ai_provider="anthropic",
        anthropic_api_key="test-key",
        poll_label="",
    )
    store = SQLiteStore(settings.sqlite_path)
    _seed_labeled_reply(store)
    gmail = _labeled_reply_gmail()
    anthropic_client = _mock_anthropic("ACKNOWLEDGMENT")

    with (
        patch("smokescreen.jobs.poll.Anthropic") as anthropic,
        patch("smokescreen.jobs.poll.genai.Client") as gemini_client,
    ):
        anthropic.return_value = anthropic_client
        processed = run_poll(settings, _registry(), store, gmail=gmail)

    assert processed == ["labeled"]
    anthropic.assert_called_once_with(api_key="test-key")
    gemini_client.assert_not_called()
    store.close()


def test_run_poll_uses_gemini_provider(tmp_path):
    settings = _settings(
        tmp_path,
        ai_provider="gemini",
        gemini_project="vertex-project",
        gemini_location="global",
        poll_label="",
    )
    store = SQLiteStore(settings.sqlite_path)
    _seed_labeled_reply(store)
    gmail = _labeled_reply_gmail()
    gemini_classifier = _mock_gemini("ACKNOWLEDGMENT")

    with (
        patch("smokescreen.jobs.poll.Anthropic") as anthropic,
        patch("smokescreen.jobs.poll.genai.Client") as genai_client,
    ):
        genai_client.return_value = gemini_classifier
        processed = run_poll(settings, _registry(), store, gmail=gmail)

    assert processed == ["labeled"]
    anthropic.assert_not_called()
    genai_client.assert_called_once_with(
        vertexai=True,
        project="vertex-project",
        location="global",
    )
    call = gemini_classifier.models.generate_content.call_args.kwargs
    assert call["model"] == "gemini-3.1-flash-lite"
    assert "We received your request." in call["contents"]
    store.close()


def test_process_thread_marks_manual_without_anthropic_key(tmp_path):
    settings = _settings(tmp_path)
    store = SQLiteStore(settings.sqlite_path)
    record = _record()
    store.upsert(record)
    store.add_whitelist(
        WhitelistEntry(broker_id="labeled", email="privacy@labeled.example")
    )
    gmail = FakeGmail(
        threads={
            "thread-labeled": [
                EmailMessage(
                    message_id="reply-labeled",
                    thread_id="thread-labeled",
                    sender="privacy@labeled.example",
                    subject="Re: request",
                    body="We need more context.",
                )
            ]
        }
    )

    processed = _process_thread(
        settings=settings,
        record=record,
        broker_name="Labeled Broker",
        broker_email="privacy@labeled.example",
        store=store,
        gmail=gmail,
        ai_client=None,
    )

    assert processed is True
    updated = store.get("labeled")
    assert updated.status == BrokerStatus.NEEDS_MANUAL
    assert updated.previous_status == BrokerStatus.INITIAL_SENT
    assert updated.notes == "No Anthropic API key configured"
    assert updated.needs_manual_reason is not None
    assert updated.needs_manual_reason.reason_code == "other"
    assert (
        updated.needs_manual_reason.short_summary
        == "No Anthropic API key configured"
    )
    assert updated.needs_manual_reason.broker_reply_excerpt == "We need more context."
    assert store.list_pending_whitelist(PendingWhitelistStatus.PENDING) == []
    assert gmail.sent_messages == []
    store.close()


def test_process_thread_persists_manual_review_reply_details(tmp_path):
    settings = _settings(tmp_path)
    store = SQLiteStore(settings.sqlite_path)
    record = _record(status=BrokerStatus.AWAITING_RESPONSE)
    record.notes = "stale review note"
    store.upsert(record)
    store.add_whitelist(
        WhitelistEntry(broker_id="labeled", email="privacy@labeled.example")
    )
    gmail = FakeGmail(
        threads={
            "thread-labeled": [
                EmailMessage(
                    message_id="reply-labeled",
                    thread_id="thread-labeled",
                    sender="privacy@labeled.example",
                    subject="Portal action required",
                    body="Please log in to our privacy portal to finish the opt-out.",
                )
            ]
        }
    )

    processed = _process_thread(
        settings=settings,
        record=record,
        broker_name="Labeled Broker",
        broker_email="privacy@labeled.example",
        store=store,
        gmail=gmail,
        ai_client=_mock_anthropic("NEEDS_MANUAL"),
    )

    assert processed is True
    updated = store.get("labeled")
    assert updated.status == BrokerStatus.NEEDS_MANUAL
    assert updated.last_message_id == "reply-labeled"
    assert updated.previous_status == BrokerStatus.AWAITING_RESPONSE
    assert (
        updated.notes == "Subject: Portal action required\n\n"
        "Please log in to our privacy portal to finish the opt-out."
    )
    assert updated.needs_manual_reason is not None
    assert (
        updated.needs_manual_reason.reason_code
        == "classifier_returned_needs_manual"
    )
    assert updated.needs_manual_reason.broker_reply_excerpt == (
        "Please log in to our privacy portal to finish the opt-out."
    )
    assert (
        updated.needs_manual_reason.classifier_output["classification"]
        == "NEEDS_MANUAL"
    )
    store.close()


def test_broker_reply_excerpt_uses_parsed_reply(tmp_path):
    settings = _settings(tmp_path)
    store = SQLiteStore(settings.sqlite_path)
    record = _record(status=BrokerStatus.AWAITING_RESPONSE)
    store.upsert(record)
    store.add_whitelist(
        WhitelistEntry(broker_id="labeled", email="privacy@labeled.example")
    )
    gmail = FakeGmail(
        threads={
            "thread-labeled": [
                EmailMessage(
                    message_id="reply-labeled",
                    thread_id="thread-labeled",
                    sender="privacy@labeled.example",
                    subject="Re: request",
                    body=(
                        "Please upload a signed authorization form.\n\n"
                        "On Sat, Jul 4, 2026 at 1:53 PM "
                        "Mark Derdzinski <mark@example.com> wrote:\n"
                        "> Please delete my profile.\n"
                        "> This is the original outreach."
                    ),
                )
            ]
        }
    )
    anthropic_client = _mock_anthropic("NEEDS_MANUAL")

    processed = _process_thread(
        settings=settings,
        record=record,
        broker_name="Labeled Broker",
        broker_email="privacy@labeled.example",
        store=store,
        gmail=gmail,
        ai_client=anthropic_client,
    )

    assert processed is True
    updated = store.get("labeled")
    assert updated.needs_manual_reason is not None
    assert (
        updated.needs_manual_reason.broker_reply_excerpt
        == "Please upload a signed authorization form."
    )
    assert "Please delete my profile" not in (
        updated.needs_manual_reason.broker_reply_excerpt
    )
    classifier_prompt = anthropic_client.messages.create.call_args.kwargs["messages"][
        0
    ]["content"]
    assert "Please upload a signed authorization form." in classifier_prompt
    assert "Please delete my profile" not in classifier_prompt
    store.close()


def test_excerpt_uses_classifier_other_details_when_present(tmp_path):
    settings = _settings(tmp_path)
    store = SQLiteStore(settings.sqlite_path)
    record = _record(status=BrokerStatus.AWAITING_RESPONSE)
    store.upsert(record)
    store.add_whitelist(
        WhitelistEntry(broker_id="labeled", email="privacy@labeled.example")
    )
    gmail = FakeGmail(
        threads={
            "thread-labeled": [
                EmailMessage(
                    message_id="reply-labeled",
                    thread_id="thread-labeled",
                    sender="privacy@labeled.example",
                    subject="Re: request",
                    body=(
                        "THIS EMAIL RESPONSE IS AN AUTOREPLY\n\n"
                        "Please use our portal links for any support request."
                    ),
                )
            ]
        }
    )
    anthropic_client = _mock_anthropic(
        '{"classification":"NEEDS_MANUAL",'
        '"requested_fields":[],'
        '"other_details":"Middle initial, additional addresses, phone numbers, '
        'emails, and usernames."}'
    )

    processed = _process_thread(
        settings=settings,
        record=record,
        broker_name="Labeled Broker",
        broker_email="privacy@labeled.example",
        store=store,
        gmail=gmail,
        ai_client=anthropic_client,
    )

    assert processed is True
    updated = store.get("labeled")
    assert updated.needs_manual_reason is not None
    assert updated.needs_manual_reason.broker_reply_excerpt == (
        "Classifier summary: Middle initial, additional addresses, phone "
        "numbers, emails, and usernames."
    )
    assert updated.needs_manual_reason.classifier_output["other_details"] == (
        "Middle initial, additional addresses, phone numbers, emails, and usernames."
    )
    store.close()


def test_excerpt_skips_autoreply_boilerplate():
    message = EmailMessage(
        subject="Re: request",
        body=(
            "THIS EMAIL RESPONSE IS AN AUTOREPLY\n\n"
            "https://portal.example/privacy\n"
            "https://portal.example/opt-out\n\n"
            "-----\n"
            "Please complete the opt-out in the privacy portal."
        ),
    )

    assert (
        _broker_reply_excerpt(message)
        == "Please complete the opt-out in the privacy portal."
    )


def test_excerpt_skips_satisfaction_survey_wrapper():
    message = EmailMessage(
        subject="Re: request",
        body=(
            "How would you rate our support?\n\n"
            "Please take a moment to answer our customer satisfaction survey.\n\n"
            "## In replies all text above this line is added to the ticket ##\n"
            "Middle initial, additional addresses, phone numbers, emails, and "
            "usernames."
        ),
    )

    assert _broker_reply_excerpt(message) == (
        "Middle initial, additional addresses, phone numbers, emails, and "
        "usernames."
    )


def test_excerpt_skips_ticketing_separator_and_shows_quoted_content():
    message = EmailMessage(
        subject="Re: request",
        body=(
            "Please reply above this line.\n\n"
            "## In replies all text above this line is added to the ticket ##\n"
            "> Please provide the phone numbers and email aliases on the listing.\n"
            "> We cannot process the request without them."
        ),
    )

    assert _broker_reply_excerpt(message) == (
        "Please provide the phone numbers and email aliases on the listing.\n"
        "We cannot process the request without them."
    )


def test_excerpt_max_1500_chars():
    message = EmailMessage(subject="Re: request", body="x" * 1600)

    assert _broker_reply_excerpt(message) == "x" * 1500


def test_raw_reply_body_stored_on_needs_manual_reason(tmp_path):
    settings = _settings(tmp_path)
    store = SQLiteStore(settings.sqlite_path)
    record = _record(status=BrokerStatus.AWAITING_RESPONSE)
    store.upsert(record)
    store.add_whitelist(
        WhitelistEntry(broker_id="labeled", email="privacy@labeled.example")
    )
    raw_body = (
        "Please log in to our privacy portal to finish the opt-out.\n\n"
        "On Sat, Jul 4, 2026 at 1:53 PM Mark Derdzinski <mark@example.com> wrote:\n"
        "> Please delete my profile."
    )
    gmail = FakeGmail(
        threads={
            "thread-labeled": [
                EmailMessage(
                    message_id="reply-labeled",
                    thread_id="thread-labeled",
                    sender="privacy@labeled.example",
                    subject="Re: request",
                    body=raw_body,
                )
            ]
        }
    )

    processed = _process_thread(
        settings=settings,
        record=record,
        broker_name="Labeled Broker",
        broker_email="privacy@labeled.example",
        store=store,
        gmail=gmail,
        ai_client=_mock_anthropic("NEEDS_MANUAL"),
    )

    assert processed is True
    updated = store.get("labeled")
    assert updated.needs_manual_reason is not None
    assert updated.needs_manual_reason.raw_reply_body == raw_body
    store.close()


def test_needs_manual_transition_records_previous_status(tmp_path):
    settings = _settings(tmp_path)
    store = SQLiteStore(settings.sqlite_path)
    record = _record(status=BrokerStatus.AWAITING_RESPONSE_PINGED)
    store.upsert(record)
    store.add_whitelist(
        WhitelistEntry(broker_id="labeled", email="privacy@labeled.example")
    )
    gmail = FakeGmail(
        threads={
            "thread-labeled": [
                EmailMessage(
                    message_id="reply-labeled",
                    thread_id="thread-labeled",
                    sender="privacy@labeled.example",
                    subject="Portal action required",
                    body="Please log in to our privacy portal to finish the opt-out.",
                )
            ]
        }
    )

    processed = _process_thread(
        settings=settings,
        record=record,
        broker_name="Labeled Broker",
        broker_email="privacy@labeled.example",
        store=store,
        gmail=gmail,
        ai_client=_mock_anthropic("NEEDS_MANUAL"),
    )

    assert processed is True
    updated = store.get("labeled")
    assert updated.status == BrokerStatus.NEEDS_MANUAL
    assert updated.previous_status == BrokerStatus.AWAITING_RESPONSE_PINGED
    store.close()


def test_poll_processes_self_reply_when_bypass_enabled(tmp_path):
    settings = _settings(tmp_path, allow_self_reply=True)
    store = SQLiteStore(settings.sqlite_path)
    record = _record()
    store.upsert(record)
    store.add_whitelist(WhitelistEntry(broker_id="labeled", email="me@example.com"))
    gmail = FakeGmail(
        threads={
            "thread-labeled": [
                EmailMessage(
                    message_id="sent-labeled",
                    thread_id="thread-labeled",
                    sender="me@example.com",
                    subject="Opt out request",
                    body="Please remove me.",
                ),
                EmailMessage(
                    message_id="reply-self",
                    thread_id="thread-labeled",
                    sender="me@example.com",
                    subject="Re: request",
                    body="We received your request.",
                ),
            ]
        }
    )
    anthropic_client = _mock_anthropic("ACKNOWLEDGMENT")

    with patch("smokescreen.jobs.poll.log") as log:
        processed = _process_thread(
            settings=settings,
            record=record,
            broker_name="Labeled Broker",
            broker_email="privacy@labeled.example",
            store=store,
            gmail=gmail,
            ai_client=anthropic_client,
        )

    assert processed is True
    updated = store.get("labeled")
    assert updated.status == BrokerStatus.AWAITING_RESPONSE
    assert updated.last_message_id == "reply-self"
    anthropic_client.messages.create.assert_called_once()
    log.warning.assert_any_call(
        "self_reply_bypass_active",
        broker="labeled",
        sender="me@example.com",
    )
    store.close()


def test_poll_filters_self_reply_by_default(tmp_path):
    settings = _settings(tmp_path)
    store = SQLiteStore(settings.sqlite_path)
    record = _record()
    store.upsert(record)
    store.add_whitelist(WhitelistEntry(broker_id="labeled", email="me@example.com"))
    gmail = FakeGmail(
        threads={
            "thread-labeled": [
                EmailMessage(
                    message_id="sent-labeled",
                    thread_id="thread-labeled",
                    sender="me@example.com",
                    subject="Opt out request",
                    body="Please remove me.",
                ),
                EmailMessage(
                    message_id="reply-self",
                    thread_id="thread-labeled",
                    sender="me@example.com",
                    subject="Re: request",
                    body="We received your request.",
                ),
            ]
        }
    )
    anthropic_client = _mock_anthropic("ACKNOWLEDGMENT")

    with patch("smokescreen.jobs.poll.log") as log:
        processed = _process_thread(
            settings=settings,
            record=record,
            broker_name="Labeled Broker",
            broker_email="privacy@labeled.example",
            store=store,
            gmail=gmail,
            ai_client=anthropic_client,
        )

    assert processed is False
    updated = store.get("labeled")
    assert updated.status == BrokerStatus.INITIAL_SENT
    assert updated.last_message_id == "sent-labeled"
    assert store.list_pending_whitelist(PendingWhitelistStatus.PENDING) == []
    anthropic_client.messages.create.assert_not_called()
    log.warning.assert_not_called()
    store.close()


def test_process_thread_sends_follow_up_reply_from_verification_profile(tmp_path):
    settings = _settings(tmp_path)
    store = SQLiteStore(settings.sqlite_path)
    store.set_verification_profile(
        VerificationProfile(
            home_addresses=[
                VerificationAddress(
                    street="1 Main St",
                    city="Springfield",
                    state="CA",
                    zip="90210",
                    country="US",
                )
            ],
            phone_numbers=["+1 555 0100"],
        )
    )
    record = _record(status=BrokerStatus.AWAITING_RESPONSE)
    store.upsert(record)
    store.add_whitelist(
        WhitelistEntry(broker_id="labeled", email="privacy@labeled.example")
    )
    gmail = FakeGmail(
        threads={
            "thread-labeled": [
                EmailMessage(
                    message_id="reply-labeled",
                    thread_id="thread-labeled",
                    sender="privacy@labeled.example",
                    subject="Identity verification",
                    body="Please send your home address and phone number.",
                    has_attachments=True,
                )
            ]
        }
    )

    processed = _process_thread(
        settings=settings,
        record=record,
        broker_name="Labeled Broker",
        broker_email="privacy@labeled.example",
        store=store,
        gmail=gmail,
        ai_client=_mock_anthropic(
            _info_request_response(["home_address", "phone_number"])
        ),
    )

    assert processed is True
    assert len(gmail.sent_messages) == 1
    sent = gmail.sent_messages[0]
    assert sent["to"] == "privacy@labeled.example"
    assert sent["subject"] == "Re: Identity verification"
    assert sent["thread_id"] == "thread-labeled"
    assert "Home address: 1 Main St; Springfield, CA 90210; US" in sent["body"]
    assert "Phone number: +1 555 0100" in sent["body"]
    assert "attached" not in sent["body"].lower()
    assert "attachment_paths" not in sent
    updated = store.get("labeled")
    assert updated.status == BrokerStatus.FOLLOW_UP_SENT
    assert updated.retries == 1
    assert updated.last_message_id == "reply-labeled"
    assert updated.requested_fields == ["home_address", "phone_number"]
    assert updated.missing_fields == []
    store.close()


def test_info_request_documents_available_auto_responds(tmp_path):
    settings = _settings(tmp_path)
    store = SQLiteStore(settings.sqlite_path)
    store.set_verification_profile(
        VerificationProfile(
            documents=[
                VerificationDocument(
                    label="Utility Bill",
                    storage_note="Offline file cabinet",
                ),
                VerificationDocument(
                    label="Driver License",
                    storage_note="Physical wallet",
                ),
            ],
        )
    )
    record = _record(status=BrokerStatus.AWAITING_RESPONSE)
    store.upsert(record)
    store.add_whitelist(
        WhitelistEntry(broker_id="labeled", email="privacy@labeled.example")
    )
    gmail = FakeGmail(
        threads={
            "thread-labeled": [
                EmailMessage(
                    message_id="reply-labeled",
                    thread_id="thread-labeled",
                    sender="privacy@labeled.example",
                    subject="Identity verification",
                    body="Please send proof of address and a copy of your ID.",
                )
            ]
        }
    )

    processed = _process_thread(
        settings=settings,
        record=record,
        broker_name="Labeled Broker",
        broker_email="privacy@labeled.example",
        store=store,
        gmail=gmail,
        ai_client=_mock_anthropic(_info_request_response(["documents"])),
    )

    assert processed is True
    assert len(gmail.sent_messages) == 1
    sent = gmail.sent_messages[0]
    assert sent["to"] == "privacy@labeled.example"
    assert sent["subject"] == "Re: Identity verification"
    assert sent["thread_id"] == "thread-labeled"
    assert (
        "Available documents on request: Utility Bill, Driver License"
        in sent["body"]
    )
    assert "Offline file cabinet" not in sent["body"]
    assert "Physical wallet" not in sent["body"]
    assert "attachment_paths" not in sent
    updated = store.get("labeled")
    assert updated.status == BrokerStatus.FOLLOW_UP_SENT
    assert updated.requested_fields == ["documents"]
    assert updated.missing_fields == []
    assert updated.retries == 1
    store.close()


def test_composer_fallback_to_template_on_llm_failure(tmp_path):
    settings = _settings(tmp_path)
    store = SQLiteStore(settings.sqlite_path)
    store.set_verification_profile(
        VerificationProfile(
            home_addresses=[
                VerificationAddress(
                    street="1 Main St",
                    city="Springfield",
                    state="CA",
                    zip="90210",
                    country="US",
                )
            ]
        )
    )
    record = _record(status=BrokerStatus.AWAITING_RESPONSE)
    store.upsert(record)
    store.add_whitelist(
        WhitelistEntry(broker_id="labeled", email="privacy@labeled.example")
    )
    gmail = FakeGmail(
        threads={
            "thread-labeled": [
                EmailMessage(
                    message_id="reply-labeled",
                    thread_id="thread-labeled",
                    sender="privacy@labeled.example",
                    subject="Identity verification",
                    body="Please send your home address.",
                )
            ]
        }
    )
    client = _mock_anthropic_sequence([_info_request_response(["home_address"])])
    client.messages.create.side_effect = [
        _mock_anthropic_response(_info_request_response(["home_address"])),
        RuntimeError("timeout"),
    ]

    processed = _process_thread(
        settings=settings,
        record=record,
        broker_name="Labeled Broker",
        broker_email="privacy@labeled.example",
        store=store,
        gmail=gmail,
        ai_client=client,
    )

    assert processed is True
    assert len(gmail.sent_messages) == 1
    sent = gmail.sent_messages[0]
    assert sent["subject"] == "Re: Identity verification"
    assert "Thank you for your response. As requested" in sent["body"]
    assert "Home address: 1 Main St; Springfield, CA 90210; US" in sent["body"]
    assert store.get("labeled").status == BrokerStatus.FOLLOW_UP_SENT
    store.close()


def test_rejected_transitions_to_needs_manual_broker_rejected(tmp_path):
    settings = _settings(tmp_path)
    store = SQLiteStore(settings.sqlite_path)
    record = _record(status=BrokerStatus.AWAITING_RESPONSE)
    store.upsert(record)
    store.add_whitelist(
        WhitelistEntry(broker_id="labeled", email="privacy@labeled.example")
    )
    gmail = FakeGmail(
        threads={
            "thread-labeled": [
                EmailMessage(
                    message_id="reply-labeled",
                    thread_id="thread-labeled",
                    sender="privacy@labeled.example",
                    subject="Request rejected",
                    body="We cannot process this deletion request.",
                )
            ]
        }
    )

    processed = _process_thread(
        settings=settings,
        record=record,
        broker_name="Labeled Broker",
        broker_email="privacy@labeled.example",
        store=store,
        gmail=gmail,
        ai_client=_mock_anthropic("REJECTED"),
    )

    assert processed is True
    assert gmail.sent_messages == []
    updated = store.get("labeled")
    assert updated.status == BrokerStatus.NEEDS_MANUAL
    assert updated.previous_status == BrokerStatus.AWAITING_RESPONSE
    assert updated.last_message_id == "reply-labeled"
    assert updated.needs_manual_reason is not None
    assert updated.needs_manual_reason.reason_code == "broker_rejected"
    assert updated.needs_manual_reason.short_summary == (
        "Broker rejected the deletion request. Review and choose to accept or "
        "escalate."
    )
    assert (
        updated.needs_manual_reason.broker_reply_excerpt
        == "We cannot process this deletion request."
    )
    assert updated.needs_manual_reason.classifier_output["classification"] == "REJECTED"
    assert updated.needs_manual_reason.missing_fields == []
    assert updated.needs_manual_reason.transitioned_at.tzinfo is not None
    store.close()


def test_second_rejection_after_rebuttal_transitions_to_terminal_rejected(tmp_path):
    settings = _settings(tmp_path)
    store = SQLiteStore(settings.sqlite_path)
    record = _record(status=BrokerStatus.REJECTED_REBUTTED)
    store.upsert(record)
    store.add_whitelist(
        WhitelistEntry(broker_id="labeled", email="privacy@labeled.example")
    )
    gmail = FakeGmail(
        threads={
            "thread-labeled": [
                EmailMessage(
                    message_id="reply-labeled",
                    thread_id="thread-labeled",
                    sender="privacy@labeled.example",
                    subject="Request still rejected",
                    body="We still reject this request.",
                )
            ]
        }
    )

    processed = _process_thread(
        settings=settings,
        record=record,
        broker_name="Labeled Broker",
        broker_email="privacy@labeled.example",
        store=store,
        gmail=gmail,
        ai_client=_mock_anthropic("REJECTED"),
    )

    assert processed is True
    assert gmail.sent_messages == []
    updated = store.get("labeled")
    assert updated.status == BrokerStatus.REJECTED
    assert updated.last_message_id == "reply-labeled"
    store.close()


def test_info_request_documents_missing_needs_manual(tmp_path):
    settings = _settings(tmp_path)
    store = SQLiteStore(settings.sqlite_path)
    record = _record(status=BrokerStatus.AWAITING_RESPONSE)
    store.upsert(record)
    store.add_whitelist(
        WhitelistEntry(broker_id="labeled", email="privacy@labeled.example")
    )
    gmail = FakeGmail(
        threads={
            "thread-labeled": [
                EmailMessage(
                    message_id="reply-labeled",
                    thread_id="thread-labeled",
                    sender="privacy@labeled.example",
                    subject="Identity verification",
                    body="Please send a copy of your ID.",
                )
            ]
        }
    )

    processed = _process_thread(
        settings=settings,
        record=record,
        broker_name="Labeled Broker",
        broker_email="privacy@labeled.example",
        store=store,
        gmail=gmail,
        ai_client=_mock_anthropic(_info_request_response(["documents"])),
    )

    assert processed is True
    assert gmail.sent_messages == []
    updated = store.get("labeled")
    assert updated.status == BrokerStatus.NEEDS_MANUAL
    assert updated.requested_fields == ["documents"]
    assert updated.missing_fields == ["documents"]
    assert updated.needs_manual_reason is not None
    assert (
        updated.needs_manual_reason.reason_code
        == "documents_requested_none_available"
    )
    assert "documents-not-available" in updated.notes
    store.close()


def test_process_thread_info_request_missing_profile_field_needs_manual(tmp_path):
    settings = _settings(tmp_path)
    store = SQLiteStore(settings.sqlite_path)
    record = _record(status=BrokerStatus.AWAITING_RESPONSE)
    store.upsert(record)
    store.add_whitelist(
        WhitelistEntry(broker_id="labeled", email="privacy@labeled.example")
    )
    gmail = FakeGmail(
        threads={
            "thread-labeled": [
                EmailMessage(
                    message_id="reply-labeled",
                    thread_id="thread-labeled",
                    sender="privacy@labeled.example",
                    subject="Identity verification",
                    body="Please send your phone number.",
                )
            ]
        }
    )

    processed = _process_thread(
        settings=settings,
        record=record,
        broker_name="Labeled Broker",
        broker_email="privacy@labeled.example",
        store=store,
        gmail=gmail,
        ai_client=_mock_anthropic(_info_request_response(["phone_number"])),
    )

    assert processed is True
    assert gmail.sent_messages == []
    updated = store.get("labeled")
    assert updated.status == BrokerStatus.NEEDS_MANUAL
    assert updated.requested_fields == ["phone_number"]
    assert updated.missing_fields == ["phone_number"]
    assert updated.previous_status == BrokerStatus.AWAITING_RESPONSE
    assert updated.needs_manual_reason is not None
    assert updated.needs_manual_reason.reason_code == "info_request_missing_fields"
    assert updated.needs_manual_reason.missing_fields == ["phone_number"]
    assert (
        updated.needs_manual_reason.classifier_output["classification"]
        == "INFO_REQUEST"
    )
    assert "You are missing: Phone number" in updated.notes
    store.close()


def test_process_thread_info_request_other_needs_manual(tmp_path):
    settings = _settings(tmp_path)
    store = SQLiteStore(settings.sqlite_path)
    record = _record(status=BrokerStatus.AWAITING_RESPONSE)
    store.upsert(record)
    store.add_whitelist(
        WhitelistEntry(broker_id="labeled", email="privacy@labeled.example")
    )
    gmail = FakeGmail(
        threads={
            "thread-labeled": [
                EmailMessage(
                    message_id="reply-labeled",
                    thread_id="thread-labeled",
                    sender="privacy@labeled.example",
                    subject="Identity verification",
                    body="Please send your account number.",
                )
            ]
        }
    )

    processed = _process_thread(
        settings=settings,
        record=record,
        broker_name="Labeled Broker",
        broker_email="privacy@labeled.example",
        store=store,
        gmail=gmail,
        ai_client=_mock_anthropic(
            _info_request_response(["other"], other_details="Account number")
        ),
    )

    assert processed is True
    assert gmail.sent_messages == []
    updated = store.get("labeled")
    assert updated.status == BrokerStatus.NEEDS_MANUAL
    assert updated.requested_fields == ["other"]
    assert updated.missing_fields == ["other"]
    assert updated.requested_other_details == "Account number"
    assert "Account number" in updated.notes
    store.close()


def test_process_thread_info_request_without_requested_fields_needs_manual(tmp_path):
    settings = _settings(tmp_path)
    store = SQLiteStore(settings.sqlite_path)
    record = _record(status=BrokerStatus.AWAITING_RESPONSE)
    store.upsert(record)
    store.add_whitelist(
        WhitelistEntry(broker_id="labeled", email="privacy@labeled.example")
    )
    gmail = FakeGmail(
        threads={
            "thread-labeled": [
                EmailMessage(
                    message_id="reply-labeled",
                    thread_id="thread-labeled",
                    sender="privacy@labeled.example",
                    subject="Identity verification",
                    body="Please send whatever you can.",
                )
            ]
        }
    )

    processed = _process_thread(
        settings=settings,
        record=record,
        broker_name="Labeled Broker",
        broker_email="privacy@labeled.example",
        store=store,
        gmail=gmail,
        ai_client=_mock_anthropic("INFO_REQUEST"),
    )

    assert processed is True
    assert gmail.sent_messages == []
    updated = store.get("labeled")
    assert updated.status == BrokerStatus.NEEDS_MANUAL
    assert updated.requested_fields == []
    assert updated.missing_fields == ["other"]
    assert "could not identify the exact fields" in updated.notes
    store.close()


def test_run_poll_handles_first_reply_info_request(tmp_path):
    settings = _settings(
        tmp_path,
        anthropic_api_key="test-key",
        dry_run=True,
        poll_label="",
    )
    store = SQLiteStore(settings.sqlite_path)
    store.set_verification_profile(
        VerificationProfile(
            home_addresses=[
                VerificationAddress(
                    street="1 Main St",
                    city="Springfield",
                    state="CA",
                    zip="90210",
                )
            ]
        )
    )
    store.upsert(
        OptOutRecord(
            broker_id="labeled",
            status=BrokerStatus.INITIAL_SENT,
            thread_id="alpha-thread",
            last_message_id="alpha-sent",
        )
    )
    store.add_whitelist(
        WhitelistEntry(broker_id="labeled", email="caseworker@vendor.example")
    )
    gmail = FakeGmail(
        threads={
            "alpha-thread": [
                EmailMessage(
                    message_id="alpha-sent",
                    thread_id="alpha-thread",
                    sender="me@example.com",
                    subject="Opt out request",
                    body="Please remove me.",
                ),
                EmailMessage(
                    message_id="alpha-vendor",
                    thread_id="alpha-thread",
                    sender="caseworker@vendor.example",
                    subject="Identity verification",
                    body="Please send your home address.",
                ),
            ]
        }
    )

    with patch("smokescreen.jobs.poll.Anthropic") as anthropic:
        anthropic.return_value = _mock_anthropic(
            _info_request_response(["home_address"])
        )
        processed = run_poll(settings, _registry(), store, gmail=gmail)

    assert processed == ["labeled"]
    updated = store.get("labeled")
    assert updated.status == BrokerStatus.FOLLOW_UP_SENT
    assert updated.retries == 1
    assert updated.last_message_id == "alpha-vendor"
    assert updated.requested_fields == ["home_address"]
    assert gmail.sent_messages == []
    store.close()


def test_poll_continues_after_single_record_exception(tmp_path):
    settings = _settings(tmp_path, poll_label="")
    store = SQLiteStore(settings.sqlite_path)
    _seed_store(store)
    gmail = FakeGmail()

    with (
        patch("smokescreen.jobs.poll._process_thread") as process_thread,
        patch("smokescreen.jobs.poll.log") as log,
    ):
        process_thread.side_effect = [RuntimeError("boom"), True]
        processed = run_poll(settings, _registry(), store, gmail=gmail)

    assert processed == ["unlabeled"]
    assert process_thread.call_count == 2
    log.exception.assert_called_once_with(
        "poll_record_processing_failed",
        broker_id="labeled",
        error_type="RuntimeError",
        error_message="boom",
    )
    store.close()


def test_process_thread_marks_needs_manual_for_unknown_sender(tmp_path):
    settings = _settings(tmp_path)
    store = SQLiteStore(settings.sqlite_path)
    record = _record()
    store.upsert(record)
    gmail = FakeGmail(
        threads={
            "thread-labeled": [
                EmailMessage(
                    message_id="reply-labeled",
                    thread_id="thread-labeled",
                    sender="reply@labeled.example",
                    subject="Re: request",
                    body="x" * 250,
                )
            ]
        }
    )
    anthropic_client = _mock_anthropic("COMPLETED")

    with patch("smokescreen.jobs.poll.log") as log:
        processed = _process_thread(
            settings=settings,
            record=record,
            broker_name="Labeled Broker",
            broker_email="privacy@labeled.example",
            store=store,
            gmail=gmail,
            ai_client=anthropic_client,
        )

    assert processed is True
    pending = store.list_pending_whitelist(PendingWhitelistStatus.PENDING)
    assert len(pending) == 1
    assert pending[0].broker_id == "labeled"
    assert pending[0].email == "reply@labeled.example"
    assert pending[0].message_subject == "Re: request"
    assert pending[0].message_snippet == "x" * 200
    updated = store.get("labeled")
    assert updated.status == BrokerStatus.NEEDS_MANUAL
    assert updated.previous_status == BrokerStatus.INITIAL_SENT
    assert updated.needs_manual_reason is not None
    assert updated.needs_manual_reason.reason_code == "untrusted_sender_reply"
    assert updated.needs_manual_reason.broker_reply_excerpt == "x" * 250
    assert (
        updated.notes
        == "Reply received from untrusted sender reply@labeled.example - "
        "approve in Trusted Senders if legitimate"
    )
    log.warning.assert_any_call(
        "poll_needs_manual_untrusted_sender",
        broker="labeled",
        sender="reply@labeled.example",
    )
    anthropic_client.messages.create.assert_not_called()
    store.close()


def test_run_poll_deduplicates_pending_whitelist_for_repeated_unknown_reply(
    tmp_path,
):
    settings = _settings(tmp_path, poll_label="")
    store = SQLiteStore(settings.sqlite_path)
    store.upsert(
        OptOutRecord(
            broker_id="labeled",
            status=BrokerStatus.INITIAL_SENT,
            thread_id="thread-labeled",
            last_message_id="sent-labeled",
        )
    )
    gmail = FakeGmail(
        threads={
            "thread-labeled": [
                EmailMessage(
                    message_id="sent-labeled",
                    thread_id="thread-labeled",
                    sender="me@example.com",
                    subject="Opt out request",
                    body="Please remove me.",
                ),
                EmailMessage(
                    message_id="vendor-labeled",
                    thread_id="thread-labeled",
                    sender="caseworker@vendor.example",
                    subject="Verify identity",
                    body="Please verify your identity.",
                ),
            ]
        }
    )

    first = run_poll(settings, _registry(), store, gmail=gmail)
    second = run_poll(settings, _registry(), store, gmail=gmail)

    assert first == ["labeled"]
    assert second == []
    pending = store.list_pending_whitelist(PendingWhitelistStatus.PENDING)
    assert len(pending) == 1
    assert pending[0].email == "caseworker@vendor.example"
    assert pending[0].message_subject == "Verify identity"
    updated = store.get("labeled")
    assert updated.status == BrokerStatus.NEEDS_MANUAL
    assert updated.last_message_id == "vendor-labeled"
    store.close()


def test_poll_deduplicates_when_last_message_id_matches(tmp_path):
    settings = _settings(tmp_path)
    store = SQLiteStore(settings.sqlite_path)
    record = _record(status=BrokerStatus.AWAITING_RESPONSE)
    record.last_message_id = "reply-labeled"
    store.upsert(record)
    store.add_whitelist(
        WhitelistEntry(broker_id="labeled", email="privacy@labeled.example")
    )
    gmail = FakeGmail(
        threads={
            "thread-labeled": [
                EmailMessage(
                    message_id="reply-labeled",
                    thread_id="thread-labeled",
                    sender="privacy@labeled.example",
                    subject="Re: request",
                    body="Please verify your identity.",
                )
            ]
        }
    )
    anthropic_client = _mock_anthropic("NEEDS_MANUAL")

    with patch("smokescreen.jobs.poll.log") as log:
        processed = _process_thread(
            settings=settings,
            record=record,
            broker_name="Labeled Broker",
            broker_email="privacy@labeled.example",
            store=store,
            gmail=gmail,
            ai_client=anthropic_client,
        )

    assert processed is False
    anthropic_client.messages.create.assert_not_called()
    assert store.get("labeled").status == BrokerStatus.AWAITING_RESPONSE
    log.info.assert_any_call(
        "poll_message_already_processed",
        broker="labeled",
        message_id="reply-labeled",
        thread_id="thread-labeled",
    )
    store.close()


def test_poll_does_not_send_duplicate_follow_up_for_same_message(tmp_path):
    settings = _settings(tmp_path)
    store = SQLiteStore(settings.sqlite_path)
    store.set_verification_profile(
        VerificationProfile(
            home_addresses=[
                VerificationAddress(
                    street="1 Main St",
                    city="Springfield",
                    state="CA",
                    zip="90210",
                    country="US",
                )
            ]
        )
    )
    record = _record(status=BrokerStatus.AWAITING_RESPONSE)
    store.upsert(record)
    store.add_whitelist(
        WhitelistEntry(broker_id="labeled", email="privacy@labeled.example")
    )
    gmail = FakeGmail(
        threads={
            "thread-labeled": [
                EmailMessage(
                    message_id="reply-labeled",
                    thread_id="thread-labeled",
                    sender="privacy@labeled.example",
                    subject="Identity verification",
                    body="Please send your home address.",
                )
            ]
        }
    )
    anthropic_client = _mock_anthropic(_info_request_response(["home_address"]))

    first = _process_thread(
        settings=settings,
        record=record,
        broker_name="Labeled Broker",
        broker_email="privacy@labeled.example",
        store=store,
        gmail=gmail,
        ai_client=anthropic_client,
    )
    second = _process_thread(
        settings=settings,
        record=store.get("labeled"),
        broker_name="Labeled Broker",
        broker_email="privacy@labeled.example",
        store=store,
        gmail=gmail,
        ai_client=anthropic_client,
    )

    assert first is True
    assert second is False
    assert len(gmail.sent_messages) == 1
    assert anthropic_client.messages.create.call_count == 2
    updated = store.get("labeled")
    assert updated.status == BrokerStatus.FOLLOW_UP_SENT
    assert updated.last_message_id == "reply-labeled"
    store.close()


def test_poll_does_not_re_transition_needs_manual_for_same_message(tmp_path):
    settings = _settings(tmp_path)
    store = SQLiteStore(settings.sqlite_path)
    record = _record(status=BrokerStatus.NEEDS_MANUAL)
    record.previous_status = BrokerStatus.AWAITING_RESPONSE
    record.last_message_id = "reply-labeled"
    record.notes = "existing manual review"
    store.upsert(record)
    store.add_whitelist(
        WhitelistEntry(broker_id="labeled", email="privacy@labeled.example")
    )
    gmail = FakeGmail(
        threads={
            "thread-labeled": [
                EmailMessage(
                    message_id="reply-labeled",
                    thread_id="thread-labeled",
                    sender="privacy@labeled.example",
                    subject="Portal action required",
                    body="Please use our portal.",
                )
            ]
        }
    )
    anthropic_client = _mock_anthropic("COMPLETED")

    processed = _process_thread(
        settings=settings,
        record=record,
        broker_name="Labeled Broker",
        broker_email="privacy@labeled.example",
        store=store,
        gmail=gmail,
        ai_client=anthropic_client,
    )

    assert processed is False
    anthropic_client.messages.create.assert_not_called()
    updated = store.get("labeled")
    assert updated.status == BrokerStatus.NEEDS_MANUAL
    assert updated.previous_status == BrokerStatus.AWAITING_RESPONSE
    assert updated.notes == "existing manual review"
    assert updated.last_message_id == "reply-labeled"
    store.close()


def test_process_thread_accepts_display_name_from_header(tmp_path):
    settings = _settings(tmp_path)
    store = SQLiteStore(settings.sqlite_path)
    record = _record()
    store.upsert(record)
    store.add_whitelist(
        WhitelistEntry(broker_id="labeled", email="privacy@labeled.example")
    )
    gmail = FakeGmail(
        threads={
            "thread-labeled": [
                EmailMessage(
                    message_id="reply-labeled",
                    thread_id="thread-labeled",
                    sender='"Labeled Privacy Team" <privacy@labeled.example>',
                    subject="Re: request",
                    body="We need more context.",
                )
            ]
        }
    )

    processed = _process_thread(
        settings=settings,
        record=record,
        broker_name="Labeled Broker",
        broker_email="privacy@labeled.example",
        store=store,
        gmail=gmail,
        ai_client=None,
    )

    assert processed is True
    assert store.get("labeled").status == BrokerStatus.NEEDS_MANUAL
    assert store.list_pending_whitelist(PendingWhitelistStatus.PENDING) == []
    store.close()


# --- Timeout escalation (sm-aa1) ---


def _seed_record(
    store: SQLiteStore,
    *,
    broker_id: str,
    status: BrokerStatus,
    days_ago: int,
) -> None:
    now = datetime.utcnow()
    stale = now - timedelta(days=days_ago)
    store.upsert(
        OptOutRecord(
            broker_id=broker_id,
            status=status,
            thread_id=f"thread-{broker_id}",
            last_message_id=f"msg-{broker_id}",
            created_at=stale,
            updated_at=stale,
        )
    )


def test_timeout_escalation_pings_stale_waiting_record(tmp_path):
    """After state_timeout_days without a state change, waiting records get
    pinged and transition to their paired *_PINGED state."""
    settings = _settings(tmp_path, dry_run=True, state_timeout_days=14)
    store = SQLiteStore(settings.sqlite_path)
    _seed_record(
        store,
        broker_id="labeled",
        status=BrokerStatus.AWAITING_RESPONSE,
        days_ago=15,
    )

    processed = run_timeout_escalation(settings, _registry(), store, gmail=None)

    assert processed == ["labeled"]
    updated = store.get("labeled")
    assert updated.status == BrokerStatus.AWAITING_RESPONSE_PINGED
    store.close()


def test_timeout_escalation_is_idempotent_within_window(tmp_path):
    """A second sweep inside the same timeout window does not ping again or
    escalate — updated_at moved forward on the first sweep."""
    settings = _settings(tmp_path, dry_run=True, state_timeout_days=14)
    store = SQLiteStore(settings.sqlite_path)
    _seed_record(
        store,
        broker_id="labeled",
        status=BrokerStatus.AWAITING_RESPONSE,
        days_ago=20,
    )

    first = run_timeout_escalation(settings, _registry(), store, gmail=None)
    second = run_timeout_escalation(settings, _registry(), store, gmail=None)

    assert first == ["labeled"]
    assert second == []  # no work left this window
    assert store.get("labeled").status == BrokerStatus.AWAITING_RESPONSE_PINGED
    store.close()


def test_timeout_escalation_second_strike_moves_to_needs_manual(tmp_path):
    """After a second silent window on a pinged state, escalate."""
    settings = _settings(tmp_path, dry_run=True, state_timeout_days=14)
    store = SQLiteStore(settings.sqlite_path)
    _seed_record(
        store,
        broker_id="labeled",
        status=BrokerStatus.AWAITING_RESPONSE_PINGED,
        days_ago=15,
    )

    processed = run_timeout_escalation(settings, _registry(), store, gmail=None)

    assert processed == ["labeled"]
    updated = store.get("labeled")
    assert updated.status == BrokerStatus.NEEDS_MANUAL
    assert "AWAITING_RESPONSE" in updated.notes
    assert updated.previous_status == BrokerStatus.AWAITING_RESPONSE_PINGED
    assert updated.needs_manual_reason is not None
    assert (
        updated.needs_manual_reason.reason_code
        == "timeout_escalation_second_window"
    )
    assert (
        updated.needs_manual_reason.classifier_output["timed_out_status"]
        == "AWAITING_RESPONSE_PINGED"
    )
    store.close()


def test_timeout_escalation_leaves_fresh_records_alone(tmp_path):
    """Records that had a state transition inside the window aren't touched."""
    settings = _settings(tmp_path, dry_run=True, state_timeout_days=14)
    store = SQLiteStore(settings.sqlite_path)
    _seed_record(
        store,
        broker_id="labeled",
        status=BrokerStatus.INITIAL_SENT,
        days_ago=3,
    )

    processed = run_timeout_escalation(settings, _registry(), store, gmail=None)

    assert processed == []
    assert store.get("labeled").status == BrokerStatus.INITIAL_SENT
    store.close()


def test_timeout_escalation_sends_ping_email_when_not_dry_run(tmp_path):
    """The ping path sends a live email via gmail.send when dry_run is off."""
    settings = _settings(tmp_path, dry_run=False, state_timeout_days=14)
    store = SQLiteStore(settings.sqlite_path)
    _seed_record(
        store,
        broker_id="labeled",
        status=BrokerStatus.INITIAL_SENT,
        days_ago=20,
    )
    gmail = FakeGmail()

    processed = run_timeout_escalation(settings, _registry(), store, gmail=gmail)

    assert processed == ["labeled"]
    assert len(gmail.sent_messages) == 1
    sent = gmail.sent_messages[0]
    assert sent["to"] == "privacy@labeled.example"
    assert "deletion request" in sent["subject"].lower()
    assert store.get("labeled").status == BrokerStatus.INITIAL_SENT_PINGED
    store.close()


def test_timeout_escalation_continues_after_single_record_exception(tmp_path):
    settings = _settings(tmp_path, dry_run=True, state_timeout_days=14)
    store = SQLiteStore(settings.sqlite_path)
    _seed_record(
        store,
        broker_id="labeled",
        status=BrokerStatus.AWAITING_RESPONSE,
        days_ago=20,
    )
    _seed_record(
        store,
        broker_id="unlabeled",
        status=BrokerStatus.AWAITING_RESPONSE,
        days_ago=20,
    )

    def fake_silent_ping(**kwargs):
        record = kwargs["record"]
        if record.broker_id == "labeled":
            raise RuntimeError("boom")
        record.status = BrokerStatus.AWAITING_RESPONSE_PINGED
        record.updated_at = kwargs["now"]
        kwargs["store"].upsert(record)

    with (
        patch(
            "smokescreen.jobs.poll._send_silent_ping",
            side_effect=fake_silent_ping,
        ),
        patch("smokescreen.jobs.poll.log") as log,
    ):
        processed = run_timeout_escalation(settings, _registry(), store, gmail=None)

    assert processed == ["unlabeled"]
    assert store.get("labeled").status == BrokerStatus.AWAITING_RESPONSE
    assert store.get("unlabeled").status == BrokerStatus.AWAITING_RESPONSE_PINGED
    log.exception.assert_called_once_with(
        "timeout_record_processing_failed",
        broker_id="labeled",
        error_type="RuntimeError",
        error_message="boom",
        current_status="AWAITING_RESPONSE",
    )
    store.close()
