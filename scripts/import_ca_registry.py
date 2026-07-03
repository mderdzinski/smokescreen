"""Import the California data broker registry CSV into brokers.yaml."""

from __future__ import annotations

import argparse
import csv
import re
from dataclasses import dataclass, field
from email.utils import getaddresses
from pathlib import Path
from urllib.parse import urlparse

import yaml

NAME_COLUMN = "Data broker name:"
DBA_COLUMN = "Doing Business As (DBA), if applicable:"
WEBSITE_COLUMN = "Data broker primary website:"
EMAIL_COLUMN = "Data broker primary contact email address:"
PHONE_COLUMN = "Data broker primary phone number: [optional]"
ADDRESS_COLUMNS = (
    "Data broker primary street address:",
    "Data broker city:",
    "Data broker state:",
    "Data broker zip code:",
    "Data broker country:",
)
OPT_OUT_URL_COLUMN = (
    "Data broker's primary website that contains details on how consumers can "
    "exercise their CA Consumer Privacy rights:"
)
COMMENTS_COLUMN = "Additional Context or Comments:  [optional]"

GENERATED_NOTE_PREFIX = "Imported from CA Data Broker Registry 2026."
COMMON_BUSINESS_SUFFIXES = {
    "co",
    "company",
    "corp",
    "corporation",
    "inc",
    "incorporated",
    "limited",
    "llc",
    "llp",
    "lp",
    "ltd",
    "plc",
}
BROKER_FIELD_ORDER = ("id", "name", "domain", "privacy_email", "aliases", "notes")


@dataclass
class ImportReport:
    csv_rows: int = 0
    imported: int = 0
    skipped_missing_email: list[tuple[int, str]] = field(default_factory=list)
    preserved_curated: int = 0
    duplicate_disambiguations: int = 0


def slugify_broker_name(name: str) -> str:
    """Create a stable broker ID from a registry name."""
    tokens = re.findall(r"[a-z0-9]+", name.lower().replace("&", " and "))
    while tokens and tokens[-1] in COMMON_BUSINESS_SUFFIXES:
        tokens.pop()
    return "".join(tokens)


def normalize_domain(value: str) -> str:
    raw = value.strip()
    if not raw:
        return ""
    raw = re.split(r"[;,\s]+", raw, maxsplit=1)[0].strip()
    raw = raw.rstrip("/.")
    parsed = urlparse(
        raw if re.match(r"^[a-z][a-z0-9+.-]*://", raw) else f"https://{raw}"
    )
    domain = (parsed.hostname or parsed.path.split("/", 1)[0]).strip().lower()
    return domain.removeprefix("www.")


def email_domain(email: str) -> str:
    return email.rsplit("@", 1)[1].strip().lower() if "@" in email else ""


def primary_email(raw: str) -> str:
    addresses = [
        address.strip()
        for _, address in getaddresses([raw.replace(";", ",")])
        if "@" in address
    ]
    return addresses[0].lower() if addresses else raw.strip().lower()


def unique_broker_id(
    *,
    name: str,
    dba: str,
    used_ids: set[str],
) -> tuple[str, bool]:
    base = slugify_broker_name(name)
    if not base:
        base = "broker"
    if base not in used_ids:
        used_ids.add(base)
        return base, False

    dba_slug = slugify_broker_name(dba)
    if dba_slug and dba_slug != base:
        candidate = f"{base}-{dba_slug}"
        if candidate not in used_ids:
            used_ids.add(candidate)
            return candidate, True

    suffix = 2
    while f"{base}-{suffix}" in used_ids:
        suffix += 1
    broker_id = f"{base}-{suffix}"
    used_ids.add(broker_id)
    return broker_id, True


