"""Tests for broker selection document size estimates."""

from smokescreen.brokers.registry import BrokerRegistry
from smokescreen.state.selection_size import (
    BROKER_SELECTION_WARNING_THRESHOLD_BYTES,
    broker_selection_size_warning,
    estimate_broker_selection_document_size_bytes,
)


def test_all_default_brokers_fit_under_selection_warning_threshold():
    broker_ids = BrokerRegistry.from_yaml().ids()

    size_bytes = estimate_broker_selection_document_size_bytes(broker_ids)

    assert size_bytes < BROKER_SELECTION_WARNING_THRESHOLD_BYTES
    assert broker_selection_size_warning(broker_ids) is None


def test_selection_size_warning_when_document_approaches_threshold():
    broker_ids = [f"large-broker-{index:04d}" for index in range(200)]

    warning = broker_selection_size_warning(broker_ids, threshold_bytes=1024)

    assert warning is not None
    assert "approaching the 1 MiB Firestore document limit" in warning
