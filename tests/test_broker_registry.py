"""Tests for the broker registry."""

from smokescreen.brokers.registry import BrokerRegistry
from smokescreen.models import Broker


def test_load_default_yaml():
    registry = BrokerRegistry.from_yaml()
    brokers = registry.all()
    assert len(brokers) > 0


def test_get_by_id():
    registry = BrokerRegistry.from_yaml()
    broker = registry.get("spokeo")
    assert broker is not None
    assert broker.name == "Spokeo"
    assert broker.privacy_email == "privacy@spokeo.com"


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
