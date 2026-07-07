"""Tests for the FastAPI dashboard API."""

import json
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import smokescreen.api as api_module
from smokescreen.api import app, init_app
from smokescreen.brokers.registry import BrokerRegistry
from smokescreen.config import Settings
from smokescreen.models import (
    Broker,
    BrokerStatus,
    NeedsManualReason,
    OptOutRecord,
    VerificationAddress,
    VerificationDocument,
    VerificationProfile,
)
from smokescreen.state.sqlite import SQLiteStore


def _make_brokers():
    return [
        Broker(
            id="spokeo",
            name="Spokeo",
            domain="spokeo.com",
            privacy_email="privacy@spokeo.com",
        ),
        Broker(
            id="beenverified",
            name="BeenVerified",
            domain="beenverified.com",
            privacy_email="privacy@beenverified.com",
        ),
    ]


@pytest.fixture
def client():
    with tempfile.NamedTemporaryFile(suffix=".db") as f:
        store = SQLiteStore(Path(f.name))
        registry = BrokerRegistry(_make_brokers())
        init_app(store, registry)
        yield TestClient(app)
        store.close()


@pytest.fixture
def seeded_client(client):
    """Client with some opt-out records pre-seeded."""
    from smokescreen.api import get_store

    store = get_store()
    store.upsert(OptOutRecord(broker_id="spokeo", status=BrokerStatus.INITIAL_SENT))
    store.upsert(OptOutRecord(broker_id="beenverified", status=BrokerStatus.COMPLETED))
    store.set_enabled_brokers(["spokeo", "beenverified"])
    return client


# --- Dashboard ---


def test_dashboard_returns_react_app(client, monkeypatch, tmp_path):
    web_dist = tmp_path / "web_dist"
    web_dist.mkdir()
    (web_dist / "index.html").write_text(
        "<!doctype html><title>Smokescreen React</title><div id='root'></div>",
        encoding="utf-8",
    )
    monkeypatch.setattr(api_module, "_web_dist_dir", web_dist)

    resp = client.get("/")
    assert resp.status_code == 200
    assert "Smokescreen React" in resp.text

    deep_link_resp = client.get("/needs-attention")
    assert deep_link_resp.status_code == 200
    assert "Smokescreen React" in deep_link_resp.text


def test_dashboard_requires_built_react_app(client, monkeypatch, tmp_path):
    monkeypatch.setattr(api_module, "_web_dist_dir", tmp_path / "missing")

    resp = client.get("/")
    assert resp.status_code == 503
    assert "React app has not been built" in resp.text


def test_react_app_redirect(client):
    resp = client.get("/app", follow_redirects=False)
    assert resp.status_code == 307
    assert resp.headers["location"] == "/"

    deep_link_resp = client.get("/app/needs-attention", follow_redirects=False)
    assert deep_link_resp.status_code == 307
    assert deep_link_resp.headers["location"] == "/needs-attention"


def test_old_dashboard_does_not_fall_through_to_react(client, monkeypatch, tmp_path):
    web_dist = tmp_path / "web_dist"
    web_dist.mkdir()
    (web_dist / "index.html").write_text(
        "<!doctype html><title>Smokescreen React</title><div id='root'></div>",
        encoding="utf-8",
    )
    monkeypatch.setattr(api_module, "_web_dist_dir", web_dist)

    resp = client.get("/old-dashboard")
    assert resp.status_code == 404
    assert "Smokescreen React" not in resp.text

    nested_resp = client.get("/old-dashboard/settings")
    assert nested_resp.status_code == 404
    assert "Smokescreen React" not in nested_resp.text


def test_unknown_api_path_does_not_fall_through_to_react(client, monkeypatch, tmp_path):
    web_dist = tmp_path / "web_dist"
    web_dist.mkdir()
    (web_dist / "index.html").write_text(
        "<!doctype html><title>Smokescreen React</title><div id='root'></div>",
        encoding="utf-8",
    )
    monkeypatch.setattr(api_module, "_web_dist_dir", web_dist)

    resp = client.get("/api/not-real")
    assert resp.status_code == 404


# --- Broker endpoints ---


def test_list_brokers(client):
    resp = client.get("/api/brokers")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 2
    ids = {b["id"] for b in data}
    assert ids == {"spokeo", "beenverified"}


def test_create_broker(client):
    resp = client.post(
        "/api/brokers",
        json={
            "id": "newbroker",
            "name": "New Broker",
            "domain": "newbroker.com",
            "privacy_email": "p@newbroker.com",
        },
    )
    assert resp.status_code == 201
    assert resp.json()["id"] == "newbroker"

    # Verify it's listed
    resp = client.get("/api/brokers")
    ids = {b["id"] for b in resp.json()}
    assert "newbroker" in ids


def test_create_broker_generates_id(client):
    resp = client.post(
        "/api/brokers",
        json={
            "name": "New Broker",
            "domain": "newbroker.com",
            "privacy_email": "p@newbroker.com",
        },
    )
    assert resp.status_code == 201
    assert resp.json()["id"] == "new-broker"


def test_create_duplicate_broker(client):
    resp = client.post(
        "/api/brokers",
        json={
            "id": "spokeo",
            "name": "Dup",
            "domain": "dup.com",
            "privacy_email": "p@dup.com",
        },
    )
    assert resp.status_code == 400


def test_update_broker(client):
    resp = client.put(
        "/api/brokers/spokeo",
        json={
            "name": "Spokeo Updated",
            "domain": "updated.spokeo.com",
            "aliases": ["alias.spokeo.com"],
        },
    )
    assert resp.status_code == 200
    assert resp.json()["name"] == "Spokeo Updated"
    assert resp.json()["domain"] == "updated.spokeo.com"

    from smokescreen.api import get_registry

    registry = get_registry()
    assert registry.get_by_domain("spokeo.com") is None
    assert registry.get_by_domain("updated.spokeo.com").id == "spokeo"
    assert registry.get_by_domain("alias.spokeo.com").id == "spokeo"


def test_update_broker_not_found(client):
    resp = client.put("/api/brokers/nonexistent", json={"name": "X"})
    assert resp.status_code == 404


def test_delete_broker(client):
    resp = client.delete("/api/brokers/spokeo")
    assert resp.status_code == 204

    resp = client.get("/api/brokers")
    ids = {b["id"] for b in resp.json()}
    assert "spokeo" not in ids

    from smokescreen.api import get_registry

    assert get_registry().get_by_domain("spokeo.com") is None


# --- Opt-out endpoints ---


def test_list_optouts_empty(client):
    resp = client.get("/api/optouts")
    assert resp.status_code == 200
    assert resp.json() == []


