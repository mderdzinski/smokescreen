"""CLI interface for smokescreen."""

from __future__ import annotations

import click
import structlog

from smokescreen.brokers.registry import BrokerRegistry
from smokescreen.config import get_settings
from smokescreen.models import BrokerStatus
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

    creds = get_credentials(settings.gmail_credentials_path, settings.gmail_token_path)
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
    init_app(store, registry)

    click.echo(f"Starting dashboard at http://{host}:{port}")
    uvicorn.run("smokescreen.api:app", host=host, port=port, reload=False)


if __name__ == "__main__":
    cli()
