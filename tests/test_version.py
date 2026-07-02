"""Tests for the app version source and /api/version endpoint."""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError

import pytest
from fastapi.testclient import TestClient

from smokescreen import version as version_module
from smokescreen.api import app
from smokescreen.version import get_app_version


def test_get_app_version_returns_installed_metadata() -> None:
    resolved = get_app_version()
    assert resolved
    assert resolved != "0.0.0"
    assert all(part.isdigit() for part in resolved.split(".")[:2])


def test_get_app_version_falls_back_to_pyproject(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _raise(_name: str) -> str:
        raise PackageNotFoundError

    monkeypatch.setattr(version_module, "_pkg_version", _raise)

    resolved = get_app_version()
    assert resolved
    assert resolved != "0.0.0"


def test_get_app_version_unknown_when_all_sources_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _raise(_name: str) -> str:
        raise PackageNotFoundError

    monkeypatch.setattr(version_module, "_pkg_version", _raise)
    monkeypatch.setattr(version_module, "_read_pyproject_version", lambda: None)

    assert get_app_version() == "0.0.0"


def test_version_endpoint_returns_json_with_version() -> None:
    client = TestClient(app)
    response = client.get("/api/version")
    assert response.status_code == 200
    payload = response.json()
    assert set(payload.keys()) == {"version"}
    assert isinstance(payload["version"], str)
    assert payload["version"]