def test_list_optouts(seeded_client):
    resp = seeded_client.get("/api/optouts")
    assert resp.status_code == 200
    assert len(resp.json()) == 2


def test_list_optouts_excludes_disabled_brokers_by_default(client):
    from smokescreen.api import get_store

    store = get_store()
    store.upsert(OptOutRecord(broker_id="spokeo", status=BrokerStatus.INITIAL_SENT))
    store.upsert(OptOutRecord(broker_id="beenverified", status=BrokerStatus.COMPLETED))
    store.set_enabled_brokers(["spokeo"])

    resp = client.get("/api/optouts")

    assert resp.status_code == 200
    assert [record["broker_id"] for record in resp.json()] == ["spokeo"]


def test_list_optouts_includes_disabled_when_flag_set(client):
    from smokescreen.api import get_store

    store = get_store()
    store.upsert(OptOutRecord(broker_id="spokeo", status=BrokerStatus.INITIAL_SENT))
    store.upsert(OptOutRecord(broker_id="beenverified", status=BrokerStatus.COMPLETED))
    store.set_enabled_brokers(["spokeo"])

    resp = client.get("/api/optouts?include_disabled=true")

    assert resp.status_code == 200
    assert {record["broker_id"] for record in resp.json()} == {
        "spokeo",
        "beenverified",
    }


def test_list_optouts_by_status(seeded_client):
    resp = seeded_client.get("/api/optouts?status=COMPLETED")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["broker_id"] == "beenverified"


def test_list_optouts_by_needs_attention_group(client):
    from smokescreen.api import get_store

    store = get_store()
    store.upsert(OptOutRecord(broker_id="spokeo", status=BrokerStatus.NEEDS_MANUAL))
    store.upsert(OptOutRecord(broker_id="beenverified", status=BrokerStatus.FAILED))
    store.upsert(OptOutRecord(broker_id="whitepages", status=BrokerStatus.REJECTED))
    store.upsert(OptOutRecord(broker_id="radaris", status=BrokerStatus.COMPLETED))
    store.set_enabled_brokers(["spokeo", "beenverified", "whitepages", "radaris"])

    resp = client.get("/api/optouts?status=needs_attention")
    assert resp.status_code == 200
    data = resp.json()
    assert {record["broker_id"] for record in data} == {
        "spokeo",
        "beenverified",
    }
    assert {record["status"] for record in data} == {
        "NEEDS_MANUAL",
        "FAILED",
    }


def test_list_optouts_includes_needs_manual_reason(client):
    from smokescreen.api import get_store

    store = get_store()
    store.upsert(
        OptOutRecord(
            broker_id="spokeo",
            status=BrokerStatus.NEEDS_MANUAL,
            needs_manual_reason=NeedsManualReason(
                reason_code="info_request_missing_fields",
                short_summary="Broker requested a missing phone number.",
                broker_reply_excerpt="Please send your phone number.",
                classifier_output={
                    "classification": "INFO_REQUEST",
                    "requested_fields": ["phone_number"],
                    "other_details": "",
                },
                missing_fields=["phone_number"],
            ),
        )
    )
    store.set_enabled_brokers(["spokeo"])

    resp = client.get("/api/optouts")

    assert resp.status_code == 200
    data = resp.json()
    assert data[0]["needs_manual_reason"]["reason_code"] == (
        "info_request_missing_fields"
    )
    assert data[0]["needs_manual_reason"]["missing_fields"] == ["phone_number"]
    assert data[0]["needs_manual_reason"]["classifier_output"] == {
        "classification": "INFO_REQUEST",
        "requested_fields": ["phone_number"],
        "other_details": "",
    }
    assert data[0]["state_history"] == []


def test_list_optouts_needs_attention_excludes_disabled_brokers(client):
    from smokescreen.api import get_store

    store = get_store()
    store.upsert(OptOutRecord(broker_id="spokeo", status=BrokerStatus.NEEDS_MANUAL))
    store.upsert(OptOutRecord(broker_id="beenverified", status=BrokerStatus.FAILED))
    store.set_enabled_brokers(["spokeo"])

    resp = client.get("/api/optouts?status=needs_attention")

    assert resp.status_code == 200
    assert [record["broker_id"] for record in resp.json()] == ["spokeo"]


def test_list_optouts_invalid_status(client):
    resp = client.get("/api/optouts?status=INVALID")
    assert resp.status_code == 400


def test_reset_optout(seeded_client):
    from smokescreen.api import get_store

    resp = seeded_client.post("/api/optouts/spokeo/reset")
    assert resp.status_code == 200
    assert resp.json()["status"] == "reset"
    saved = get_store().get("spokeo")
    assert saved is not None
    assert saved.status == BrokerStatus.PENDING
    assert len(saved.state_history) == 1
    transition = saved.state_history[0]
    assert transition.from_status == "INITIAL_SENT"
    assert transition.to_status == "PENDING"
    assert transition.reason == "manual reset"


def test_reset_disabled_broker_returns_400(client):
    from smokescreen.api import get_store

    store = get_store()
    store.upsert(OptOutRecord(broker_id="spokeo", status=BrokerStatus.COMPLETED))
    store.set_enabled_brokers([])

    resp = client.post("/api/optouts/spokeo/reset")

    assert resp.status_code == 400
    assert resp.json()["detail"] == {
        "code": "broker_disabled",
        "message": "This broker is disabled. Enable it in Settings before resetting.",
    }
    saved = store.get("spokeo")
    assert saved is not None
    assert saved.status == BrokerStatus.COMPLETED


def test_reset_optout_not_found(client):
    resp = client.post("/api/optouts/nonexistent/reset")
    assert resp.status_code == 404


def test_retry_classification_restores_previous_status(client):
    from smokescreen.api import get_store

    store = get_store()
    store.upsert(
        OptOutRecord(
            broker_id="spokeo",
            status=BrokerStatus.NEEDS_MANUAL,
            previous_status=BrokerStatus.INFO_REQUESTED,
            thread_id="thread-123",
            last_message_id="message-123",
            notes="Missing phone number",
            needs_manual_reason=NeedsManualReason(
                reason_code="info_request_missing_fields",
                short_summary="Broker requested a missing phone number.",
            ),
            retries=3,
        )
    )

    resp = client.post("/api/optouts/spokeo/retry_classification")

    assert resp.status_code == 200
    data = resp.json()
    assert data["broker_id"] == "spokeo"
    assert data["status"] == "INFO_REQUESTED"
    assert data["previous_status"] is None
    assert data["thread_id"] == "thread-123"
    assert data["last_message_id"] is None
    assert data["notes"] == ""
    assert data["needs_manual_reason"] is None
    assert data["retries"] == 0
    saved = store.get("spokeo")
    assert saved is not None
    assert saved.status == BrokerStatus.INFO_REQUESTED
    assert saved.previous_status is None
    assert saved.thread_id == "thread-123"
    assert saved.last_message_id is None
    assert saved.notes == ""
    assert saved.needs_manual_reason is None
    assert saved.retries == 0
    assert len(saved.state_history) == 1
    transition = saved.state_history[0]
    assert transition.from_status == "NEEDS_MANUAL"
    assert transition.to_status == "INFO_REQUESTED"
    assert transition.reason == "retry manual classification"


