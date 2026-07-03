"""Identity document storage backed by Google Cloud Storage."""

from __future__ import annotations

import hashlib
import re
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import BinaryIO

import structlog
from google.cloud import storage

from smokescreen.config import Settings

log = structlog.get_logger()

IDENTITY_DOCUMENT_KINDS: tuple[str, ...] = (
    "government_id",
    "proof_of_address",
    "ssn_last4",
)

ALLOWED_CONTENT_TYPES: dict[str, tuple[str, ...]] = {
    "application/pdf": (".pdf",),
    "image/jpeg": (".jpg", ".jpeg"),
    "image/png": (".png",),
}


class IdentityDocumentError(RuntimeError):
    """Base error for identity document storage failures."""


class IdentityDocumentStorageNotConfigured(IdentityDocumentError):
    """Raised when document storage is requested without a configured bucket."""


class InvalidIdentityDocument(IdentityDocumentError):
    """Raised for invalid document kind, name, or content type."""


@dataclass(frozen=True)
class IdentityDocument:
    id: str
    kind: str
    filename: str
    size: int
    uploaded_at: datetime

    def to_api(self) -> dict[str, str | int]:
        return {
            "id": self.id,
            "kind": self.kind,
            "filename": self.filename,
            "size": self.size,
            "uploaded_at": self.uploaded_at.isoformat().replace("+00:00", "Z"),
        }


def validate_identity_document_kind(kind: str) -> str:
    normalized = kind.strip().lower()
    if normalized not in IDENTITY_DOCUMENT_KINDS:
        allowed = ", ".join(IDENTITY_DOCUMENT_KINDS)
        raise InvalidIdentityDocument(
            f"Unsupported identity document kind: {kind}. Allowed: {allowed}."
        )
    return normalized


def validate_identity_document_upload(
    filename: str, content_type: str | None
) -> tuple[str, str]:
    safe_name = _safe_filename(filename)
    normalized_type = (content_type or "").split(";")[0].strip().lower()
    suffix = Path(safe_name).suffix.lower()

    if normalized_type not in ALLOWED_CONTENT_TYPES:
        raise InvalidIdentityDocument(
            "Identity documents must be PDF, JPG, or PNG files."
        )
    if suffix not in ALLOWED_CONTENT_TYPES[normalized_type]:
        raise InvalidIdentityDocument(
            "File extension must match PDF, JPG, or PNG content type."
        )
    return safe_name, normalized_type


