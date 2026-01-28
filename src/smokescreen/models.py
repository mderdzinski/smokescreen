"""Domain models for smokescreen."""

from __future__ import annotations

import enum
from datetime import datetime

from pydantic import BaseModel, Field


class BrokerStatus(str, enum.Enum):
    """States in the opt-out state machine."""

    PENDING = "PENDING"
    INITIAL_SENT = "INITIAL_SENT"
    AWAITING_RESPONSE = "AWAITING_RESPONSE"
    IDENTITY_REQUESTED = "IDENTITY_REQUESTED"
    IDENTITY_SENT = "IDENTITY_SENT"
    COMPLETED = "COMPLETED"
    REJECTED = "REJECTED"
    FAILED = "FAILED"
    NEEDS_MANUAL = "NEEDS_MANUAL"


class ReplyClassification(str, enum.Enum):
    """Classification of a broker's email reply."""

    ACKNOWLEDGMENT = "ACKNOWLEDGMENT"
    IDENTITY_REQUEST = "IDENTITY_REQUEST"
    COMPLETED = "COMPLETED"
    REJECTED = "REJECTED"
    NEEDS_MANUAL = "NEEDS_MANUAL"
    UNRELATED = "UNRELATED"


class Broker(BaseModel):
    """A data broker from the registry."""

    id: str = Field(description="Unique broker identifier (slug)")
    name: str = Field(description="Human-readable broker name")
    domain: str = Field(description="Primary domain")
    privacy_email: str = Field(description="Email address for opt-out/privacy requests")
    aliases: list[str] = Field(default_factory=list, description="Alternative domains")
    notes: str = Field(default="", description="Notes about this broker's process")


class OptOutRecord(BaseModel):
    """Tracks opt-out progress for a single broker."""

    broker_id: str
    status: BrokerStatus = BrokerStatus.PENDING
    retries: int = 0
    thread_id: str | None = None
    last_message_id: str | None = None
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    last_completed_at: datetime | None = None
    notes: str = ""


class EmailMessage(BaseModel):
    """An email message (sent or received)."""

    message_id: str = ""
    thread_id: str = ""
    sender: str = ""
    to: str = ""
    subject: str = ""
    body: str = ""
    date: datetime | None = None
    has_attachments: bool = False


class WhitelistSource(str, enum.Enum):
    """How an email address was added to the whitelist."""

    REGISTRY = "registry"
    MANUAL = "manual"


class PendingWhitelistStatus(str, enum.Enum):
    """Status of a pending whitelist request."""

    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"


class WhitelistEntry(BaseModel):
    """A whitelisted email address for reply authorization."""

    id: int | None = None
    broker_id: str
    email: str
    source: WhitelistSource = WhitelistSource.MANUAL
    added_at: datetime = Field(default_factory=datetime.utcnow)


class PendingWhitelistEntry(BaseModel):
    """A pending whitelist request awaiting human review."""

    id: int | None = None
    broker_id: str | None = None
    email: str
    message_subject: str = ""
    message_snippet: str = ""
    detected_at: datetime = Field(default_factory=datetime.utcnow)
    status: PendingWhitelistStatus = PendingWhitelistStatus.PENDING