def test_retry_classification_requires_needs_manual_status(client):
    from smokescreen.api import get_store

    store = get_store()
    store.upsert(
        OptOutRecord(
            broker_id="spokeo",
            status=BrokerStatus.INFO_REQUESTED,
            thread_id="thread-123",
        )
    )

    resp = client.post("/api/optouts/spokeo/retry_classification")

    assert resp.status_code == 400
    assert resp.json()["detail"] == "Broker spokeo does not need manual review"
    saved = store.get("spokeo")
    assert saved is not None
    assert saved.status == BrokerStatus.INFO_REQUESTED


def test_retry_classification_requires_thread_id(client):
    from smokescreen.api import get_store

    store = get_store()
    store.upsert(
        OptOutRecord(
            broker_id="spokeo",
            status=BrokerStatus.NEEDS_MANUAL,
            previous_status=BrokerStatus.INFO_REQUESTED,
            last_message_id="message-123",
        )
    )

    resp = client.post("/api/optouts/spokeo/retry_classification")

    assert resp.status_code == 400
    assert (
        resp.json()["detail"]
        == "Cannot retry: broker record has no thread. Use Reset to start over."
    )
    saved = store.get("spokeo")
    assert saved is not None
    assert saved.status == BrokerStatus.NEEDS_MANUAL
    assert saved.last_message_id == "message-123"


def test_retry_classification_defaults_to_initial_sent_when_no_previous_status(client):
    from smokescreen.api import get_store

    store = get_store()
    store.upsert(
        OptOutRecord(
            broker_id="spokeo",
            status=BrokerStatus.NEEDS_MANUAL,
            thread_id="thread-123",
            last_message_id="message-123",
            notes="Old manual record",
            retries=2,
        )
    )

    resp = client.post("/api/optouts/spokeo/retry_classification")

    assert resp.status_code == 200
    assert resp.json()["status"] == "INITIAL_SENT"
    saved = store.get("spokeo")
    assert saved is not None
    assert saved.status == BrokerStatus.INITIAL_SENT
    assert saved.previous_status is None
    assert saved.last_message_id is None


def test_retry_classification_not_found_returns_400(client):
    resp = client.post("/api/optouts/nonexistent/retry_classification")

    assert resp.status_code == 400
    assert resp.json()["detail"] == "No record for broker nonexistent"


def test_rescan_endpoint_clears_last_message_id(client):
    from smokescreen.api import get_store

    store = get_store()
    store.upsert(
        OptOutRecord(
            broker_id="spokeo",
            status=BrokerStatus.FOLLOW_UP_SENT,
            thread_id="thread-123",
            last_message_id="message-123",
        )
    )

    resp = client.post("/api/optouts/spokeo/rescan")

    assert resp.status_code == 200
    assert resp.json()["last_message_id"] is None
    saved = store.get("spokeo")
    assert saved is not None
    assert saved.last_message_id is None


def test_rescan_endpoint_preserves_status_and_thread_id(client):
    from smokescreen.api import get_store

    store = get_store()
    store.upsert(
        OptOutRecord(
            broker_id="spokeo",
            status=BrokerStatus.INFO_REQUESTED,
            previous_status=BrokerStatus.AWAITING_RESPONSE,
            thread_id="thread-123",
            last_message_id="message-123",
            notes="Broker requested date of birth",
            requested_fields=["date_of_birth"],
            missing_fields=["date_of_birth"],
            requested_other_details="DOB required",
            retries=2,
        )
    )

    resp = client.post("/api/optouts/spokeo/rescan")

    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "INFO_REQUESTED"
    assert data["previous_status"] == "AWAITING_RESPONSE"
    assert data["thread_id"] == "thread-123"
    assert data["notes"] == "Broker requested date of birth"
    assert data["requested_fields"] == ["date_of_birth"]
    assert data["missing_fields"] == ["date_of_birth"]
    assert data["requested_other_details"] == "DOB required"
    assert data["retries"] == 2
    saved = store.get("spokeo")
    assert saved is not None
    assert saved.status == BrokerStatus.INFO_REQUESTED
    assert saved.previous_status == BrokerStatus.AWAITING_RESPONSE
    assert saved.thread_id == "thread-123"


def test_rescan_endpoint_appends_state_history_entry(client):
    from smokescreen.api import get_store

    store = get_store()
    store.upsert(
        OptOutRecord(
            broker_id="spokeo",
            status=BrokerStatus.COMPLETED,
            thread_id="thread-123",
            last_message_id="message-123",
        )
    )

    resp = client.post("/api/optouts/spokeo/rescan")

    assert resp.status_code == 200
    saved = store.get("spokeo")
    assert saved is not None
    assert len(saved.state_history) == 1
    transition = saved.state_history[0]
    assert transition.from_status == "COMPLETED"
    assert transition.to_status == "COMPLETED"
    assert transition.reason == "manual rescan requested"
    assert transition.message_id == "message-123"
    data = resp.json()
    assert data["state_history"][0]["reason"] == "manual rescan requested"


def test_rescan_endpoint_400_without_thread_id(client):
    from smokescreen.api import get_store

    store = get_store()
    store.upsert(
        OptOutRecord(
            broker_id="spokeo",
            status=BrokerStatus.AWAITING_RESPONSE,
            last_message_id="message-123",
        )
    )

    resp = client.post("/api/optouts/spokeo/rescan")

    assert resp.status_code == 400
    assert resp.json()["detail"] == "Cannot rescan: broker record has no thread."
    saved = store.get("spokeo")
    assert saved is not None
    assert saved.last_message_id == "message-123"
    assert saved.state_history == []


@pytest.mark.parametrize(
    "status",
    [
        BrokerStatus.INITIAL_SENT,
        BrokerStatus.AWAITING_RESPONSE,
        BrokerStatus.INFO_REQUESTED,
        BrokerStatus.FOLLOW_UP_SENT,
        BrokerStatus.NEEDS_MANUAL,
        BrokerStatus.COMPLETED,
        BrokerStatus.REJECTED,
    ],
)
def test_rescan_endpoint_works_on_any_state(client, status):
    from smokescreen.api import get_store

    store = get_store()
    store.upsert(
        OptOutRecord(
            broker_id="spokeo",
            status=status,
            thread_id=f"thread-{status.value.lower()}",
            last_message_id=f"message-{status.value.lower()}",
        )
    )

    resp = client.post("/api/optouts/spokeo/rescan")

    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == status.value
    assert data["thread_id"] == f"thread-{status.value.lower()}"
    assert data["last_message_id"] is None
    assert data["state_history"][-1]["reason"] == "manual rescan requested"


