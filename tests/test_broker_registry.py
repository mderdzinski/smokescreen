"""Tests for the broker registry."""

from smokescreen.brokers.registry import (
    TEST_BROKER_EMAIL_ENV,
    TEST_BROKER_ENABLED_ENV,
    TEST_BROKER_ID_ENV,
    TEST_BROKER_NAME_ENV,
    BrokerRegistry,
)
from smokescreen.models import Broker


def test_load_default_yaml():
    registry = BrokerRegistry.from_yaml()
    brokers = registry.all()
    assert len(brokers) > 0


def test_get_by_id():
    registry = BrokerRegistry.from_yaml()
    broker = registry.get("spokeo")
    assert broker is not None
    assert broker.name == "Spokeo, Inc."
    assert broker.privacy_email == "jmatthes@spokeo.com"


def test_get_by_domain():
    registry = BrokerRegistry.from_yaml()
    broker = registry.get_by_domain("spokeo.com")
    assert broker is not None
    assert broker.id == "spokeo"


def test_get_by_alias():
    registry = BrokerRegistry.from_yaml()
    broker = registry.get_by_domain("neighborwho.com")
    assert broker is not None
    assert broker.id == "beenverified"


def test_get_nonexistent():
    registry = BrokerRegistry.from_yaml()
    assert registry.get("nonexistent") is None
    assert registry.get_by_domain("nonexistent.com") is None


def test_ids():
    registry = BrokerRegistry.from_yaml()
    ids = registry.ids()
    assert "spokeo" in ids
    assert "beenverified" in ids


def test_add_indexes_domain_and_aliases():
    registry = BrokerRegistry([])
    broker = Broker(
        id="example",
        name="Example",
        domain="example.com",
        privacy_email="privacy@example.com",
        aliases=["alias.example.com"],
    )

    registry.add(broker)

    assert registry.get("example") is broker
    assert registry.get_by_domain("example.com") is broker
    assert registry.get_by_domain("alias.example.com") is broker


def test_update_replaces_domain_and_alias_indexes():
    broker = Broker(
        id="example",
        name="Example",
        domain="old.example.com",
        privacy_email="privacy@example.com",
        aliases=["old-alias.example.com"],
    )
    registry = BrokerRegistry([broker])
    updated = broker.model_copy(
        update={"domain": "new.example.com", "aliases": ["new-alias.example.com"]}
    )

    registry.update("example", updated)

    assert registry.get_by_domain("old.example.com") is None
    assert registry.get_by_domain("old-alias.example.com") is None
    assert registry.get_by_domain("new.example.com") is updated
    assert registry.get_by_domain("new-alias.example.com") is updated


def test_delete_removes_domain_and_alias_indexes():
    broker = Broker(
        id="example",
        name="Example",
        domain="example.com",
        privacy_email="privacy@example.com",
        aliases=["alias.example.com"],
    )
    registry = BrokerRegistry([broker])

    registry.delete("example")

    assert registry.get("example") is None
    assert registry.get_by_domain("example.com") is None
    assert registry.get_by_domain("alias.example.com") is None


def test_synthetic_test_broker_registered(monkeypatch):
    monkeypatch.setenv(TEST_BROKER_EMAIL_ENV, "operator+testbroker@gmail.com")
    monkeypatch.delenv(TEST_BROKER_ID_ENV, raising=False)
    monkeypatch.delenv(TEST_BROKER_NAME_ENV, raising=False)
    monkeypatch.delenv(TEST_BROKER_ENABLED_ENV, raising=False)

    registry = BrokerRegistry.from_yaml()

    broker = registry.get("testbroker")
    assert broker is not None
    assert broker.name == "Test Broker"
    assert broker.privacy_email == "operator+testbroker@gmail.com"
    assert broker.domain == "gmail.com"
    assert broker.notes == "Synthetic test broker for end-to-end validation."
    assert broker in registry.all()
    assert registry.default_enabled_ids() == ["testbroker"]

    monkeypatch.delenv(TEST_BROKER_EMAIL_ENV)
    registry = BrokerRegistry.from_yaml()

    assert registry.get("testbroker") is None
    assert "testbroker" not in registry.ids()


def test_synthetic_test_broker_uses_configured_identity(monkeypatch):
    monkeypatch.setenv(TEST_BROKER_EMAIL_ENV, "privacy@example.test")
    monkeypatch.setenv(TEST_BROKER_ID_ENV, "qa-broker")
    monkeypatch.setenv(TEST_BROKER_NAME_ENV, "QA Broker")

    registry = BrokerRegistry.from_yaml()

    broker = registry.get("qa-broker")
    assert broker is not None
    assert broker.name == "QA Broker"
    assert broker.domain == "example.test"
    assert broker.privacy_email == "privacy@example.test"


def test_synthetic_test_broker_enabled_false_stays_selectable(monkeypatch):
    monkeypatch.setenv(TEST_BROKER_EMAIL_ENV, "privacy@example.test")
    monkeypatch.setenv(TEST_BROKER_ENABLED_ENV, "false")

    registry = BrokerRegistry.from_yaml()

    assert registry.get("testbroker") is not None
    assert "testbroker" in registry.ids()
    assert registry.default_enabled_ids() == []


def test_synthetic_test_broker_does_not_overwrite_yaml_id(tmp_path, monkeypatch):
    brokers_yaml = tmp_path / "brokers.yaml"
    brokers_yaml.write_text(
        """
brokers:
  - id: testbroker
    name: Real YAML Broker
    domain: real.example
    privacy_email: privacy@real.example
""".lstrip(),
        encoding="utf-8",
    )
    monkeypatch.setenv(TEST_BROKER_EMAIL_ENV, "privacy@example.test")

    registry = BrokerRegistry.from_yaml(brokers_yaml)

    broker = registry.get("testbroker")
    assert broker is not None
    assert broker.name == "Real YAML Broker"
    assert broker.privacy_email == "privacy@real.example"
    assert registry.default_enabled_ids() == []
