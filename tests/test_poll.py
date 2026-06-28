"""Tests for polling broker reply threads."""

from unittest.mock import MagicMock, patch

from smokescreen.brokers.registry import BrokerRegistry
from smokescreen.config import Settings
from smokescreen.jobs.poll import _poll_label_query, _process_thread, run_poll
from smokescreen.models import (
    Broker,
    BrokerStatus,
    EmailMessage,
    OptOutRecord,
    PendingWhitelistStatus,
    WhitelistEntry,
)
from smokescreen.state.sqlite import SQLiteStore


class FakeGmail:
    def __init__(
        self,
        *,
        search_results: list[str] | None = None,
        messages: dict[str, EmailMessage] | None = None,
        threads: dict[str, list[EmailMessage]] | None = None,
    ) -> None:
        self.search_results = search_results or []
        self.messages = messages or {}
        self.threads = threads or {}
        self.searches: list[str] = []
        self.fetched_threads: list[str] = []
        self.sent_messages: list[dict] = []

    def search(self, query: str, max_results: int = 50) -> list[str]:
        self.searches.append(query)
        return self.search_results

    def get_message(self, message_id: str) -> EmailMessage:
        return self.messages[message_id]

    def get_thread(self, thread_id: str) -> list[EmailMessage]:
        self.fetched_threads.append(thread_id)
        return self.threads.get(thread_id, [])

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


def _mock_anthropic(label: str) -> MagicMock:
    client = MagicMock()
    content_block = MagicMock()
    content_block.text = label
    client.messages.create.return_value = MagicMock(content=[content_block])
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
        search_results=["msg-labeled"],
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
    assert gmail.searches == ["label:custom-label"]
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
        anthropic_client=None,
    )

    assert processed is True
    updated = store.get("labeled")
    assert updated.status == BrokerStatus.NEEDS_MANUAL
    assert updated.notes == "No Anthropic API key configured"
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
        anthropic_client=_mock_anthropic("NEEDS_MANUAL"),
    )

    assert processed is True
    updated = store.get("labeled")
    assert updated.status == BrokerStatus.NEEDS_MANUAL
    assert updated.last_message_id == "reply-labeled"
    assert (
        updated.notes
        == "Subject: Portal action required\n\n"
        "Please log in to our privacy portal to finish the opt-out."
    )
    store.close()


def test_process_thread_sends_identity_reply_with_attachments(tmp_path):
    identity_dir = tmp_path / "identity"
    identity_dir.mkdir()
    front = identity_dir / "license-front.txt"
    back = identity_dir / "license-back.txt"
    front.write_text("front", encoding="utf-8")
    back.write_text("back", encoding="utf-8")
    settings = _settings(tmp_path, identity_docs_dir=identity_dir)
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
        anthropic_client=_mock_anthropic("IDENTITY_REQUEST"),
    )

    assert processed is True
    assert len(gmail.sent_messages) == 1
    sent = gmail.sent_messages[0]
    assert sent["to"] == "privacy@labeled.example"
    assert sent["subject"] == "Re: Identity verification"
    assert sent["thread_id"] == "thread-labeled"
    assert {path.name for path in sent["attachment_paths"]} == {
        "license-front.txt",
        "license-back.txt",
    }
    updated = store.get("labeled")
    assert updated.status == BrokerStatus.IDENTITY_SENT
    assert updated.retries == 1
    assert updated.last_message_id == "sent-identity"
    store.close()


def test_run_poll_handles_first_reply_identity_request(tmp_path):
    settings = _settings(
        tmp_path,
        anthropic_api_key="test-key",
        dry_run=True,
        poll_label="",
    )
    store = SQLiteStore(settings.sqlite_path)
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
                    body="Please send a copy of your ID.",
                ),
            ]
        }
    )

    with patch("smokescreen.jobs.poll.Anthropic") as anthropic:
        anthropic.return_value = _mock_anthropic("IDENTITY_REQUEST")
        processed = run_poll(settings, _registry(), store, gmail=gmail)

    assert processed == ["labeled"]
    updated = store.get("labeled")
    assert updated.status == BrokerStatus.IDENTITY_SENT
    assert updated.retries == 1
    assert updated.last_message_id == "alpha-vendor"
    assert gmail.sent_messages == []
    store.close()


def test_process_thread_adds_pending_whitelist_for_unknown_sender(tmp_path):
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

    processed = _process_thread(
        settings=settings,
        record=record,
        broker_name="Labeled Broker",
        broker_email="privacy@labeled.example",
        store=store,
        gmail=gmail,
        anthropic_client=anthropic_client,
    )

    assert processed is False
    pending = store.list_pending_whitelist(PendingWhitelistStatus.PENDING)
    assert len(pending) == 1
    assert pending[0].broker_id == "labeled"
    assert pending[0].email == "reply@labeled.example"
    assert pending[0].message_subject == "Re: request"
    assert pending[0].message_snippet == "x" * 200
    assert store.get("labeled").status == BrokerStatus.INITIAL_SENT
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

    assert first == []
    assert second == []
    pending = store.list_pending_whitelist(PendingWhitelistStatus.PENDING)
    assert len(pending) == 1
    assert pending[0].email == "caseworker@vendor.example"
    assert pending[0].message_subject == "Verify identity"
    assert store.get("labeled").last_message_id == "sent-labeled"
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
        anthropic_client=None,
    )

    assert processed is True
    assert store.get("labeled").status == BrokerStatus.NEEDS_MANUAL
    assert store.list_pending_whitelist(PendingWhitelistStatus.PENDING) == []
    store.close()
