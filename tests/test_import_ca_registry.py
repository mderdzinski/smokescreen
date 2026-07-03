"""Tests for the CA data broker registry importer."""

from __future__ import annotations

import csv

import yaml

from scripts.import_ca_registry import (
    DBA_COLUMN,
    EMAIL_COLUMN,
    GENERATED_NOTE_PREFIX,
    NAME_COLUMN,
    OPT_OUT_URL_COLUMN,
    WEBSITE_COLUMN,
    import_ca_registry,
)


def test_import_ca_registry_generates_yaml_and_preserves_curated(tmp_path):
    csv_path = tmp_path / "ca.csv"
    existing_yaml_path = tmp_path / "brokers.yaml"
    output_yaml_path = tmp_path / "out.yaml"
    write_csv(
        csv_path,
        [
            {
                NAME_COLUMN: "Alpha Data Inc.",
                DBA_COLUMN: "",
                WEBSITE_COLUMN: "https://www.alpha.example",
                EMAIL_COLUMN: "Privacy@Alpha.example",
                OPT_OUT_URL_COLUMN: "https://privacy.alpha.example/opt-out",
            },
            {
                NAME_COLUMN: "Acme LLC",
                DBA_COLUMN: "",
                WEBSITE_COLUMN: "acme.example",
                EMAIL_COLUMN: "privacy@acme.example",
            },
            {
                NAME_COLUMN: "Acme Inc.",
                DBA_COLUMN: "North Division",
                WEBSITE_COLUMN: "north.acme.example",
                EMAIL_COLUMN: "north@acme.example",
            },
            {
                NAME_COLUMN: "Missing Email LLC",
                WEBSITE_COLUMN: "missing.example",
                EMAIL_COLUMN: "",
            },
        ],
    )
    existing_yaml_path.write_text(
        """
brokers:
  - id: alphadata
    name: Alpha Data
    domain: alpha.example
    privacy_email: privacy@alpha.example
    aliases:
      - old-alpha.example
    notes: Usually replies within a week.
  - id: curatedonly
    name: Curated Only
    domain: curated.example
    privacy_email: privacy@curated.example
""".lstrip(),
        encoding="utf-8",
    )

    report = import_ca_registry(
        csv_path,
        existing_yaml_path=existing_yaml_path,
        output_yaml_path=output_yaml_path,
    )

    assert report.csv_rows == 4
    assert report.imported == 3
    assert report.skipped_missing_email == [(5, "Missing Email LLC")]
    assert report.preserved_curated == 1
    assert report.duplicate_disambiguations == 1

    output = output_yaml_path.read_text(encoding="utf-8")
    assert "Preserved curated brokers absent from the CA 2026 CSV" in output
    data = yaml.safe_load(output)
    ids = [broker["id"] for broker in data["brokers"]]
    brokers = {broker["id"]: broker for broker in data["brokers"]}
    assert ids == ["acme-northdivision", "acme", "alphadata", "curatedonly"]
    assert brokers["alphadata"]["domain"] == "alpha.example"
    assert brokers["alphadata"]["privacy_email"] == "privacy@alpha.example"
    assert brokers["alphadata"]["aliases"] == [
        "old-alpha.example",
        "privacy.alpha.example",
    ]
    assert brokers["alphadata"]["notes"].startswith(GENERATED_NOTE_PREFIX)
    assert (
        "Curated note: Usually replies within a week."
        in brokers["alphadata"]["notes"]
    )
    assert brokers["curatedonly"]["privacy_email"] == "privacy@curated.example"


def test_import_ca_registry_does_not_preserve_previous_generated_entries(tmp_path):
    csv_path = tmp_path / "ca.csv"
    existing_yaml_path = tmp_path / "brokers.yaml"
    output_yaml_path = tmp_path / "out.yaml"
    write_csv(
        csv_path,
        [
            {
                NAME_COLUMN: "Fresh Broker LLC",
                WEBSITE_COLUMN: "fresh.example",
                EMAIL_COLUMN: "privacy@fresh.example",
            }
        ],
    )
    existing_yaml_path.write_text(
        """
brokers:
  - id: stalegenerated
    name: Stale Generated
    domain: stale.example
    privacy_email: privacy@stale.example
    notes: "Imported from CA Data Broker Registry 2026. Opt-out URL: https://stale.example/privacy."
  - id: manualbroker
    name: Manual Broker
    domain: manual.example
    privacy_email: privacy@manual.example
""".lstrip(),
        encoding="utf-8",
    )

    report = import_ca_registry(
        csv_path,
        existing_yaml_path=existing_yaml_path,
        output_yaml_path=output_yaml_path,
    )

    data = yaml.safe_load(output_yaml_path.read_text(encoding="utf-8"))
    ids = [broker["id"] for broker in data["brokers"]]
    assert ids == ["freshbroker", "manualbroker"]
    assert report.preserved_curated == 1


def write_csv(path, rows):
    headers = [
        NAME_COLUMN,
        DBA_COLUMN,
        WEBSITE_COLUMN,
        EMAIL_COLUMN,
        OPT_OUT_URL_COLUMN,
    ]
    with path.open("w", newline="", encoding="utf-8") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=headers)
        writer.writeheader()
        writer.writerows(rows)
