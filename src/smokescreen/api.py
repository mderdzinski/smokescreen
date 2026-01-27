"""FastAPI dashboard and API for smokescreen."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from smokescreen.brokers.registry import BrokerRegistry
from smokescreen.models import (
    Broker,
    BrokerStatus,
    PendingWhitelistStatus,
    WhitelistEntry,
    WhitelistSource,
)
from smokescreen.state.machine import InvalidTransition, validate_transition
from smokescreen.state.sqlite import SQLiteStore

app = FastAPI(title="Smokescreen Dashboard", version="0.1.0")

_store: SQLiteStore | None = None
_registry: BrokerRegistry | None = None


def get_store() -> SQLiteStore:
    if _store is None:
        raise RuntimeError("Store not initialized")
    return _store


def get_registry() -> BrokerRegistry:
    if _registry is None:
        raise RuntimeError("Registry not initialized")
    return _registry


def init_app(store: SQLiteStore, registry: BrokerRegistry) -> FastAPI:
    """Initialize the app with dependencies."""
    global _store, _registry
    _store = store
    _registry = registry
    # Sync broker privacy emails to whitelist
    store.sync_registry_whitelist(registry.all())
    return app


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
