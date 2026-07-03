"""Broker registry: loads broker definitions from YAML."""

from __future__ import annotations

import os
from email.utils import parseaddr
from importlib import resources
from pathlib import Path

import structlog
import yaml

from smokescreen.models import Broker

log = structlog.get_logger()

TEST_BROKER_ID_ENV = "SMOKESCREEN_TEST_BROKER_ID"
TEST_BROKER_NAME_ENV = "SMOKESCREEN_TEST_BROKER_NAME"
TEST_BROKER_EMAIL_ENV = "SMOKESCREEN_TEST_BROKER_EMAIL"
TEST_BROKER_ENABLED_ENV = "SMOKESCREEN_TEST_BROKER_ENABLED"

DEFAULT_TEST_BROKER_ID = "testbroker"
DEFAULT_TEST_BROKER_NAME = "Test Broker"
DEFAULT_TEST_BROKER_ENABLED = True

_FALSE_VALUES = {"0", "false", "f", "no", "n", "off"}
_TRUE_VALUES = {"1", "true", "t", "yes", "y", "on"}


class BrokerRegistry:
    """Registry of known data brokers."""

    def __init__(
        self,
        brokers: list[Broker],
        *,
        default_enabled_broker_ids: list[str] | None = None,
    ) -> None:
        self._brokers = {b.id: b for b in brokers}
        self._default_enabled_broker_ids = set(default_enabled_broker_ids or [])
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
        registry = cls(brokers)
        registry._augment_from_env()
        return registry

    def _augment_from_env(self) -> None:
        synthetic = _synthetic_test_broker_from_env()
        if synthetic is None:
            return

        broker, enabled = synthetic
        if broker.id in self._brokers:
            log.warning(
                "synthetic_test_broker_id_collision",
                broker_id=broker.id,
                env_var=TEST_BROKER_ID_ENV,
            )
            return

        self.add(broker)
        if enabled:
            self._default_enabled_broker_ids.add(broker.id)

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
        self._default_enabled_broker_ids.discard(broker_id)
        self._remove_domain_index(broker)

    def all(self) -> list[Broker]:
        return list(self._brokers.values())

    def ids(self) -> list[str]:
        return list(self._brokers.keys())

    def default_enabled_ids(self) -> list[str]:
        """Broker IDs enabled by runtime defaults before persisted selections."""
        return sorted(self._default_enabled_broker_ids)


def _synthetic_test_broker_from_env() -> tuple[Broker, bool] | None:
    email = os.environ.get(TEST_BROKER_EMAIL_ENV, "").strip()
    if not email:
        return None

    broker_id = _env_value(TEST_BROKER_ID_ENV, DEFAULT_TEST_BROKER_ID)
    name = _env_value(TEST_BROKER_NAME_ENV, DEFAULT_TEST_BROKER_NAME)
    enabled = _env_bool(TEST_BROKER_ENABLED_ENV, DEFAULT_TEST_BROKER_ENABLED)

    broker = Broker(
        id=broker_id,
        name=name,
        domain=_domain_from_email(email, broker_id),
        privacy_email=email,
        aliases=[],
        notes="Synthetic test broker for end-to-end validation.",
    )
    return broker, enabled


def _env_value(name: str, default: str) -> str:
    value = os.environ.get(name, "").strip()
    return value or default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default

    normalized = raw.strip().lower()
    if normalized in _TRUE_VALUES:
        return True
    if normalized in _FALSE_VALUES:
        return False

    log.warning(
        "invalid_synthetic_test_broker_enabled",
        env_var=name,
        value=raw,
        default=default,
    )
    return default


def _domain_from_email(email: str, fallback_id: str) -> str:
    _, address = parseaddr(email)
    if "@" not in address:
        return f"{fallback_id}.synthetic.local"
    domain = address.rsplit("@", 1)[1].strip().lower()
    return domain or f"{fallback_id}.synthetic.local"