class GCSIdentityDocumentStore:
    """Store one optional identity document per kind under a per-user prefix."""

    def __init__(
        self, settings: Settings, client: storage.Client | None = None
    ) -> None:
        if not settings.identity_bucket.strip():
            raise IdentityDocumentStorageNotConfigured(
                "SMOKESCREEN_IDENTITY_BUCKET is not configured."
            )
        self._settings = settings
        self._client = client or storage.Client()
        self._bucket = self._client.bucket(settings.identity_bucket)

    def list_documents(self) -> list[IdentityDocument]:
        docs = [
            self._document_from_blob(blob)
            for blob in self._bucket.list_blobs(prefix=self._prefix())
        ]
        docs = [doc for doc in docs if doc is not None]
        return sorted(docs, key=lambda doc: IDENTITY_DOCUMENT_KINDS.index(doc.kind))

    def upload_document(
        self,
        *,
        kind: str,
        filename: str,
        content_type: str | None,
        file_obj: BinaryIO,
    ) -> IdentityDocument:
        normalized_kind = validate_identity_document_kind(kind)
        safe_name, normalized_type = validate_identity_document_upload(
            filename, content_type
        )
        self.delete_document(normalized_kind, missing_ok=True)

        uploaded_at = datetime.now(UTC)
        blob = self._bucket.blob(f"{self._kind_prefix(normalized_kind)}/{safe_name}")
        blob.metadata = {
            "kind": normalized_kind,
            "filename": safe_name,
            "uploaded_at": uploaded_at.isoformat(),
        }
        blob.upload_from_file(file_obj, rewind=True, content_type=normalized_type)
        blob.reload()
        return self._document_from_blob(blob) or IdentityDocument(
            id=normalized_kind,
            kind=normalized_kind,
            filename=safe_name,
            size=0,
            uploaded_at=uploaded_at,
        )

    def delete_document(self, kind: str, *, missing_ok: bool = False) -> bool:
        normalized_kind = validate_identity_document_kind(kind)
        deleted = False
        for blob in self._bucket.list_blobs(prefix=self._kind_prefix(normalized_kind)):
            blob.delete()
            deleted = True
        if not deleted and not missing_ok:
            return False
        return deleted

    def download_documents(self, destination: Path) -> list[Path]:
        paths: list[Path] = []
        for blob in self._bucket.list_blobs(prefix=self._prefix()):
            doc = self._document_from_blob(blob)
            if doc is None:
                continue
            path = destination / f"{doc.kind}-{_safe_filename(doc.filename)}"
            blob.download_to_filename(str(path))
            paths.append(path)
        return paths

    def _prefix(self) -> str:
        user = self._settings.sender_email.strip().lower() or "unconfigured"
        digest = hashlib.sha256(user.encode("utf-8")).hexdigest()[:24]
        return f"users/{digest}/identity-documents/"

    def _kind_prefix(self, kind: str) -> str:
        return f"{self._prefix()}{kind}/"

    def _document_from_blob(self, blob: storage.Blob) -> IdentityDocument | None:
        if blob.name.endswith("/"):
            return None
        metadata = blob.metadata or {}
        kind = metadata.get("kind") or _kind_from_name(blob.name)
        if kind not in IDENTITY_DOCUMENT_KINDS:
            return None
        filename = metadata.get("filename") or Path(blob.name).name
        uploaded_at_raw = metadata.get("uploaded_at")
        uploaded_at = (
            _parse_uploaded_at(uploaded_at_raw) or blob.updated or datetime.now(UTC)
        )
        if uploaded_at.tzinfo is None:
            uploaded_at = uploaded_at.replace(tzinfo=UTC)
        return IdentityDocument(
            id=kind,
            kind=kind,
            filename=filename,
            size=int(blob.size or 0),
            uploaded_at=uploaded_at.astimezone(UTC),
        )


def configured_identity_document_store(settings: Settings) -> GCSIdentityDocumentStore:
    return GCSIdentityDocumentStore(settings)


def list_identity_documents(settings: Settings) -> list[IdentityDocument]:
    if not settings.identity_bucket.strip():
        return []
    return configured_identity_document_store(settings).list_documents()


@contextmanager
def identity_attachment_paths(settings: Settings) -> Iterator[list[Path]]:
    """Yield downloaded identity docs for Gmail attachment, with local fallback."""
    if settings.identity_bucket.strip():
        with tempfile.TemporaryDirectory(prefix="smokescreen-identity-") as temp_dir:
            yield configured_identity_document_store(settings).download_documents(
                Path(temp_dir)
            )
        return

    if settings.identity_docs_dir.exists():
        log.warning(
            "identity_docs_dir_deprecated",
            path=str(settings.identity_docs_dir),
            message=(
                "identity_docs_dir is deprecated; configure "
                "SMOKESCREEN_IDENTITY_BUCKET and upload documents through "
                "the dashboard."
            ),
        )
        yield [path for path in settings.identity_docs_dir.iterdir() if path.is_file()]
    else:
        yield []


def _safe_filename(filename: str) -> str:
    name = Path(filename).name.strip()
    if not name:
        raise InvalidIdentityDocument("Identity document filename is required.")
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip(".-")
    if not safe:
        raise InvalidIdentityDocument("Identity document filename is invalid.")
    return safe[:120]


def _kind_from_name(name: str) -> str | None:
    parts = name.split("/")
    for part in parts:
        if part in IDENTITY_DOCUMENT_KINDS:
            return part
    return None


def _parse_uploaded_at(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
