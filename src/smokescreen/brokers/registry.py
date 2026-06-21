"""Broker registry: loads broker definitions from YAML."""

from __future__ import annotations

from importlib import resources
from pathlib import Path

import yaml

from smokescreen.models import Broker


class BrokerRegistry:
    """Registry of known data brokers."""

    def __init__(self, brokers: list[Broker]) -> None:
        self._brokers = {b.id: b for b in brokers}
        self._by_domain: dict[str, Broker] = {}
        for b in brokers:
            self._index_domains(b)

    def _index_domains(self, broker: Broker) -> None:
        if broker.domain:
            self._by_domain[broker.domain] = broker
        for alias in broker.aliases:
            if alias:
                self._by_domain[alias] = broker

    def _remove_domain_index(self, broker: Broker) -> None:
        domains = [broker.domain, *broker.aliases]
        for domain in domains:
            if domain and self._by_domain.get(domain) is broker:
                del self._by_domain[domain]

    @classmethod
    def from_yaml(cls, path: Path | None = None) -> BrokerRegistry:
        """Load brokers from a YAML file. Defaults to the bundled brokers.yaml."""
        if path is None:
            ref = resources.files("smokescreen.brokers").joinpath("brokers.yaml")
            text = ref.read_text(encoding="utf-8")
        else:
            text = path.read_text(encoding="utf-8")
        data = yaml.safe_load(text)
        brokers = [Broker(**b) for b in data["brokers"]]
        return cls(brokers)

    def get(self, broker_id: str) -> Broker | None:
        return self._brokers.get(broker_id)

    def get_by_domain(self, domain: str) -> Broker | None:
        return self._by_domain.get(domain)

    def add(self, broker: Broker) -> None:
        self._brokers[broker.id] = broker
        self._index_domains(broker)

    def update(self, broker_id: str, broker: Broker) -> None:
        existing = self._brokers.get(broker_id)
        if existing is not None:
            self._remove_domain_index(existing)
        self._brokers[broker_id] = broker
        self._index_domains(broker)

    def delete(self, broker_id: str) -> None:
        broker = self._brokers.pop(broker_id)
        self._remove_domain_index(broker)

    def all(self) -> list[Broker]:
        return list(self._brokers.values())

    def ids(self) -> list[str]:
        return list(self._brokers.keys())
