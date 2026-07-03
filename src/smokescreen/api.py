"""FastAPI dashboard and API for smokescreen."""

from __future__ import annotations

import os
import re
from contextlib import suppress
from json import JSONDecodeError
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from google.auth.exceptions import GoogleAuthError
from pydantic import BaseModel, ValidationError

from smokescreen.brokers.registry import BrokerRegistry
from smokescreen.config import (
    RESTART_FIELDS,
    SENSITIVE_FIELDS,
    Settings,
    load_settings_file,
    save_settings,
)
from smokescreen.identity_docs import (
    GCSIdentityDocumentStore,
    IdentityDocumentStorageNotConfigured,
    InvalidIdentityDocument,
    configured_identity_document_store,
)
from smokescreen.models import (
    Broker,
    BrokerStatus,
    PendingWhitelistStatus,
    WhitelistEntry,
    WhitelistSource,
    as_aware_utc,
    utc_now,
)
from smokescreen.state.machine import InvalidTransition, validate_transition
from smokescreen.state.store import StateStore
from smokescreen.version import get_app_version

app = FastAPI(title="Smokescreen Dashboard", version="0.1.0")

_static_dir = Path(__file__).parent / "static"
if _static_dir.is_dir():
    app.mount("/static", StaticFiles(directory=_static_dir), name="static")

_web_dist_dir = Path(__file__).parent / "web_dist"
_web_assets_dir = _web_dist_dir / "assets"
if _web_assets_dir.is_dir():
    app.mount("/assets", StaticFiles(directory=_web_assets_dir), name="app-assets")

_store: StateStore | None = None
_registry: BrokerRegistry | None = None
_settings: Settings | None = None
ATTENTION_STATUSES = {
    BrokerStatus.NEEDS_MANUAL,
    BrokerStatus.FAILED,
    BrokerStatus.REJECTED,
}


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
    id: str | None = None
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


class IdentityDocumentResponse(BaseModel):
    id: str
    kind: str
    filename: str
    size: int
    uploaded_at: str


class StatsResponse(BaseModel):
    total: int
    by_status: dict[str, int]
    completion_pct: float


class OutreachRequest(BaseModel):
    broker_ids: list[str] | None = None


class BrokerSelectionsBody(BaseModel):
    enabled_broker_ids: list[str]


class BrokerSelectionsResponse(BaseModel):
    enabled_broker_ids: list[str]


GMAIL_CREDENTIALS_REQUIRED_DETAIL = {
    "code": "gmail_credentials_required",
    "message": (
        "Connect Gmail before sending outreach, or enable dry run to prepare "
        "the batch without sending email."
    ),
}


def _slugify(text: str) -> str:
    slug = text.lower().strip()
    slug = re.sub(r"[^\w\s-]", "", slug)
    slug = re.sub(r"[\s_-]+", "-", slug)
    return slug.strip("-")


def _unique_broker_id(registry: BrokerRegistry, preferred: str) -> str:
    base = _slugify(preferred)
    if not base:
        raise HTTPException(400, "Broker name must include letters or numbers")
    broker_id = base
    suffix = 2
    while registry.get(broker_id) is not None:
        broker_id = f"{base}-{suffix}"
        suffix += 1
    return broker_id


def _detect_csv_column(
    headers: list[str],
    provided: str,
    candidates: tuple[str, ...],
    label: str,
) -> str:
    if provided:
        return provided
    normalized = {
        header.strip().lower().replace(" ", "_"): header for header in headers
    }
    for candidate in candidates:
        if candidate in normalized:
            return normalized[candidate]
    raise HTTPException(
        400,
        f"Could not find a {label} column. Use advanced import mapping to choose one.",
    )


def _detect_optional_csv_column(
    headers: list[str],
    provided: str,
    candidates: tuple[str, ...],
) -> str:
    if provided:
        return provided
    normalized = {
        header.strip().lower().replace(" ", "_"): header for header in headers
    }
    for candidate in candidates:
        if candidate in normalized:
            return normalized[candidate]
    return ""


# --- Dashboard ---