def broker_from_row(
    row: dict[str, str], row_number: int, used_ids: set[str]
) -> tuple[dict[str, object] | None, bool, tuple[int, str] | None]:
    name = row.get(NAME_COLUMN, "").strip()
    email = primary_email(row.get(EMAIL_COLUMN, ""))
    if not email:
        return None, False, (row_number, name)

    dba = row.get(DBA_COLUMN, "").strip()
    website = row.get(WEBSITE_COLUMN, "").strip()
    opt_out_url = row.get(OPT_OUT_URL_COLUMN, "").strip()
    domain = normalize_domain(website) or email_domain(email)
    opt_out_domain = normalize_domain(opt_out_url)
    aliases = sorted({opt_out_domain} - {domain, ""})
    broker_id, disambiguated = unique_broker_id(
        name=name, dba=dba, used_ids=used_ids
    )

    notes = build_notes(row)
    broker: dict[str, object] = {
        "id": broker_id,
        "name": name,
        "domain": domain,
        "privacy_email": email,
    }
    if aliases:
        broker["aliases"] = aliases
    if notes:
        broker["notes"] = notes
    return broker, disambiguated, None


def build_notes(row: dict[str, str]) -> str:
    parts = [GENERATED_NOTE_PREFIX]
    dba = row.get(DBA_COLUMN, "").strip()
    phone = row.get(PHONE_COLUMN, "").strip()
    opt_out_url = row.get(OPT_OUT_URL_COLUMN, "").strip()
    comments = " ".join(row.get(COMMENTS_COLUMN, "").split())
    address = ", ".join(
        value
        for column in ADDRESS_COLUMNS
        if (value := row.get(column, "").strip())
    )
    if dba:
        parts.append(f"DBA: {dba}.")
    if opt_out_url:
        parts.append(f"Opt-out URL: {opt_out_url}.")
    if phone:
        parts.append(f"Contact phone: {phone}.")
    if address:
        parts.append(f"Address: {address}.")
    if comments:
        parts.append(f"Additional context: {comments}.")
    return " ".join(parts)


def load_existing_brokers(path: Path) -> list[dict[str, object]]:
    if not path.is_file():
        return []
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return list(data.get("brokers") or [])


def import_ca_registry(
    csv_path: Path,
    *,
    existing_yaml_path: Path,
    output_yaml_path: Path,
) -> ImportReport:
    existing_brokers = load_existing_brokers(existing_yaml_path)
    used_ids: set[str] = set()
    imported: list[dict[str, object]] = []
    report = ImportReport()

    with csv_path.open(newline="", encoding="utf-8-sig") as csv_file:
        reader = csv.DictReader(csv_file)
        for row_number, row in enumerate(reader, start=2):
            report.csv_rows += 1
            broker, disambiguated, skipped = broker_from_row(
                row, row_number, used_ids
            )
            if skipped is not None:
                report.skipped_missing_email.append(skipped)
                continue
            if broker is None:
                continue
            report.duplicate_disambiguations += int(disambiguated)
            imported.append(broker)

    merge_existing_metadata(imported, existing_brokers)
    preserved = preserved_curated_brokers(imported, existing_brokers)
    report.imported = len(imported)
    report.preserved_curated = len(preserved)

    imported.sort(key=lambda broker: str(broker["name"]).lower())
    preserved.sort(key=lambda broker: str(broker["name"]).lower())
    output_yaml_path.write_text(
        format_brokers_yaml(imported, preserved), encoding="utf-8"
    )
    return report


def merge_existing_metadata(
    imported: list[dict[str, object]], existing_brokers: list[dict[str, object]]
) -> None:
    imported_by_key = imported_lookup(imported)
    for existing in existing_brokers:
        imported_broker = find_imported(imported_by_key, existing)
        if imported_broker is None:
            continue

        aliases = {
            str(alias)
            for alias in imported_broker.get("aliases", [])
            if isinstance(alias, str) and alias
        }
        aliases.update(
            str(alias)
            for alias in existing.get("aliases", [])
            if isinstance(alias, str) and alias
        )
        aliases.discard(str(imported_broker.get("domain", "")))
        if aliases:
            imported_broker["aliases"] = sorted(aliases)

        existing_note = str(existing.get("notes", "")).strip()
        imported_note = str(imported_broker.get("notes", "")).strip()
        if existing_note and not existing_note.startswith(GENERATED_NOTE_PREFIX):
            curated_note = f"Curated note: {existing_note}"
            if curated_note not in imported_note:
                imported_broker["notes"] = f"{imported_note} {curated_note}"


