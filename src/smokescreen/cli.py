"""CLI interface for smokescreen."""

from __future__ import annotations

import csv
import re
from pathlib import Path

import click
import structlog

from smokescreen.brokers.registry import BrokerRegistry
from smokescreen.config import get_settings
from smokescreen.models import Broker, BrokerStatus
from smokescreen.state.sqlite import SQLiteStore

log = structlog.get_logger()


def _get_store(settings):
    if settings.state_backend == "sqlite":
        return SQLiteStore(settings.sqlite_path)
    elif settings.state_backend == "firestore":
        from smokescreen.state.firestore import FirestoreStore

        return FirestoreStore(settings.firestore_project, settings.firestore_collection)
    else:
        raise click.ClickException(f"Unknown state backend: {settings.state_backend}")


def _get_gmail(settings):
    from smokescreen.email.client import GmailClient
    from smokescreen.email.oauth import get_credentials

    creds = get_credentials(
        settings.gmail_credentials_path,
        settings.gmail_token_path,
        credentials_json=settings.gmail_credentials_json,
        token_json=settings.gmail_token_json,
        interactive=settings.gmail_oauth_interactive,
    )
    return GmailClient(creds)


@click.group()
@click.option("--dry-run", is_flag=True, help="Don't send emails or update state")
@click.pass_context
def cli(ctx, dry_run: bool) -> None:
    """Smokescreen: data broker opt-out automation."""
    structlog.configure(
        processors=[
            structlog.dev.ConsoleRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(0),
    )
    overrides = {}
    if dry_run:
        overrides["dry_run"] = True
    ctx.ensure_object(dict)
    ctx.obj["settings"] = get_settings(**overrides)


@cli.command()
@click.pass_context
def outreach(ctx) -> None:
    """Send initial opt-out emails to all pending brokers."""
    settings = ctx.obj["settings"]
    registry = BrokerRegistry.from_yaml()
    store = _get_store(settings)

    gmail = None
    if not settings.dry_run:
        gmail = _get_gmail(settings)

    from smokescreen.jobs.outreach import run_outreach

    processed = run_outreach(settings, registry, store, gmail)
    click.echo(f"Processed {len(processed)} brokers: {', '.join(processed) or 'none'}")


@cli.command()
@click.pass_context
def poll(ctx) -> None:
    """Poll inbox for broker replies and respond."""
    settings = ctx.obj["settings"]
    registry = BrokerRegistry.from_yaml()
    store = _get_store(settings)

    gmail = None
    if not settings.dry_run:
        gmail = _get_gmail(settings)

    from smokescreen.jobs.poll import run_poll

    processed = run_poll(settings, registry, store, gmail)
    click.echo(f"Processed {len(processed)} replies")


@cli.command()
@click.pass_context
def status(ctx) -> None:
    """Show current status of all tracked brokers."""
    settings = ctx.obj["settings"]
    store = _get_store(settings)
    records = store.list_all()

    if not records:
        click.echo("No brokers tracked yet. Run 'outreach' to start.")
        return

    # Group by status
    by_status: dict[str, list[str]] = {}
    for r in records:
        by_status.setdefault(r.status.value, []).append(r.broker_id)

    for status_val, broker_ids in sorted(by_status.items()):
        click.echo(f"\n{status_val} ({len(broker_ids)}):")
        for bid in sorted(broker_ids):
            click.echo(f"  - {bid}")


@cli.command()
@click.argument("broker_id")
@click.pass_context
def reset(ctx, broker_id: str) -> None:
    """Reset a broker back to PENDING state."""
    settings = ctx.obj["settings"]
    store = _get_store(settings)
    record = store.get(broker_id)

    if record is None:
        click.echo(f"No record found for {broker_id}")
        return

    record.status = BrokerStatus.PENDING
    record.retries = 0
    record.thread_id = None
    record.last_message_id = None
    record.notes = ""
    store.upsert(record)
    click.echo(f"Reset {broker_id} to PENDING")


def _slugify(text: str) -> str:
    """Convert text to a URL-safe slug."""
    s = text.lower().strip()
    s = re.sub(r"[^\w\s-]", "", s)
    s = re.sub(r"[\s_-]+", "-", s)
    return s.strip("-")


def _domain_from_email(email: str) -> str:
    """Extract domain from an email address."""
    if "@" in email:
        return email.split("@", 1)[1]
    return ""


@cli.command("import-csv")
@click.argument("file", type=click.Path(exists=True, path_type=Path))
@click.option("--name-col", required=True, help="Column name for broker name")
@click.option("--email-col", required=True, help="Column name for privacy email")
@click.option(
    "--domain-col",
    default=None,
    help="Column name for domain (auto-detected from email if omitted)",
)
@click.option(
    "--id-col",
    default=None,
    help="Column name for broker ID (slugified name if omitted)",
)
@click.option("--notes-col", default=None, help="Column name for notes")
@click.pass_context
def import_csv(
    ctx,
    file: Path,
    name_col: str,
    email_col: str,
    domain_col: str | None,
    id_col: str | None,
    notes_col: str | None,
) -> None:
    """Import brokers from a CSV file."""
    settings = ctx.obj["settings"]
    registry = BrokerRegistry.from_yaml()
    store = _get_store(settings)

    imported, skipped, errors = _run_csv_import(
        file, registry, store, name_col, email_col, domain_col, id_col, notes_col
    )

    click.echo(f"Imported: {imported}")
    click.echo(f"Skipped (duplicates): {skipped}")
    if errors:
        click.echo(f"Errors: {len(errors)}")
        for err in errors:
            click.echo(f"  - {err}")


def _run_csv_import(
    file: Path,
    registry: BrokerRegistry,
    store: SQLiteStore,
    name_col: str,
    email_col: str,
    domain_col: str | None,
    id_col: str | None,
    notes_col: str | None,
) -> tuple[int, int, list[str]]:
    """Parse CSV and import brokers. Returns (imported, skipped, errors)."""
    imported = 0
    skipped = 0
    errors: list[str] = []

    with open(file, newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        for row_num, row in enumerate(reader, start=2):
            name = row.get(name_col, "").strip()
            email = row.get(email_col, "").strip()

            if not name or not email:
                errors.append(f"Row {row_num}: missing name or email")
                continue

            broker_id = (
                _slugify(row[id_col].strip())
                if id_col and row.get(id_col)
                else _slugify(name)
            )
            domain = (
                row[domain_col].strip()
                if domain_col and row.get(domain_col)
                else _domain_from_email(email)
            )
            notes = row[notes_col].strip() if notes_col and row.get(notes_col) else ""

            if not broker_id:
                errors.append(f"Row {row_num}: could not generate ID for '{name}'")
                continue

            if registry.get(broker_id) is not None:
                skipped += 1
                continue

            broker = Broker(
                id=broker_id,
                name=name,
                domain=domain,
                privacy_email=email,
                notes=notes,
            )
            registry._brokers[broker.id] = broker
            registry._by_domain[broker.domain] = broker
            store.sync_registry_whitelist([broker])
            imported += 1

    return imported, skipped, errors


@cli.command()
@click.option("--host", default="127.0.0.1", help="Bind address")
@click.option("--port", default=8000, type=int, help="Port number")
@click.pass_context
def serve(ctx, host: str, port: int) -> None:
    """Start the dashboard web server."""
    import uvicorn

    from smokescreen.api import init_app

    settings = ctx.obj["settings"]
    registry = BrokerRegistry.from_yaml()
    store = _get_store(settings)
    init_app(store, registry, settings)

    click.echo(f"Starting dashboard at http://{host}:{port}")
    uvicorn.run("smokescreen.api:app", host=host, port=port, reload=False)


if __name__ == "__main__":
    cli()