def _react_index_response() -> HTMLResponse:
    index_path = _web_dist_dir / "index.html"
    if not index_path.is_file():
        raise HTTPException(
            503,
            "React app has not been built. Run `npm --prefix web run build` first.",
        )
    return HTMLResponse(content=index_path.read_text(encoding="utf-8"))


@app.get("/", response_class=HTMLResponse)
async def dashboard():
    return _react_index_response()


@app.get("/app", include_in_schema=False)
async def react_app_redirect():
    return RedirectResponse(url="/")


@app.get("/app/{path:path}", include_in_schema=False)
async def react_app(path: str):
    target = f"/{path.lstrip('/')}" if path else "/"
    return RedirectResponse(url=target)


# --- Broker endpoints ---


@app.get("/api/brokers")
async def list_brokers():
    registry = get_registry()
    return [b.model_dump() for b in registry.all()]


@app.post("/api/brokers", status_code=201)
async def create_broker(data: BrokerCreate):
    registry = get_registry()
    provided_id = data.id.strip() if data.id else ""
    broker_id = provided_id or _unique_broker_id(registry, data.name)
    if registry.get(broker_id) is not None:
        raise HTTPException(400, "That broker is already in your list")
    broker = Broker(**{**data.model_dump(exclude={"id"}), "id": broker_id})
    registry.add(broker)
    # Sync whitelist
    store = get_store()
    store.sync_registry_whitelist([broker])
    return broker.model_dump()


# --- Broker selections ---
# NOTE: These must be declared BEFORE the /api/brokers/{broker_id} routes so
# FastAPI resolves the concrete "selections" path first; otherwise the path
# parameter route swallows /api/brokers/selections as broker_id="selections".


@app.get("/api/brokers/selections", response_model=BrokerSelectionsResponse)
async def get_broker_selections() -> BrokerSelectionsResponse:
    """Return the persisted list of broker IDs enabled for outreach."""
    return BrokerSelectionsResponse(
        enabled_broker_ids=get_store().list_enabled_brokers()
    )


@app.put("/api/brokers/selections", response_model=BrokerSelectionsResponse)
async def put_broker_selections(body: BrokerSelectionsBody) -> BrokerSelectionsResponse:
    """Persist the list of broker IDs enabled for outreach.

    Unknown IDs (not in the current registry) are rejected so users cannot
    quietly enable a broker that will silently do nothing.
    """
    registry = get_registry()
    unknown = [
        broker_id
        for broker_id in body.enabled_broker_ids
        if broker_id.strip() and registry.get(broker_id.strip()) is None
    ]
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown broker IDs: {', '.join(sorted(set(unknown)))}",
        )
    stored = get_store().set_enabled_brokers(body.enabled_broker_ids)
    return BrokerSelectionsResponse(enabled_broker_ids=stored)


@app.put("/api/brokers/{broker_id}")
async def update_broker(broker_id: str, data: BrokerUpdate):
    registry = get_registry()
    broker = registry.get(broker_id)
    if broker is None:
        raise HTTPException(404, f"Broker {broker_id} not found")
    update = data.model_dump(exclude_none=True)
    broker = broker.model_copy(update=update)
    registry.update(broker_id, broker)
    store = get_store()
    store.sync_registry_whitelist([broker])
    return broker.model_dump()


@app.delete("/api/brokers/{broker_id}", status_code=204)
async def delete_broker(broker_id: str):
    registry = get_registry()
    if registry.get(broker_id) is None:
        raise HTTPException(404, f"Broker {broker_id} not found")
    registry.delete(broker_id)


_file_field = File(...)
_form_optional = Form("")


