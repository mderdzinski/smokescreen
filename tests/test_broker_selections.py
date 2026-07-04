"""Tests for broker selection seeding semantics."""

from smokescreen.brokers.registry import (
    TEST_BROKER_EMAIL_ENV,
    TEST_BROKER_ENABLED_ENV,
    BrokerRegistry,
)
from smokescreen.models import Broker
from smokescreen.state.broker_selections import list_or_seed_enabled_brokers
from smokescreen.state.sqlite import SQLiteStore


def _broker(broker_id: str) -> Broker:
    return Broker(
        id=broker_id,
        name=broker_id.title(),
        domain=f"{broker_id}.example",
        privacy_email=f"privacy@{broker_id}.example",
    )


def test_selections_seeded_from_defaults_on_first_read(tmp_path):
    store = SQLiteStore(tmp_path / "state.db")
    registry = BrokerRegistry(
        [_broker("default"), _broker("other")],
        default_enabled_broker_ids=["default"],
    )

    enabled = list_or_seed_enabled_brokers(store, registry)

    assert enabled == ["default"]
    assert store.has_enabled_broker_selections() is True
    assert store.list_enabled_brokers() == ["default"]

    changed_registry = BrokerRegistry(
        [_broker("default"), _broker("other")],
        default_enabled_broker_ids=["other"],
    )
    assert list_or_seed_enabled_brokers(store, changed_registry) == ["default"]
    store.close()


def test_selections_persist_across_env_changes(tmp_path, monkeypatch):
    monkeypatch.setenv(TEST_BROKER_EMAIL_ENV, "operator+testbroker@gmail.com")
    monkeypatch.delenv(TEST_BROKER_ENABLED_ENV, raising=False)
    store = SQLiteStore(tmp_path / "state.db")

    assert list_or_seed_enabled_brokers(store, BrokerRegistry.from_yaml()) == [
        "testbroker"
    ]

    monkeypatch.setenv(TEST_BROKER_ENABLED_ENV, "false")
    assert list_or_seed_enabled_brokers(store, BrokerRegistry.from_yaml()) == [
        "testbroker"
    ]
    store.close()


def test_testbroker_disable_persists_across_env_setting(tmp_path, monkeypatch):
    monkeypatch.setenv(TEST_BROKER_EMAIL_ENV, "operator+testbroker@gmail.com")
    monkeypatch.delenv(TEST_BROKER_ENABLED_ENV, raising=False)
    store = SQLiteStore(tmp_path / "state.db")

    assert list_or_seed_enabled_brokers(store, BrokerRegistry.from_yaml()) == [
        "testbroker"
    ]
    store.set_enabled_brokers([])
    monkeypatch.setenv(TEST_BROKER_ENABLED_ENV, "true")

    assert list_or_seed_enabled_brokers(store, BrokerRegistry.from_yaml()) == []
    store.close()