def test_accept_rejection_requires_broker_rejected_reason(client):
    from smokescreen.api import get_store

    store = get_store()
    store.upsert(
        OptOutRecord(
            broker_id="spokeo",
            status=BrokerStatus.NEEDS_MANUAL,
            needs_manual_reason=NeedsManualReason(
                reason_code="classifier_returned_needs_manual",
                short_summary="Classifier needs review.",
            ),
        )
    )

    resp = client.post("/api/optouts/spokeo/accept_rejection")

    assert resp.status_code == 400
    assert (
        resp.json()["detail"]
        == "Broker spokeo is not awaiting broker rejection review"
    )
    saved = store.get("spokeo")
    assert saved is not None
    assert saved.status == BrokerStatus.NEEDS_MANUAL
    assert saved.needs_manual_reason is not None


def test_accept_rejection_transitions_to_terminal_rejected(client):
    from smokescreen.api import get_store

    store = get_store()
    store.set_enabled_brokers(["spokeo"])
    store.upsert(
        OptOutRecord(
            broker_id="spokeo",
            status=BrokerStatus.NEEDS_MANUAL,
            previous_status=BrokerStatus.AWAITING_RESPONSE,
            thread_id="thread-123",
            last_message_id="message-123",
            needs_manual_reason=NeedsManualReason(
                reason_code="broker_rejected",
                short_summary="Broker rejected the deletion request.",
                broker_reply_excerpt="We cannot process this request.",
            ),
        )
    )

    resp = client.post("/api/optouts/spokeo/accept_rejection")

    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "REJECTED"
    assert data["previous_status"] is None
    assert data["needs_manual_reason"] is None
    saved = store.get("spokeo")
    assert saved is not None
    assert saved.status == BrokerStatus.REJECTED
    assert saved.previous_status is None
    assert saved.needs_manual_reason is None
    assert len(saved.state_history) == 1
    transition = saved.state_history[0]
    assert transition.from_status == "NEEDS_MANUAL"
    assert transition.to_status == "REJECTED"
    assert transition.reason == "broker rejection accepted"

    attention_resp = client.get("/api/optouts?status=needs_attention")
    assert attention_resp.status_code == 200
    assert attention_resp.json() == []


def test_escalate_rejection_requires_context(client):
    from smokescreen.api import get_store

    store = get_store()
    store.upsert(
        OptOutRecord(
            broker_id="spokeo",
            status=BrokerStatus.NEEDS_MANUAL,
            thread_id="thread-123",
            needs_manual_reason=NeedsManualReason(
                reason_code="broker_rejected",
                short_summary="Broker rejected the deletion request.",
                broker_reply_excerpt="We cannot process this request.",
            ),
        )
    )

    resp = client.post(
        "/api/optouts/spokeo/escalate_rejection",
        json={"context": "   "},
    )

    assert resp.status_code == 400
    assert resp.json()["detail"] == "Escalation context is required"
    saved = store.get("spokeo")
    assert saved is not None
    assert saved.status == BrokerStatus.NEEDS_MANUAL


def test_escalate_rejection_composes_with_user_context(monkeypatch):
    from smokescreen.ai.response_composer import ResponseSkeleton
    from smokescreen.api import get_store

    with tempfile.NamedTemporaryFile(suffix=".db") as f:
        settings = Settings(
            sqlite_path=Path(f.name),
            sender_email="me@example.com",
            sender_name="Test User",
            ai_provider="anthropic",
            anthropic_api_key="test-key",
            dry_run=True,
        )
        store = SQLiteStore(settings.sqlite_path)
        registry = BrokerRegistry(_make_brokers())
        init_app(store, registry, settings)
        test_client = TestClient(app)
        store.upsert(
            OptOutRecord(
                broker_id="spokeo",
                status=BrokerStatus.NEEDS_MANUAL,
                previous_status=BrokerStatus.AWAITING_RESPONSE,
                thread_id="thread-123",
                last_message_id="message-123",
                notes="Subject: Request rejected\n\nBroker says no.",
                needs_manual_reason=NeedsManualReason(
                    reason_code="broker_rejected",
                    short_summary="Broker rejected the deletion request.",
                    broker_reply_excerpt="Broker says no.",
                    classifier_output={
                        "classification": "REJECTED",
                        "other_details": "They claimed the request is invalid.",
                    },
                ),
            )
        )
        captured: dict[str, object] = {}

        def fake_compose_response_skeleton(**kwargs):
            captured.update(kwargs)
            return ResponseSkeleton(
                subject="Re: {{ broker_subject }}",
                body=(
                    "Dear {{ broker_name }} Privacy Team,\n\n"
                    "Please reconsider under CCPA.\n\n"
                    "Sincerely,\n{{ sender_name }}"
                ),
                notes="uses user context",
            )

        monkeypatch.setattr(
            "smokescreen.jobs.poll._build_classifier_client",
            lambda settings: object(),
        )
        monkeypatch.setattr(
            "smokescreen.jobs.poll.compose_response_skeleton",
            fake_compose_response_skeleton,
        )

        resp = test_client.post(
            "/api/optouts/spokeo/escalate_rejection",
            json={"context": "Listing belongs to a minor household member."},
        )

        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "REJECTED_REBUTTED"
        assert data["needs_manual_reason"] is None
        assert captured["target_action"].value == "REJECTION_REBUTTAL"
        assert captured["user_context"] == (
            "Listing belongs to a minor household member."
        )
        assert captured["broker_body"] == "Broker says no."
        saved = get_store().get("spokeo")
        assert saved is not None
        assert saved.status == BrokerStatus.REJECTED_REBUTTED
        assert saved.needs_manual_reason is None
        assert len(saved.state_history) == 1
        transition = saved.state_history[0]
        assert transition.from_status == "NEEDS_MANUAL"
        assert transition.to_status == "REJECTED_REBUTTED"
        assert transition.reason == "sent broker rejection rebuttal"
        store.close()


