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
            self._by_domain[b.domain] = b
            for alias in b.aliases:
                self._by_domain[alias] = b

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

    def all(self) -> list[Broker]:
        return list(self._brokers.values())

    def ids(self) -> list[str]:
        return list(self._brokers.keys())