@app.post("/api/brokers/import")
async def import_brokers_csv(
    file: UploadFile = _file_field,
    name_col: str = _form_optional,
    email_col: str = _form_optional,
    domain_col: str = _form_optional,
    id_col: str = _form_optional,
    notes_col: str = _form_optional,
):
    """Import brokers from an uploaded CSV file."""
    import csv
    import io

    content = await file.read()
    text = content.decode("utf-8")
    reader = csv.DictReader(io.StringIO(text))
    headers = reader.fieldnames or []
    name_col = _detect_csv_column(
        headers,
        name_col.strip(),
        ("name", "company", "company_name", "broker", "broker_name"),
        "company name",
    )
    email_col = _detect_csv_column(
        headers,
        email_col.strip(),
        (
            "email",
            "privacy_email",
            "privacy_contact",
            "contact_email",
            "opt_out_email",
            "opt-out_email",
        ),
        "contact email",
    )
    domain_col = _detect_optional_csv_column(
        headers,
        domain_col.strip(),
        ("domain", "website", "site", "url", "company_domain"),
    )
    id_col = _detect_optional_csv_column(
        headers, id_col.strip(), ("id", "broker_id", "slug")
    )
    notes_col = _detect_optional_csv_column(
        headers, notes_col.strip(), ("notes", "note", "details")
    )

    registry = get_registry()
    store = get_store()
    imported = 0
    skipped = 0
    errors: list[str] = []

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
        registry.add(broker)
        store.sync_registry_whitelist([broker])
        imported += 1

    return {"imported": imported, "skipped": skipped, "errors": errors}


# --- Opt-out record endpoints ---


@app.get("/api/optouts")
async def list_optouts(status: str | None = None):
    store = get_store()
    if status:
        normalized_status = status.strip().upper().replace("-", "_")
        if normalized_status == "NEEDS_ATTENTION":
            records = [
                record
                for record in store.list_all()
                if record.status in ATTENTION_STATUSES
            ]
        else:
            try:
                bs = BrokerStatus(normalized_status)
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
        # Force reset so human-reviewed attention states can be retried.
        pass
    record.status = BrokerStatus.PENDING
    record.retries = 0
    record.thread_id = None
    record.last_message_id = None
    record.notes = ""
    record.updated_at = utc_now()
    store.upsert(record)
    return {"status": "reset", "broker_id": broker_id}


@app.post("/api/optouts/{broker_id}/handled")
async def mark_optout_handled(broker_id: str):
    store = get_store()
    record = store.get(broker_id)
    if record is None:
        raise HTTPException(404, f"No record for broker {broker_id}")
    if record.status not in ATTENTION_STATUSES:
        raise HTTPException(400, f"Broker {broker_id} does not need attention")
    with suppress(InvalidTransition):
        validate_transition(record.status, BrokerStatus.COMPLETED)
    now = utc_now()
    record.status = BrokerStatus.COMPLETED
    record.last_completed_at = now
    record.updated_at = now
    store.upsert(record)
    return {"status": "handled", "broker_id": broker_id}


# --- Outreach ---


@app.post("/api/outreach")
async def run_outreach_endpoint(request: OutreachRequest):
    settings = get_settings_obj()
    registry = get_registry()
    selected_ids = registry.ids() if request.broker_ids is None else request.broker_ids
    selected_brokers = []

    for broker_id in selected_ids:
        broker = registry.get(broker_id)
        if broker is None:
            raise HTTPException(404, f"Broker {broker_id} not found")
        selected_brokers.append(broker)

    gmail = None
    if not settings.dry_run:
        from smokescreen.email.client import GmailClient
        from smokescreen.email.oauth import get_credentials

        try:
            credentials = get_credentials(
                settings.gmail_credentials_path,
                settings.gmail_token_path,
                credentials_json=settings.gmail_credentials_json,
                token_json=settings.gmail_token_json,
                interactive=settings.gmail_oauth_interactive,
            )
            gmail = GmailClient(credentials)
        except (
            FileNotFoundError,
            GoogleAuthError,
            JSONDecodeError,
            RuntimeError,
            ValueError,
        ) as exc:
            raise HTTPException(
                status_code=400,
                detail=GMAIL_CREDENTIALS_REQUIRED_DETAIL,
            ) from exc

    from smokescreen.jobs.outreach import run_outreach

    selected_registry = (
        registry if request.broker_ids is None else BrokerRegistry(selected_brokers)
    )
    # Explicit broker_ids (used by the onboarding "Send first batch" flow)
    # bypasses the persisted enable-gate for that one-shot send; the
    # scheduled outreach path still gates on selections.
    explicit_filter = request.broker_ids is not None
    processed = run_outreach(
        settings,
        selected_registry,
        get_store(),
        gmail,
        enforce_selections=not explicit_filter,
    )
    return {
        "status": "sent",
        "processed": processed,
        "processed_count": len(processed),
        "dry_run": settings.dry_run,
    }


