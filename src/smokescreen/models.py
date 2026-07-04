"""Domain models for smokescreen."""

from __future__ import annotations

import enum
from datetime import UTC, datetime

from pydantic import BaseModel, Field


def utc_now() -> datetime:
    """Return a timezone-aware UTC timestamp."""
    return datetime.now(UTC)


def as_aware_utc(value: datetime) -> datetime:
    """Normalize legacy naive datetimes to timezone-aware UTC."""
    if value.tzinfo is None or value.utcoffset() is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


class BrokerStatus(str, enum.Enum):
    """States in the opt-out state machine."""

    PENDING = "PENDING"
    INITIAL_SENT = "INITIAL_SENT"
    INITIAL_SENT_PINGED = "INITIAL_SENT_PINGED"
    AWAITING_RESPONSE = "AWAITING_RESPONSE"
    AWAITING_RESPONSE_PINGED = "AWAITING_RESPONSE_PINGED"
    INFO_REQUESTED = "INFO_REQUESTED"
    INFO_REQUESTED_PINGED = "INFO_REQUESTED_PINGED"
    FOLLOW_UP_SENT = "FOLLOW_UP_SENT"
    FOLLOW_UP_SENT_PINGED = "FOLLOW_UP_SENT_PINGED"
    COMPLETED = "COMPLETED"
    REJECTED = "REJECTED"
    FAILED = "FAILED"
    NEEDS_MANUAL = "NEEDS_MANUAL"


# Legacy stored status values → current BrokerStatus, for read-time
# backwards compatibility on local/dev stores that predate sm-aa1.
LEGACY_STATUS_ALIASES: dict[str, BrokerStatus] = {
    "IDENTITY_REQUESTED": BrokerStatus.INFO_REQUESTED,
    "IDENTITY_SENT": BrokerStatus.FOLLOW_UP_SENT,
}


def parse_broker_status(raw: str) -> BrokerStatus:
    """Coerce a stored status string into a BrokerStatus.

    Applies read-time compatibility for renamed states; logs a warning when
    a legacy value is coerced so operators know old data is being migrated
    in flight.
    """
    if raw in LEGACY_STATUS_ALIASES:
        mapped = LEGACY_STATUS_ALIASES[raw]
        import structlog

        structlog.get_logger().warning(
            "broker_status_legacy_alias",
            stored=raw,
            mapped_to=mapped.value,
        )
        return mapped
    return BrokerStatus(raw)


class ReplyClassification(str, enum.Enum):
    """Classification of a broker's email reply."""

    ACKNOWLEDGMENT = "ACKNOWLEDGMENT"
    INFO_REQUEST = "INFO_REQUEST"
    COMPLETED = "COMPLETED"
    REJECTED = "REJECTED"
    NEEDS_MANUAL = "NEEDS_MANUAL"
    UNRELATED = "UNRELATED"


class VerificationField(str, enum.Enum):
    """Fields a broker can request for identity verification."""

    HOME_ADDRESS = "home_address"
    PHONE_NUMBER = "phone_number"
    EMAIL_ALIAS = "email_alias"
    DATE_OF_BIRTH = "date_of_birth"
    LAST_FOUR_SSN = "last_four_ssn"
    EMPLOYER_NAME = "employer_name"
    DOCUMENTS = "documents"
    OTHER = "other"


class ReplyAnalysis(BaseModel):
    """Structured classifier result for a broker reply."""

    classification: ReplyClassification
    requested_fields: list[VerificationField] = Field(default_factory=list)
    other_details: str = ""


class VerificationAddress(BaseModel):
    """One home address used only when a broker explicitly requests it."""

    street: str = ""
    city: str = ""
    state: str = ""
    zip: str = ""
    country: str = ""


class VerificationProfile(BaseModel):
    """Optional verification details stored separately from runtime settings."""

    home_addresses: list[VerificationAddress] = Field(default_factory=list)
    phone_numbers: list[str] = Field(default_factory=list)
    email_aliases: list[str] = Field(default_factory=list)
    date_of_birth: str | None = None
    last_four_ssn: str | None = None
    employer_name: str | None = None
    additional_notes: str | None = None


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
    previous_status: BrokerStatus | None = None
    retries: int = 0
    thread_id: str | None = None
    last_message_id: str | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    last_completed_at: datetime | None = None
    notes: str = ""
    requested_fields: list[str] = Field(default_factory=list)
    missing_fields: list[str] = Field(default_factory=list)
    requested_other_details: str = ""


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
    added_at: datetime = Field(default_factory=utc_now)


class PendingWhitelistEntry(BaseModel):
    """A pending whitelist request awaiting human review."""

    id: int | None = None
    broker_id: str | None = None
    email: str
    message_subject: str = ""
    message_snippet: str = ""
    detected_at: datetime = Field(default_factory=utc_now)
    status: PendingWhitelistStatus = PendingWhitelistStatus.PENDING
