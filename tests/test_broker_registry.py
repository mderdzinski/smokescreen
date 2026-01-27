"""Tests for the broker registry."""

from smokescreen.brokers.registry import BrokerRegistry


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