# --- Stats ---


@app.get("/api/version")
async def get_version() -> dict[str, str]:
    """Return the running smokescreen version for the dashboard shell."""
    return {"version": get_app_version()}


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
        if r.status in ATTENTION_STATUSES:
            needs_attention += 1

    completed_count = len(completed_records)
    success_rate = round((completed_count / total * 100), 1) if total > 0 else 0.0

    # Average time to completion (in hours)
    avg_completion_hours: float | None = None
    if completed_records:
        durations = [
            (as_aware_utc(r.updated_at) - as_aware_utc(r.created_at)).total_seconds()
            / 3600.0
            for r in completed_records
        ]
        avg_completion_hours = round(sum(durations) / len(durations), 1)

    # Recent activity: last 5 records by updated_at
    sorted_records = sorted(
        records, key=lambda r: as_aware_utc(r.updated_at), reverse=True
    )[:5]
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


# Settings fields the operator can control via env vars in a Cloud Run
# deployment. When any of these are set in the process environment we surface
# them as read-only in the dashboard and reject PUT /api/settings writes.
ENV_CONTROLLED_FIELDS: tuple[str, ...] = (
    "sender_email",
    "sender_name",
    "anthropic_api_key",
    "ai_provider",
    "gemini_model",
    "gemini_project",
    "gemini_location",
    "rerequest_interval_days",
    "state_timeout_days",
)


def _env_var_for(field: str) -> str:
    return f"SMOKESCREEN_{field.upper()}"


def _field_from_env(field: str) -> bool:
    """Return True when a settings field is populated from the process env."""
    return bool(os.environ.get(_env_var_for(field), "").strip())


FRIENDLY_SETTINGS_FIELDS: tuple[str, ...] = (
    "sender_email",
    "sender_name",
    "anthropic_api_key",
    "rerequest_interval_days",
    "state_timeout_days",
)

ADVANCED_SETTINGS_FIELDS: tuple[str, ...] = (
    "ai_provider",
    "max_retries",
    "poll_label",
    "dry_run",
    "anthropic_model",
    "gemini_model",
    "gemini_project",
    "gemini_location",
)


class SettingsUpdate(BaseModel):
    model_config = {"extra": "forbid"}

    gmail_credentials_json: str | None = None
    gmail_token_json: str | None = None
    sender_email: str | None = None
    sender_name: str | None = None
    ai_provider: str | None = None
    anthropic_api_key: str | None = None
    anthropic_model: str | None = None
    gemini_model: str | None = None
    gemini_project: str | None = None
    gemini_location: str | None = None
    max_retries: int | None = None
    poll_label: str | None = None
    dry_run: bool | None = None
    rerequest_interval_days: int | None = None
    state_timeout_days: int | None = None


def _settings_response(
    settings: Settings, field_names: tuple[str, ...]
) -> dict[str, Any]:
    data: dict[str, Any] = {}
    for field_name in field_names:
        value = getattr(settings, field_name)
        if isinstance(value, Path):
            value = str(value)
        if field_name in SENSITIVE_FIELDS and value:
            value = _mask_value(str(value))
        data[field_name] = value
    if field_names == FRIENDLY_SETTINGS_FIELDS:
        identity_configured = bool(
            settings.sender_name.strip() and settings.sender_email.strip()
        )
        gmail_token_available = bool(
            settings.gmail_token_json.strip() or settings.gmail_token_path.exists()
        )
        gmail_credentials_available = bool(
            settings.gmail_credentials_json.strip()
            or settings.gmail_credentials_path.exists()
        )
        data["identity_configured"] = identity_configured
        data["gmail_token_available"] = gmail_token_available
        data["gmail_credentials_available"] = gmail_credentials_available
        data["gmail_connected"] = gmail_token_available
        data["gmail_connected_email"] = (
            settings.sender_email if gmail_token_available else ""
        )
        data["sender_email_from_env"] = _field_from_env("sender_email")
        data["sender_name_from_env"] = _field_from_env("sender_name")
        data["rerequest_interval_days_from_env"] = _field_from_env(
            "rerequest_interval_days"
        )
        data["state_timeout_days_from_env"] = _field_from_env("state_timeout_days")
        data["ai_provider"] = settings.ai_provider
        data["anthropic_key_from_secret"] = _field_from_env("anthropic_api_key")
        data["gmail_configured"] = gmail_token_available and gmail_credentials_available
        data["gemini_model"] = settings.gemini_model
        data["identity_bucket_configured"] = bool(settings.identity_bucket.strip())
        data["identity_documents"] = [
            document.to_api() for document in _list_identity_documents(settings)
        ]
    return data


