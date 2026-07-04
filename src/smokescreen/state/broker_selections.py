"""Broker selection service helpers."""

from __future__ import annotations

from smokescreen.brokers.registry import BrokerRegistry
from smokescreen.state.store import StateStore


def list_or_seed_enabled_brokers(
    store: StateStore, registry: BrokerRegistry
) -> list[str]:
    """Return enabled brokers, seeding a missing selections document once."""
    if store.has_enabled_broker_selections():
        return store.list_enabled_brokers()
    return store.set_enabled_brokers(registry.default_enabled_ids())