@pytest.mark.parametrize(
    "status",
    [BrokerStatus.NEEDS_MANUAL, BrokerStatus.FAILED],
)
def test_mark_optout_handled_from_attention_states(client, status):
    from smokescreen.api import get_store

    store = get_store()
    broker_id = f"attention-{status.value.lower()}"
    store.upsert(
        OptOutRecord(
            broker_id=broker_id,
            status=status,
            notes="Broker asked for manual review.",
            thread_id="thread-123",
            last_message_id="message-123",
        )
    )

    resp = client.post(f"/api/optouts/{broker_id}/handled")

    assert resp.status_code == 200
    assert resp.json() == {"status": "handled", "broker_id": broker_id}
    saved = store.get(broker_id)
    assert saved is not None
    assert saved.status == BrokerStatus.COMPLETED
    assert saved.notes == "Broker asked for manual review."
    assert saved.thread_id == "thread-123"
    assert saved.last_message_id == "message-123"
    assert saved.last_completed_at is not None
    assert len(saved.state_history) == 1
    transition = saved.state_history[0]
    assert transition.from_status == status.value
    assert transition.to_status == "COMPLETED"
    assert transition.reason == "marked handled manually"
    needs_attention = client.get("/api/optouts?status=needs_attention")
    assert needs_attention.status_code == 200
    assert needs_attention.json() == []


def test_mark_optout_handled_rejects_non_attention_state(seeded_client):
    resp = seeded_client.post("/api/optouts/beenverified/handled")

    assert resp.status_code == 400
    assert "does not need attention" in resp.json()["detail"]


def test_mark_optout_handled_not_found(client):
    resp = client.post("/api/optouts/nonexistent/handled")

    assert resp.status_code == 404


# --- Outreach ---


def test_run_outreach_omitted_broker_ids_processes_enabled_dry_run(settings_client):
    """With broker_ids omitted, only the persisted enabled subset is processed."""
    client, _ = settings_client
    client.put("/api/settings", json={"dry_run": True})
    client.put(
        "/api/brokers/selections",
        json={"enabled_broker_ids": ["spokeo", "beenverified"]},
    )

    resp = client.post("/api/outreach", json={})

    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "sent"
    assert data["processed"] == ["spokeo", "beenverified"]
    assert data["processed_count"] == 2
    assert data["dry_run"] is True
    optouts_resp = client.get("/api/optouts")
    assert optouts_resp.status_code == 200
    records = {record["broker_id"]: record for record in optouts_resp.json()}
    assert set(records) == {"spokeo", "beenverified"}
    for broker_id, record in records.items():
        assert record["status"] == "INITIAL_SENT"
        assert record["thread_id"] == f"dry-run-thread-{broker_id}"
        assert record["last_message_id"] == f"dry-run-message-{broker_id}"


def test_run_outreach_omitted_broker_ids_is_gated_when_no_selection(settings_client):
    """No selection means no outreach, even with broker_ids omitted."""
    client, _ = settings_client
    client.put("/api/settings", json={"dry_run": True})

    resp = client.post("/api/outreach", json={})

    assert resp.status_code == 200
    data = resp.json()
    assert data["processed"] == []
    assert data["processed_count"] == 0


def test_run_outreach_explicit_broker_ids_bypass_gate_dry_run(settings_client):
    """Explicit broker_ids (onboarding first-batch flow) bypass the enable gate."""
    client, _ = settings_client
    client.put("/api/settings", json={"dry_run": True})

    # No selections set — the explicit list still runs.
    resp = client.post("/api/outreach", json={"broker_ids": ["spokeo"]})

    assert resp.status_code == 200
    data = resp.json()
    assert data["processed"] == ["spokeo"]
    assert data["processed_count"] == 1


def test_run_outreach_empty_broker_ids_is_noop_dry_run(settings_client):
    client, _ = settings_client
    client.put("/api/settings", json={"dry_run": True})

    resp = client.post("/api/outreach", json={"broker_ids": []})

    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "sent"
    assert data["processed"] == []
    assert data["processed_count"] == 0
    assert data["dry_run"] is True
    assert client.get("/api/optouts").json() == []


def test_run_outreach_selected_brokers_dry_run(settings_client):
    client, _ = settings_client
    client.put("/api/settings", json={"dry_run": True})
    client.put("/api/brokers/selections", json={"enabled_broker_ids": ["spokeo"]})

    resp = client.post("/api/outreach", json={"broker_ids": ["spokeo"]})

    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "sent"
    assert data["processed"] == ["spokeo"]
    assert data["processed_count"] == 1
    assert data["dry_run"] is True
    optouts_resp = client.get("/api/optouts")
    assert optouts_resp.status_code == 200
    records = {record["broker_id"]: record for record in optouts_resp.json()}
    assert set(records) == {"spokeo"}
    assert records["spokeo"]["status"] == "INITIAL_SENT"
    assert records["spokeo"]["thread_id"] == "dry-run-thread-spokeo"
    assert records["spokeo"]["last_message_id"] == "dry-run-message-spokeo"


def test_run_outreach_rejects_unknown_broker(settings_client):
    client, _ = settings_client
    client.put("/api/settings", json={"dry_run": True})

    resp = client.post("/api/outreach", json={"broker_ids": ["missing"]})

    assert resp.status_code == 404
    assert "Broker missing not found" in resp.text


def test_run_outreach_without_gmail_credentials_returns_actionable_error(
    settings_client, tmp_path
):
    client, _ = settings_client
    import smokescreen.api as api_module

    api_module._settings = Settings(
        sender_email="test@example.com",
        sender_name="Test User",
        anthropic_api_key="sk-test",
        dry_run=False,
        gmail_oauth_interactive=False,
        gmail_credentials_path=tmp_path / "missing-credentials.json",
        gmail_token_path=tmp_path / "missing-token.json",
    )

    resp = client.post("/api/outreach", json={"broker_ids": ["spokeo"]})

    assert resp.status_code == 400
    assert resp.json()["detail"] == {
        "code": "gmail_credentials_required",
        "message": (
            "Connect Gmail before sending outreach, or enable dry run to prepare "
            "the batch without sending email."
        ),
    }


# --- Stats ---


def test_stats(seeded_client):
    resp = seeded_client.get("/api/stats")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 2
    assert data["completion_pct"] == 50.0
    assert data["by_status"]["COMPLETED"] == 1


def test_stats_empty(client):
    resp = client.get("/api/stats")
    assert resp.status_code == 200
    assert resp.json()["total"] == 0
    assert resp.json()["completion_pct"] == 0.0


# --- Whitelist endpoints ---


def test_list_whitelist(client):
    resp = client.get("/api/whitelist")
    assert resp.status_code == 200
    # Should have registry entries from init_app sync
    data = resp.json()
    emails = {e["email"] for e in data}
    assert "privacy@spokeo.com" in emails
    assert "privacy@beenverified.com" in emails


def test_add_whitelist(client):
    resp = client.post(
        "/api/whitelist",
        json={"broker_id": "spokeo", "email": "new@spokeo.com"},
    )
    assert resp.status_code == 201
    assert resp.json()["email"] == "new@spokeo.com"