def _identity_document_store(settings: Settings) -> GCSIdentityDocumentStore:
    return configured_identity_document_store(settings)


def _list_identity_documents(settings: Settings) -> list:
    if not settings.identity_bucket.strip():
        return []
    return _identity_document_store(settings).list_documents()


def _identity_document_http_error(error: Exception) -> HTTPException:
    if isinstance(error, IdentityDocumentStorageNotConfigured):
        return HTTPException(status_code=503, detail=str(error))
    if isinstance(error, InvalidIdentityDocument):
        return HTTPException(status_code=400, detail=str(error))
    return HTTPException(status_code=500, detail="Identity document storage failed")


@app.get("/api/settings")
async def get_settings_endpoint():
    return _settings_response(get_settings_obj(), FRIENDLY_SETTINGS_FIELDS)


@app.get("/api/settings/advanced")
async def get_advanced_settings_endpoint():
    return _settings_response(get_settings_obj(), ADVANCED_SETTINGS_FIELDS)


@app.put("/api/settings")
async def update_settings(update: SettingsUpdate):
    global _settings
    get_settings_obj()  # ensure initialized

    # Load existing file-based settings
    file_data = load_settings_file()

    # Merge in the new values
    update_dict = update.model_dump(exclude_none=True)
    changed_fields = set(update_dict.keys())

    env_locked = sorted(
        field
        for field in changed_fields
        if field in ENV_CONTROLLED_FIELDS and _field_from_env(field)
    )
    if env_locked:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "env_controlled_fields",
                "message": (
                    "These fields are configured from the deployment "
                    "environment and cannot be edited from the dashboard. "
                    "Update your Terraform variables and redeploy."
                ),
                "fields": env_locked,
            },
        )

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


@app.get("/api/identity-documents", response_model=list[IdentityDocumentResponse])
async def list_identity_documents_endpoint():
    settings = get_settings_obj()
    try:
        return [document.to_api() for document in _list_identity_documents(settings)]
    except Exception as error:
        raise _identity_document_http_error(error) from error


@app.post("/api/identity-documents/{kind}", response_model=IdentityDocumentResponse)
async def upload_identity_document(kind: str, file: UploadFile = _file_field):
    settings = get_settings_obj()
    try:
        document = _identity_document_store(settings).upload_document(
            kind=kind,
            filename=file.filename or "",
            content_type=file.content_type,
            file_obj=file.file,
        )
        return document.to_api()
    except Exception as error:
        raise _identity_document_http_error(error) from error
    finally:
        await file.close()


@app.delete("/api/identity-documents/{kind}")
async def delete_identity_document(kind: str):
    settings = get_settings_obj()
    try:
        deleted = _identity_document_store(settings).delete_document(kind)
    except Exception as error:
        raise _identity_document_http_error(error) from error
    if not deleted:
        raise HTTPException(404, f"Identity document {kind} not found")
    return {"status": "deleted", "kind": kind}


@app.get("/{path:path}", response_class=HTMLResponse, include_in_schema=False)
async def react_app_fallback(path: str):
    if path == "old-dashboard" or path.startswith(
        ("api/", "assets/", "static/", "old-dashboard/")
    ):
        raise HTTPException(404, "Not found")
    return _react_index_response()
