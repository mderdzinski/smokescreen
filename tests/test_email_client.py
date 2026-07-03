"""Tests for the Gmail API client wrapper."""

import pytest

from smokescreen.email.client import GmailClient


class _Executable:
    def __init__(self, result: dict) -> None:
        self._result = result

    def execute(self) -> dict:
        return self._result


class _LabelsResource:
    def __init__(self, service: "_FakeGmailService") -> None:
        self._service = service

    def list(self, *, userId: str) -> _Executable:
        self._service.label_list_calls.append(userId)
        return _Executable({"labels": self._service.labels})

    def create(self, *, userId: str, body: dict) -> _Executable:
        self._service.label_create_calls.append({"userId": userId, "body": body})
        return _Executable({"id": self._service.created_label_id})


class _ThreadsResource:
    def __init__(self, service: "_FakeGmailService") -> None:
        self._service = service

    def modify(self, *, userId: str, id: str, body: dict) -> _Executable:
        self._service.thread_modify_calls.append(
            {"userId": userId, "id": id, "body": body}
        )
        return _Executable({"id": id})


class _UsersResource:
    def __init__(self, service: "_FakeGmailService") -> None:
        self._service = service

    def labels(self) -> _LabelsResource:
        return _LabelsResource(self._service)

    def threads(self) -> _ThreadsResource:
        return _ThreadsResource(self._service)


class _FakeGmailService:
    def __init__(
        self,
        *,
        labels: list[dict] | None = None,
        created_label_id: str = "Label_created",
    ) -> None:
        self.labels = labels or []
        self.created_label_id = created_label_id
        self.label_list_calls: list[str] = []
        self.label_create_calls: list[dict] = []
        self.thread_modify_calls: list[dict] = []

    def users(self) -> _UsersResource:
        return _UsersResource(self)


def _client_for(service: _FakeGmailService) -> GmailClient:
    client = GmailClient.__new__(GmailClient)
    client._service = service
    client._label_ids = {}
    return client


def test_label_thread_uses_existing_label_and_caches_label_id():
    service = _FakeGmailService(
        labels=[{"id": "Label_smokescreen", "name": "smokescreen"}]
    )
    client = _client_for(service)

    client.label_thread("thread-1", "smokescreen")
    client.label_thread("thread-2", "smokescreen")

    assert service.label_list_calls == ["me"]
    assert service.label_create_calls == []
    assert service.thread_modify_calls == [
        {
            "userId": "me",
            "id": "thread-1",
            "body": {"addLabelIds": ["Label_smokescreen"]},
        },
        {
            "userId": "me",
            "id": "thread-2",
            "body": {"addLabelIds": ["Label_smokescreen"]},
        },
    ]


def test_label_thread_creates_missing_label_before_applying_it():
    service = _FakeGmailService(created_label_id="Label_new")
    client = _client_for(service)

    client.label_thread("thread-1", "privacy replies")

    assert service.label_list_calls == ["me"]
    assert service.label_create_calls == [
        {
            "userId": "me",
            "body": {
                "name": "privacy replies",
                "labelListVisibility": "labelShow",
                "messageListVisibility": "show",
            },
        }
    ]
    assert service.thread_modify_calls == [
        {
            "userId": "me",
            "id": "thread-1",
            "body": {"addLabelIds": ["Label_new"]},
        }
    ]


def test_label_thread_rejects_blank_label_names():
    service = _FakeGmailService()
    client = _client_for(service)

    with pytest.raises(ValueError, match="label_name must not be blank"):
        client.label_thread("thread-1", " ")

    assert service.thread_modify_calls == []
