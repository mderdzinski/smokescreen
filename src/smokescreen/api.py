"""FastAPI dashboard and API for smokescreen."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ValidationError

from smokescreen.brokers.registry import BrokerRegistry
from smokescreen.config import (
    RESTART_FIELDS,
    SENSITIVE_FIELDS,
    Settings,
    load_settings_file,
    save_settings,
)
from smokescreen.models import (
    Broker,
    BrokerStatus,
    PendingWhitelistStatus,
    WhitelistEntry,
    WhitelistSource,
)
from smokescreen.state.machine import InvalidTransition, validate_transition
from smokescreen.state.store import StateStore

app = FastAPI(title="Smokescreen Dashboard", version="0.1.0")

_static_dir = Path(__file__).parent / "static"
if _static_dir.is_dir():
    app.mount("/static", StaticFiles(directory=_static_dir), name="static")

_store: StateStore | None = None
_registry: BrokerRegistry | None = None
_settings: Settings | None = None


def get_store() -> StateStore:
    if _store is None:
        raise RuntimeError("Store not initialized")
    return _store


def get_registry() -> BrokerRegistry:
    if _registry is None:
        raise RuntimeError("Registry not initialized")
    return _registry


def get_settings_obj() -> Settings:
    if _settings is None:
        raise RuntimeError("Settings not initialized")
    return _settings


def init_app(
    store: StateStore,
    registry: BrokerRegistry,
    settings: Settings | None = None,
) -> FastAPI:
    """Initialize the app with dependencies."""
    global _store, _registry, _settings
    _store = store
    _registry = registry
    _settings = settings
    # Sync broker privacy emails to whitelist
    store.sync_registry_whitelist(registry.all())
    return app


def _mask_value(value: str) -> str:
    """Mask a sensitive string, showing first 4 and last 3 chars."""
    if len(value) <= 8:
        return "****"
    return value[:4] + "****" + value[-3:]


# --- Request/Response models ---


class BrokerCreate(BaseModel):
    id: str
    name: str
    domain: str
    privacy_email: str
    aliases: list[str] = []
    notes: str = ""


class BrokerUpdate(BaseModel):
    name: str | None = None
    domain: str | None = None
    privacy_email: str | None = None
    aliases: list[str] | None = None
    notes: str | None = None


class WhitelistCreate(BaseModel):
    broker_id: str
    email: str


class StatsResponse(BaseModel):
    total: int
    by_status: dict[str, int]
    completion_pct: float


# --- Dashboard ---


@app.get("/", response_class=HTMLResponse)
async def dashboard():
    html_path = Path(__file__).parent / "dashboard.html"
    return HTMLResponse(content=html_path.read_text(encoding="utf-8"))


# --- Broker endpoints ---


@app.get("/api/brokers")
async def list_brokers():
    registry = get_registry()
    return [b.model_dump() for b in registry.all()]


@app.post("/api/brokers", status_code=201)
async def create_broker(data: BrokerCreate):
    registry = get_registry()
    if registry.get(data.id) is not None:
        raise HTTPException(400, f"Broker {data.id} already exists")
    broker = Broker(**data.model_dump())
    # Add to registry's internal dict
    registry._brokers[broker.id] = broker
    registry._by_domain[broker.domain] = broker
    for alias in broker.aliases:
        registry._by_domain[alias] = broker
    # Sync whitelist
    store = get_store()
    store.sync_registry_whitelist([broker])
    return broker.model_dump()


@app.put("/api/brokers/{broker_id}")
async def update_broker(broker_id: str, data: BrokerUpdate):
    registry = get_registry()
    broker = registry.get(broker_id)
    if broker is None:
        raise HTTPException(404, f"Broker {broker_id} not found")
    update = data.model_dump(exclude_none=True)
    for k, v in update.items():
        setattr(broker, k, v)
    registry._brokers[broker_id] = broker
    return broker.model_dump()


@app.delete("/api/brokers/{broker_id}", status_code=204)
async def delete_broker(broker_id: str):
    registry = get_registry()
    if registry.get(broker_id) is None:
        raise HTTPException(404, f"Broker {broker_id} not found")
    del registry._brokers[broker_id]


_file_field = File(...)
_form_required = Form(...)
_form_optional = Form("")


@app.post("/api/brokers/import")
async def import_brokers_csv(
    file: UploadFile = _file_field,
    name_col: str = _form_required,
    email_col: str = _form_required,
    domain_col: str = _form_optional,
    id_col: str = _form_optional,
    notes_col: str = _form_optional,
):
    """Import brokers from an uploaded CSV file."""
    import csv
    import io
    import re

    content = await file.read()
    text = content.decode("utf-8")
    reader = csv.DictReader(io.StringIO(text))

    registry = get_registry()
    store = get_store()
    imported = 0
    skipped = 0
    errors: list[str] = []

    def _slugify(t: str) -> str:
        s = t.lower().strip()
        s = re.sub(r"[^\w\s-]", "", s)
        s = re.sub(r"[\s_-]+", "-", s)
        return s.strip("-")

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
            else (email.split("@", 1)[1] if "@" in email else "")
        )
        notes = row[notes_col].strip() if notes_col and row.get(notes_col) else ""

        if not broker_id:
            errors.append(f"Row {row_num}: could not generate ID for '{name}'")
            continue

        if registry.get(broker_id) is not None:
            skipped += 1
            continue

        broker = Broker(
            id=broker_id, name=name, domain=domain, privacy_email=email, notes=notes
        )
        registry._brokers[broker.id] = broker
        registry._by_domain[broker.domain] = broker
        store.sync_registry_whitelist([broker])
        imported += 1

    return {"imported": imported, "skipped": skipped, "errors": errors}


# --- Opt-out record endpoints ---


@app.get("/api/optouts")
async def list_optouts(status: str | None = None):
    store = get_store()
    if status:
        try:
            bs = BrokerStatus(status)
        except ValueError as err:
            raise HTTPException(400, f"Invalid status: {status}") from err
        records = store.list_by_status(bs)
    else:
        records = store.list_all()
    registry = get_registry()
    result = []
    for r in records:
        d = r.model_dump()
        d["created_at"] = r.created_at.isoformat()
        d["updated_at"] = r.updated_at.isoformat()
        broker = registry.get(r.broker_id)
        d["broker_name"] = broker.name if broker else r.broker_id
        d["broker_domain"] = broker.domain if broker else ""
        d["broker_privacy_email"] = broker.privacy_email if broker else ""
        result.append(d)
    return result


@app.post("/api/optouts/{broker_id}/reset")
async def reset_optout(broker_id: str):
    store = get_store()
    record = store.get(broker_id)
    if record is None:
        raise HTTPException(404, f"No record for broker {broker_id}")
    try:
        if record.status != BrokerStatus.PENDING:
            validate_transition(record.status, BrokerStatus.PENDING)
    except InvalidTransition:
        # Force reset for NEEDS_MANUAL
        pass
    record.status = BrokerStatus.PENDING
    record.retries = 0
    record.thread_id = None
    record.last_message_id = None
    record.notes = ""
    record.updated_at = datetime.utcnow()
    store.upsert(record)
    return {"status": "reset", "broker_id": broker_id}


# --- Stats ---


@app.get("/api/stats")
async def get_stats():
    store = get_store()
    records = store.list_all()
    total = len(records)
    by_status: dict[str, int] = {}
    for r in records:
        by_status[r.status.value] = by_status.get(r.status.value, 0) + 1
    completed = by_status.get(BrokerStatus.COMPLETED.value, 0)
    pct = (completed / total * 100) if total > 0 else 0.0
    return StatsResponse(total=total, by_status=by_status, completion_pct=round(pct, 1))


@app.get("/api/stats/extended")
async def get_extended_stats():
    """Return extended statistics for dashboard charts and metrics."""
    store = get_store()
    records = store.list_all()
    total = len(records)

    by_status: dict[str, int] = {}
    completed_records = []
    needs_attention = 0
    recent_activity: list[dict] = []

    for r in records:
        by_status[r.status.value] = by_status.get(r.status.value, 0) + 1
        if r.status == BrokerStatus.COMPLETED:
            completed_records.append(r)
        if r.status in (BrokerStatus.NEEDS_MANUAL, BrokerStatus.FAILED):
            needs_attention += 1

    completed_count = len(completed_records)
    success_rate = round((completed_count / total * 100), 1) if total > 0 else 0.0

    # Average time to completion (in hours)
    avg_completion_hours: float | None = None
    if completed_records:
        durations = [
            (r.updated_at - r.created_at).total_seconds() / 3600.0
            for r in completed_records
        ]
        avg_completion_hours = round(sum(durations) / len(durations), 1)

    # Recent activity: last 5 records by updated_at
    sorted_records = sorted(records, key=lambda r: r.updated_at, reverse=True)[:5]
    registry = get_registry()
    for r in sorted_records:
        broker = registry.get(r.broker_id)
        recent_activity.append(
            {
                "broker_id": r.broker_id,
                "broker_name": broker.name if broker else r.broker_id,
                "status": r.status.value,
                "updated_at": r.updated_at.isoformat(),
            }
        )

    return {
        "total": total,
        "by_status": by_status,
        "completed_count": completed_count,
        "success_rate": success_rate,
        "avg_completion_hours": avg_completion_hours,
        "needs_attention": needs_attention,
        "recent_activity": recent_activity,
    }


# --- Whitelist endpoints ---


@app.get("/api/whitelist")
async def list_whitelist():
    store = get_store()
    entries = store.list_whitelist()
    return [
        {
            "id": e.id,
            "broker_id": e.broker_id,
            "email": e.email,
            "source": e.source.value,
            "added_at": e.added_at.isoformat(),
        }
        for e in entries
    ]


@app.post("/api/whitelist", status_code=201)
async def add_whitelist(data: WhitelistCreate):
    store = get_store()
    entry = WhitelistEntry(
        broker_id=data.broker_id,
        email=data.email,
        source=WhitelistSource.MANUAL,
    )
    result = store.add_whitelist(entry)
    return {
        "id": result.id,
        "broker_id": result.broker_id,
        "email": result.email,
        "source": result.source.value,
        "added_at": result.added_at.isoformat(),
    }


@app.delete("/api/whitelist/{entry_id}", status_code=204)
async def delete_whitelist(entry_id: int):
    store = get_store()
    store.delete_whitelist(entry_id)


# --- Pending whitelist endpoints ---


@app.get("/api/whitelist/pending")
async def list_pending():
    store = get_store()
    entries = store.list_pending_whitelist(PendingWhitelistStatus.PENDING)
    return [
        {
            "id": e.id,
            "broker_id": e.broker_id,
            "email": e.email,
            "message_subject": e.message_subject,
            "message_snippet": e.message_snippet,
            "detected_at": e.detected_at.isoformat(),
            "status": e.status.value,
        }
        for e in entries
    ]


@app.post("/api/whitelist/pending/{entry_id}/approve")
async def approve_pending(entry_id: int):
    store = get_store()
    result = store.approve_pending(entry_id)
    if result is None:
        raise HTTPException(404, f"Pending entry {entry_id} not found")
    return {
        "id": result.id,
        "broker_id": result.broker_id,
        "email": result.email,
        "source": result.source.value,
        "added_at": result.added_at.isoformat(),
    }


@app.post("/api/whitelist/pending/{entry_id}/reject")
async def reject_pending(entry_id: int):
    store = get_store()
    success = store.reject_pending(entry_id)
    if not success:
        raise HTTPException(404, f"Pending entry {entry_id} not found")
    return {"status": "rejected", "id": entry_id}


# --- Settings endpoints ---


class SettingsUpdate(BaseModel):
    model_config = {"extra": "forbid"}

    gmail_credentials_path: str | None = None
    gmail_token_path: str | None = None
    sender_email: str | None = None
    sender_name: str | None = None
    anthropic_api_key: str | None = None
    anthropic_model: str | None = None
    state_backend: str | None = None
    sqlite_path: str | None = None
    firestore_project: str | None = None
    firestore_collection: str | None = None
    identity_docs_dir: str | None = None
    max_retries: int | None = None
    poll_label: str | None = None
    dry_run: bool | None = None
    rerequest_interval_days: int | None = None


@app.get("/api/settings")
async def get_settings_endpoint():
    settings = get_settings_obj()
    data: dict[str, Any] = {}
    for field_name in Settings.model_fields:
        value = getattr(settings, field_name)
        if isinstance(value, Path):
            value = str(value)
        if field_name in SENSITIVE_FIELDS and value:
            value = _mask_value(str(value))
        data[field_name] = value
    return data


@app.put("/api/settings")
async def update_settings(update: SettingsUpdate):
    global _settings
    get_settings_obj()  # ensure initialized

    # Load existing file-based settings
    file_data = load_settings_file()

    # Merge in the new values
    update_dict = update.model_dump(exclude_none=True)
    changed_fields = set(update_dict.keys())
    file_data.update(update_dict)

    # Validate by constructing a new Settings object
    try:
        new_settings = Settings(**file_data)
    except ValidationError as e:
        raise HTTPException(422, detail=e.errors()) from None

    # Persist to disk
    save_settings(file_data)

    # Update in-memory settings
    _settings = new_settings

    restart_required = bool(changed_fields & RESTART_FIELDS)

    return {"status": "saved", "restart_required": restart_required}