def test_delete_whitelist(client):
    resp = client.post(
        "/api/whitelist",
        json={"broker_id": "test", "email": "delete-me@test.com"},
    )
    entry_id = resp.json()["id"]
    resp = client.delete(f"/api/whitelist/{entry_id}")
    assert resp.status_code == 204


# --- Pending whitelist endpoints ---


def test_pending_whitelist_empty(client):
    resp = client.get("/api/whitelist/pending")
    assert resp.status_code == 200
    assert resp.json() == []


def test_approve_pending(client):
    from smokescreen.api import get_store
    from smokescreen.models import PendingWhitelistEntry

    store = get_store()
    entry = store.add_pending_whitelist(
        PendingWhitelistEntry(
            broker_id="spokeo",
            email="verify@spokeo.com",
            message_subject="Verify identity",
        )
    )

    resp = client.post(f"/api/whitelist/pending/{entry.id}/approve")
    assert resp.status_code == 200
    assert resp.json()["email"] == "verify@spokeo.com"

    # Should now be whitelisted
    resp = client.get("/api/whitelist")
    emails = {e["email"] for e in resp.json()}
    assert "verify@spokeo.com" in emails


def test_reject_pending(client):
    from smokescreen.api import get_store
    from smokescreen.models import PendingWhitelistEntry

    store = get_store()
    entry = store.add_pending_whitelist(PendingWhitelistEntry(email="spam@test.com"))

    resp = client.post(f"/api/whitelist/pending/{entry.id}/reject")
    assert resp.status_code == 200
    assert resp.json()["status"] == "rejected"


def test_approve_pending_not_found(client):
    resp = client.post("/api/whitelist/pending/999/approve")
    assert resp.status_code == 404


def test_reject_pending_not_found(client):
    resp = client.post("/api/whitelist/pending/999/reject")
    assert resp.status_code == 404


# --- Broker selections endpoints ---


def test_get_broker_selections_defaults_to_empty(client):
    resp = client.get("/api/brokers/selections")
    assert resp.status_code == 200
    data = resp.json()
    assert data["enabled_broker_ids"] == []
    assert data["selection_document_size_bytes"] > 0
    assert data["selection_size_warning"] is None


def test_get_broker_selections_seeds_defaults_on_first_read(tmp_path):
    store = SQLiteStore(tmp_path / "test.db")
    registry = BrokerRegistry(
        _make_brokers(),
        default_enabled_broker_ids=["spokeo"],
    )
    init_app(store, registry)
    client = TestClient(app)

    resp = client.get("/api/brokers/selections")

    assert resp.status_code == 200
    assert resp.json()["enabled_broker_ids"] == ["spokeo"]
    assert store.list_enabled_brokers() == ["spokeo"]
    assert store.has_enabled_broker_selections() is True
    store.close()


