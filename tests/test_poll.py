"""Tests for polling broker reply threads."""

from smokescreen.brokers.registry import BrokerRegistry
from smokescreen.config import Settings
from smokescreen.jobs.poll import _poll_label_query, run_poll
from smokescreen.models import (
    Broker,
    BrokerStatus,
    EmailMessage,
    OptOutRecord,
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

    def search(self, query: str, max_results: int = 50) -> list[str]:
        self.searches.append(query)
        return self.search_results

    def get_message(self, message_id: str) -> EmailMessage:
        return self.messages[message_id]

    def get_thread(self, thread_id: str) -> list[EmailMessage]:
        self.fetched_threads.append(thread_id)
        return self.threads.get(thread_id, [])


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
