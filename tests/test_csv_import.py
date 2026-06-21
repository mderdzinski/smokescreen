"""Tests for CSV broker import (CLI helper + API endpoint)."""

import csv
import io
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from smokescreen.api import app, init_app
from smokescreen.brokers.registry import BrokerRegistry
from smokescreen.cli import _domain_from_email, _run_csv_import, _slugify
from smokescreen.config import Settings
from smokescreen.models import Broker
from smokescreen.state.sqlite import SQLiteStore

# --- Unit tests for helpers ---


def test_slugify_basic():
    assert _slugify("Spokeo Inc") == "spokeo-inc"


def test_slugify_special_chars():
    assert _slugify("Been Verified (US)") == "been-verified-us"


def test_slugify_already_slug():
    assert _slugify("my-broker") == "my-broker"


def test_domain_from_email():
    assert _domain_from_email("privacy@spokeo.com") == "spokeo.com"


def test_domain_from_email_no_at():
    assert _domain_from_email("invalid") == ""


# --- CSV import function tests ---


def _write_csv(path: Path, rows: list[dict]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def test_csv_import_basic(tmp_path):
    csv_path = tmp_path / "brokers.csv"
    _write_csv(
        csv_path,
        [
            {"name": "Test Broker", "privacy_email": "privacy@test.com"},
            {"name": "Another Broker", "privacy_email": "opt-out@another.com"},
        ],
    )
    registry = BrokerRegistry([])
    store = SQLiteStore(tmp_path / "test.db")

    imported, skipped, errors = _run_csv_import(
        csv_path, registry, store, "name", "privacy_email", None, None, None
    )

    assert imported == 2
    assert skipped == 0
    assert errors == []
    assert registry.get("test-broker") is not None
    assert registry.get("another-broker") is not None
    assert registry.get("test-broker").domain == "test.com"
    store.close()


def test_csv_import_with_id_and_domain_cols(tmp_path):
    csv_path = tmp_path / "brokers.csv"
    _write_csv(
        csv_path,
        [
            {
                "id": "custom-id",
                "name": "Custom",
                "email": "p@custom.com",
                "domain": "custom.com",
            },
        ],
    )
    registry = BrokerRegistry([])
    store = SQLiteStore(tmp_path / "test.db")

    imported, skipped, errors = _run_csv_import(
        csv_path, registry, store, "name", "email", "domain", "id", None
    )

    assert imported == 1
    assert registry.get("custom-id") is not None
    assert registry.get("custom-id").domain == "custom.com"
    store.close()


def test_csv_import_skips_duplicates(tmp_path):
    csv_path = tmp_path / "brokers.csv"
    _write_csv(
        csv_path,
        [
            {"name": "Spokeo", "privacy_email": "privacy@spokeo.com"},
        ],
    )
    existing = Broker(
        id="spokeo",
        name="Spokeo",
        domain="spokeo.com",
        privacy_email="privacy@spokeo.com",
    )
    registry = BrokerRegistry([existing])
    store = SQLiteStore(tmp_path / "test.db")

    imported, skipped, errors = _run_csv_import(
        csv_path, registry, store, "name", "privacy_email", None, None, None
    )

    assert imported == 0
    assert skipped == 1
    store.close()


def test_csv_import_reports_missing_fields(tmp_path):
    csv_path = tmp_path / "brokers.csv"
    _write_csv(
        csv_path,
        [
            {"name": "", "privacy_email": "p@test.com"},
            {"name": "Valid", "privacy_email": ""},
        ],
    )
    registry = BrokerRegistry([])
    store = SQLiteStore(tmp_path / "test.db")

    imported, skipped, errors = _run_csv_import(
        csv_path, registry, store, "name", "privacy_email", None, None, None
    )

    assert imported == 0
    assert len(errors) == 2
    store.close()


# --- API endpoint tests ---


def _make_brokers():
    return [
        Broker(
            id="spokeo",
            name="Spokeo",
            domain="spokeo.com",
            privacy_email="privacy@spokeo.com",
        ),
    ]


@pytest.fixture
def client(tmp_path):
    store = SQLiteStore(tmp_path / "test.db")
    registry = BrokerRegistry(_make_brokers())
    settings = Settings(sender_email="test@example.com", sender_name="Test")
    init_app(store, registry, settings)
    yield TestClient(app)
    store.close()


def test_api_import_csv(client):
    content = "name,privacy_email\nNew Broker,opt@new.com\n"
    resp = client.post(
        "/api/brokers/import",
        files={"file": ("brokers.csv", io.BytesIO(content.encode()), "text/csv")},
        data={
            "name_col": "name",
            "email_col": "privacy_email",
            "domain_col": "",
            "id_col": "",
            "notes_col": "",
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["imported"] == 1
    assert data["skipped"] == 0


def test_api_import_csv_auto_detects_friendly_headers(client):
    content = (
        "Company,Contact Email,Website\n"
        "Friendly Broker,opt@friendly.com,friendly.com\n"
    )
    resp = client.post(
        "/api/brokers/import",
        files={"file": ("brokers.csv", io.BytesIO(content.encode()), "text/csv")},
        data={},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["imported"] == 1
    assert data["skipped"] == 0


def test_api_import_csv_duplicate(client):
    content = "name,privacy_email\nSpokeo,privacy@spokeo.com\n"
    resp = client.post(
        "/api/brokers/import",
        files={"file": ("brokers.csv", io.BytesIO(content.encode()), "text/csv")},
        data={
            "name_col": "name",
            "email_col": "privacy_email",
            "domain_col": "",
            "id_col": "",
            "notes_col": "",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["skipped"] == 1
    assert resp.json()["imported"] == 0