def preserved_curated_brokers(
    imported: list[dict[str, object]], existing_brokers: list[dict[str, object]]
) -> list[dict[str, object]]:
    imported_keys = {
        key
        for broker in imported
        for key in broker_identity_keys(broker)
    }
    preserved: list[dict[str, object]] = []
    for existing in existing_brokers:
        note = str(existing.get("notes", "")).strip()
        if note.startswith(GENERATED_NOTE_PREFIX):
            continue
        if broker_identity_keys(existing) & imported_keys:
            continue
        preserved.append(ordered_broker(existing))
    return preserved


def imported_lookup(
    imported: list[dict[str, object]]
) -> dict[tuple[str, str], dict[str, object]]:
    lookup: dict[tuple[str, str], dict[str, object]] = {}
    for broker in imported:
        keys = broker_keys(broker)
        for key in keys:
            lookup.setdefault(key, broker)
    return lookup


def find_imported(
    imported_by_key: dict[tuple[str, str], dict[str, object]],
    broker: dict[str, object],
) -> dict[str, object] | None:
    for key in broker_keys(broker):
        if key in imported_by_key:
            return imported_by_key[key]
    return None


def broker_keys(broker: dict[str, object]) -> set[tuple[str, str]]:
    keys: set[tuple[str, str]] = set()
    email = str(broker.get("privacy_email", "")).strip().lower()
    domain = normalize_domain(str(broker.get("domain", "")))
    keys.update(broker_identity_keys(broker))
    for label, value in (
        ("email", email),
        ("domain", domain),
    ):
        if value:
            keys.add((label, value))
    return keys


def broker_identity_keys(broker: dict[str, object]) -> set[tuple[str, str]]:
    keys: set[tuple[str, str]] = set()
    broker_id = str(broker.get("id", "")).strip().lower()
    name_slug = slugify_broker_name(str(broker.get("name", "")))
    for label, value in (("id", broker_id), ("slug", name_slug)):
        if value:
            keys.add((label, value))
    return keys


def ordered_broker(broker: dict[str, object]) -> dict[str, object]:
    return {key: broker[key] for key in BROKER_FIELD_ORDER if key in broker}


def format_brokers_yaml(
    imported: list[dict[str, object]], preserved: list[dict[str, object]]
) -> str:
    lines = [
        "# Generated by scripts/import_ca_registry.py from the CA 2026 registry CSV.",
        "# Do not edit generated CA entries by hand; rerun the importer instead.",
    ]
    if preserved:
        lines.append(
            "# Curated brokers absent from the CA CSV are preserved after the "
            "generated entries."
        )
    lines.append("brokers:")
    lines.extend(format_broker_entries(imported))
    if preserved:
        lines.append("")
        lines.append("  # Preserved curated brokers absent from the CA 2026 CSV.")
        lines.extend(format_broker_entries(preserved))
    lines.append("")
    return "\n".join(lines)


def format_broker_entries(brokers: list[dict[str, object]]) -> list[str]:
    lines: list[str] = []
    for broker in brokers:
        ordered = ordered_broker(broker)
        rendered = yaml.safe_dump(
            [ordered],
            allow_unicode=True,
            default_flow_style=False,
            sort_keys=False,
            width=120,
        ).rstrip()
        lines.extend(f"  {line}" for line in rendered.splitlines())
    return lines


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Import a CA data broker registry CSV into brokers.yaml."
    )
    parser.add_argument("csv_path", type=Path, help="Path to CA registry CSV")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1]
        / "src/smokescreen/brokers/brokers.yaml",
        help="Output brokers.yaml path",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    report = import_ca_registry(
        args.csv_path,
        existing_yaml_path=args.output,
        output_yaml_path=args.output,
    )
    print(f"CSV rows parsed: {report.csv_rows}")
    print(f"Imported brokers: {report.imported}")
    print(f"Skipped missing-email rows: {len(report.skipped_missing_email)}")
    print(f"Preserved curated brokers: {report.preserved_curated}")
    print(f"Duplicate slug resolutions: {report.duplicate_disambiguations}")
    if report.skipped_missing_email:
        skipped = ", ".join(
            f"line {line} ({name or 'unnamed'})"
            for line, name in report.skipped_missing_email
        )
        print(f"Skipped rows: {skipped}")


if __name__ == "__main__":
    main()