def test_put_broker_selections_persists_normalized_list(client):
    resp = client.put(
        "/api/brokers/selections",
        json={"enabled_broker_ids": ["spokeo", "spokeo", "beenverified"]},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["enabled_broker_ids"] == ["beenverified", "spokeo"]
    assert data["selection_document_size_bytes"] > 0
    assert data["selection_size_warning"] is None

    # Subsequent GET returns the same normalized list.
    get_resp = client.get("/api/brokers/selections")
    assert get_resp.json()["enabled_broker_ids"] == ["beenverified", "spokeo"]


def test_put_broker_selections_rejects_unknown_broker(client):
    resp = client.put(
        "/api/brokers/selections",
        json={"enabled_broker_ids": ["spokeo", "not-a-real-broker"]},
    )
    assert resp.status_code == 400
    assert "not-a-real-broker" in resp.json()["detail"]

    # The rejection must not partially apply.
    get_resp = client.get("/api/brokers/selections")
    assert get_resp.json()["enabled_broker_ids"] == []


def test_put_broker_selections_accepts_empty_list(client):
    client.put(
        "/api/brokers/selections",
        json={"enabled_broker_ids": ["spokeo"]},
    )
    resp = client.put(
        "/api/brokers/selections",
        json={"enabled_broker_ids": []},
    )
    assert resp.status_code == 200
    assert resp.json()["enabled_broker_ids"] == []


# --- Settings endpoints ---


@pytest.fixture
def settings_client(tmp_path):
    """Client with settings initialized and a temp settings file."""
    import os

    db_path = tmp_path / "test.db"
    settings_file = tmp_path / "settings.json"
    # Point settings file to our temp location
    os.environ["SMOKESCREEN_SETTINGS_FILE"] = str(settings_file)
    store = SQLiteStore(db_path)
    registry = BrokerRegistry(_make_brokers())
    settings = Settings(
        sender_email="test@example.com",
        sender_name="Test User",
        gmail_credentials_path=tmp_path / "credentials.json",
        gmail_token_path=tmp_path / "token.json",
    )
    init_app(store, registry, settings)
    yield TestClient(app), settings_file
    store.close()
    os.environ.pop("SMOKESCREEN_SETTINGS_FILE", None)


def test_get_settings(settings_client):
    client, _ = settings_client
    resp = client.get("/api/settings")
    assert resp.status_code == 200
    data = resp.json()
    assert data["sender_email"] == "test@example.com"
    assert data["sender_name"] == "Test User"
    assert data["identity_configured"] is True
    assert data["gmail_token_available"] is False
    assert data["gmail_credentials_available"] is False
    assert data["gmail_connected"] is False
    assert data["gmail_connected_email"] == ""
    # rerequest_interval_days is now a friendly setting (sm-274); the default
    # changed to 30 days / monthly (sm-aa1).
    assert data["rerequest_interval_days"] == 30
    assert data["rerequest_interval_days_from_env"] is False
    assert data["state_timeout_days"] == 14
    assert data["state_timeout_days_from_env"] is False
    assert "identity_bucket_configured" not in data
    assert "identity_documents" not in data
    assert "identity_bucket" not in data
    assert "identity_docs_dir" not in data
    assert "state_backend" not in data
    assert "sqlite_path" not in data
    assert "firestore_project" not in data
    assert "firestore_collection" not in data
    assert "gmail_credentials_path" not in data
    assert "gmail_token_path" not in data
    assert "max_retries" not in data
    assert "dry_run" not in data


def test_get_settings_reports_gmail_connected_only_when_token_available(
    settings_client,
):
    client, _ = settings_client
    import smokescreen.api as api_module

    new_settings = Settings(
        sender_email="test@example.com",
        sender_name="Test User",
        gmail_token_json="token-secret-value",
    )
    api_module._settings = new_settings

    resp = client.get("/api/settings")
    assert resp.status_code == 200
    data = resp.json()
    assert data["identity_configured"] is True
    assert data["gmail_token_available"] is True
    assert data["gmail_connected"] is True
    assert data["gmail_connected_email"] == "test@example.com"


def test_verification_profile_endpoint_round_trip(settings_client):
    client, _ = settings_client

    empty_resp = client.get("/api/settings/verification-profile")
    assert empty_resp.status_code == 200
    assert empty_resp.json() == VerificationProfile().model_dump()

    profile = VerificationProfile(
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
        email_aliases=["old@example.com"],
        documents=[
            VerificationDocument(
                label="Utility Bill",
                storage_note="Offline file cabinet",
            )
        ],
        date_of_birth="1990-01-01",
        last_four_ssn="1234",
        employer_name="Acme",
    )
    put_resp = client.put(
        "/api/settings/verification-profile",
        json=profile.model_dump(),
    )
    assert put_resp.status_code == 200
    assert put_resp.json() == profile.model_dump()

    get_resp = client.get("/api/settings/verification-profile")
    assert get_resp.status_code == 200
    assert get_resp.json() == profile.model_dump()


def test_get_advanced_settings(settings_client):
    client, _ = settings_client
    resp = client.get("/api/settings/advanced")
    assert resp.status_code == 200
    data = resp.json()
    assert data["poll_label"] == "smokescreen"
    assert data["max_retries"] == 5
    assert data["dry_run"] is False
    assert data["ai_provider"] == "gemini"
    assert data["anthropic_model"] == "claude-sonnet-4-20250514"
    assert data["gemini_model"] == "gemini-3.1-flash-lite"
    assert data["gemini_project"] == ""
    assert data["gemini_location"] == "global"
    # rerequest_interval_days moved to the friendly settings surface (sm-274)
    assert "rerequest_interval_days" not in data
    assert "sender_email" not in data
    assert "sender_name" not in data
    assert "state_backend" not in data
    assert "sqlite_path" not in data
    assert "firestore_project" not in data
    assert "firestore_collection" not in data
    assert "gmail_credentials_path" not in data
    assert "gmail_token_path" not in data


def test_get_advanced_settings_masks_gmail_secrets(settings_client):
    client, _ = settings_client
    import smokescreen.api as api_module

    new_settings = Settings(
        sender_email="test@example.com",
        sender_name="Test User",
        gmail_credentials_json="credentials-secret-value",
        gmail_token_json="token-secret-value",
    )
    api_module._settings = new_settings

    resp = client.get("/api/settings/advanced")
    data = resp.json()
    assert "gmail_credentials_json" not in data
    assert "gmail_token_json" not in data


def test_get_settings_masks_api_key(settings_client):
    client, _ = settings_client
    import smokescreen.api as api_module

    # Create new settings with an API key
    new_settings = Settings(
        sender_email="test@example.com",
        sender_name="Test User",
        anthropic_api_key="sk-ant-secret-key-12345",
    )
    api_module._settings = new_settings

    resp = client.get("/api/settings")
    data = resp.json()
    assert data["anthropic_api_key"] == "sk-a****345"
    assert "secret" not in data["anthropic_api_key"]


def test_get_settings_no_settings_initialized(client):
    """GET /api/settings when no settings were passed to init_app."""
    import smokescreen.api as api_module

    saved = api_module._settings
    api_module._settings = None
    with pytest.raises(RuntimeError, match="Settings not initialized"):
        client.get("/api/settings")
    api_module._settings = saved


def test_put_settings_saves_to_file(settings_client):
    client, settings_file = settings_client
    resp = client.put(
        "/api/settings",
        json={"max_retries": 10, "poll_label": "custom-label"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "saved"
    assert data["restart_required"] is False

    # Verify file was written
    assert settings_file.exists()
    file_data = json.loads(settings_file.read_text())
    assert file_data["max_retries"] == 10
    assert file_data["poll_label"] == "custom-label"


def test_put_settings_rerequest_interval_days_round_trips(settings_client):
    """Friendly PUT flow persists rerequest_interval_days and surfaces it on GET."""
    client, settings_file = settings_client

    resp = client.put("/api/settings", json={"rerequest_interval_days": 90})
    assert resp.status_code == 200
    assert resp.json() == {"status": "saved", "restart_required": False}

    file_data = json.loads(settings_file.read_text())
    assert file_data["rerequest_interval_days"] == 90

    get_resp = client.get("/api/settings")
    assert get_resp.status_code == 200
    assert get_resp.json()["rerequest_interval_days"] == 90


@pytest.mark.parametrize("value", [7, 60, 365])
def test_put_settings_rerequest_interval_days_accepts_boundary_values(
    settings_client, value
):
    client, _ = settings_client
    resp = client.put("/api/settings", json={"rerequest_interval_days": value})
    assert resp.status_code == 200
    assert client.get("/api/settings").json()["rerequest_interval_days"] == value


@pytest.mark.parametrize("value", [0, 1, 6, 366, 1000, -1])
def test_put_settings_rerequest_interval_days_rejects_out_of_bounds(
    settings_client, value
):
    client, settings_file = settings_client
    resp = client.put("/api/settings", json={"rerequest_interval_days": value})
    assert resp.status_code == 422
    # File must not have been mutated on validation failure.
    assert not settings_file.exists()


def test_put_settings_rerequest_interval_days_env_locked(settings_client, monkeypatch):
    """When SMOKESCREEN_REREQUEST_INTERVAL_DAYS is set, PUT is refused with 409."""
    client, _ = settings_client
    monkeypatch.setenv("SMOKESCREEN_REREQUEST_INTERVAL_DAYS", "90")

    resp = client.put("/api/settings", json={"rerequest_interval_days": 45})
    assert resp.status_code == 409
    body = resp.json()
    assert body["detail"]["code"] == "env_controlled_fields"
    assert "rerequest_interval_days" in body["detail"]["fields"]


def test_get_settings_reports_rerequest_interval_days_from_env(
    settings_client, monkeypatch
):
    client, _ = settings_client
    monkeypatch.setenv("SMOKESCREEN_REREQUEST_INTERVAL_DAYS", "90")

    data = client.get("/api/settings").json()
    assert data["rerequest_interval_days_from_env"] is True


def test_put_settings_ai_provider_fields(settings_client):
    client, settings_file = settings_client
    resp = client.put(
        "/api/settings",
        json={
            "ai_provider": "gemini",
            "gemini_model": "gemini-3.1-flash-lite",
            "gemini_project": "vertex-project",
            "gemini_location": "global",
        },
    )
    assert resp.status_code == 200

    file_data = json.loads(settings_file.read_text())
    assert file_data["ai_provider"] == "gemini"
    assert file_data["gemini_model"] == "gemini-3.1-flash-lite"
    assert file_data["gemini_project"] == "vertex-project"
    assert file_data["gemini_location"] == "global"

    resp = client.get("/api/settings/advanced")
    assert resp.json()["ai_provider"] == "gemini"


def test_put_settings_rejects_unknown_ai_provider(settings_client):
    client, settings_file = settings_client
    resp = client.put("/api/settings", json={"ai_provider": "openai"})
    assert resp.status_code == 422
    assert not settings_file.exists()


def test_put_settings_restart_required_for_ui_field(settings_client):
    client, _ = settings_client
    resp = client.put(
        "/api/settings",
        json={"sender_email": "updated@example.com"},
    )
    assert resp.status_code == 200
    assert resp.json()["restart_required"] is True


@pytest.mark.parametrize(
    "field,value",
    [
        ("state_backend", "firestore"),
        ("sqlite_path", "/tmp/smokescreen.db"),
        ("firestore_project", "test-project"),
        ("firestore_collection", "test-collection"),
        ("gmail_credentials_path", "/tmp/credentials.json"),
        ("gmail_token_path", "/tmp/token.json"),
        ("gmail_oauth_interactive", False),
    ],
)
def test_put_settings_rejects_infrastructure_fields(settings_client, field, value):
    client, settings_file = settings_client
    resp = client.put("/api/settings", json={field: value})
    assert resp.status_code == 422
    assert not settings_file.exists()


def test_put_settings_rejects_removed_identity_docs_dir(settings_client):
    client, settings_file = settings_client
    resp = client.put("/api/settings", json={"identity_docs_dir": "identity/"})
    assert resp.status_code == 422
    assert not settings_file.exists()


def test_put_settings_restart_not_required(settings_client):
    client, _ = settings_client
    resp = client.put(
        "/api/settings",
        json={"dry_run": True},
    )
    assert resp.status_code == 200
    assert resp.json()["restart_required"] is False


def test_put_settings_updates_in_memory(settings_client):
    client, _ = settings_client
    client.put("/api/settings", json={"poll_label": "new-label"})

    resp = client.get("/api/settings/advanced")
    assert resp.json()["poll_label"] == "new-label"


def test_put_settings_rejects_unknown_fields(settings_client):
    client, _ = settings_client
    resp = client.put(
        "/api/settings",
        json={"nonexistent_field": "value"},
    )
    assert resp.status_code == 422


def test_put_settings_api_key(settings_client):
    client, settings_file = settings_client
    resp = client.put(
        "/api/settings",
        json={"anthropic_api_key": "sk-new-key-value"},
    )
    assert resp.status_code == 200

    # Verify key is saved in file
    file_data = json.loads(settings_file.read_text())
    assert file_data["anthropic_api_key"] == "sk-new-key-value"

    # Verify GET masks it
    resp = client.get("/api/settings")
    assert "sk-new-key-value" not in resp.json()["anthropic_api_key"]
    assert resp.json()["anthropic_api_key"] == "sk-n****lue"


def test_identity_document_endpoints_are_removed(settings_client):
    client, _ = settings_client

    assert client.get("/api/identity-documents").status_code == 404
    assert client.delete("/api/identity-documents/government_id").status_code in {
        404,
        405,
    }
    resp = client.post(
        "/api/identity-documents/government_id",
        files={"file": ("license.png", b"image", "image/png")},
    )
    assert resp.status_code in {404, 405}


def test_put_settings_merges_with_existing_file(settings_client):
    client, settings_file = settings_client
    # Write initial setting
    client.put("/api/settings", json={"poll_label": "first"})
    # Write another setting
    client.put("/api/settings", json={"max_retries": 3})

    # Both should be in the file
    file_data = json.loads(settings_file.read_text())
    assert file_data["poll_label"] == "first"
    assert file_data["max_retries"] == 3


# --- Env-aware / provider-aware settings ---


def test_get_settings_reports_env_flags_off_by_default(settings_client):
    client, _ = settings_client
    data = client.get("/api/settings").json()
    assert data["sender_email_from_env"] is False
    assert data["sender_name_from_env"] is False
    assert data["anthropic_key_from_secret"] is False
    assert data["ai_provider"] == "gemini"
    assert data["gmail_configured"] is False
    assert data["gemini_model"] == "gemini-3.1-flash-lite"


def test_get_settings_reports_sender_env_when_set(
    settings_client, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("SMOKESCREEN_SENDER_EMAIL", "deploy@example.com")
    monkeypatch.setenv("SMOKESCREEN_SENDER_NAME", "Deploy User")
    client, _ = settings_client
    data = client.get("/api/settings").json()
    assert data["sender_email_from_env"] is True
    assert data["sender_name_from_env"] is True


def test_get_settings_reports_gemini_provider_and_anthropic_secret(
    settings_client, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("SMOKESCREEN_AI_PROVIDER", "gemini")
    monkeypatch.setenv("SMOKESCREEN_ANTHROPIC_API_KEY", "sk-secret")
    api_module._settings = Settings(
        sender_email="test@example.com",
        sender_name="Test User",
    )
    client, _ = settings_client
    data = client.get("/api/settings").json()
    assert data["ai_provider"] == "gemini"
    assert data["anthropic_key_from_secret"] is True


def test_get_settings_reports_gmail_configured_when_both_present(
    settings_client, tmp_path
):
    api_module._settings = Settings(
        sender_email="test@example.com",
        sender_name="Test User",
        gmail_token_json="token",
        gmail_credentials_json="creds",
    )
    client, _ = settings_client
    data = client.get("/api/settings").json()
    assert data["gmail_configured"] is True


def test_put_settings_rejects_env_controlled_sender_email(
    settings_client, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("SMOKESCREEN_SENDER_EMAIL", "deploy@example.com")
    client, _ = settings_client
    resp = client.put(
        "/api/settings",
        json={"sender_email": "user-typed@example.com"},
    )
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert detail["code"] == "env_controlled_fields"
    assert "sender_email" in detail["fields"]


def test_put_settings_rejects_env_controlled_anthropic_key(
    settings_client, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("SMOKESCREEN_ANTHROPIC_API_KEY", "sk-from-secret")
    client, _ = settings_client
    resp = client.put(
        "/api/settings",
        json={"anthropic_api_key": "sk-user-typed"},
    )
    assert resp.status_code == 409
    assert "anthropic_api_key" in resp.json()["detail"]["fields"]


def test_put_settings_allows_editable_fields_when_env_locks_others(
    settings_client, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("SMOKESCREEN_SENDER_EMAIL", "deploy@example.com")
    client, _ = settings_client
    resp = client.put("/api/settings", json={"poll_label": "custom-label"})
    assert resp.status_code == 200
