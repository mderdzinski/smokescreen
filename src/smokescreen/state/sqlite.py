"""SQLite implementation of StateStore for local development."""

from __future__ import annotations

import sqlite3
from datetime import datetime
from pathlib import Path

from smokescreen.models import (
    BrokerStatus,
    OptOutRecord,
    PendingWhitelistEntry,
    PendingWhitelistStatus,
    WhitelistEntry,
    WhitelistSource,
)


class SQLiteStore:
    """SQLite-backed state store."""

    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._ensure_table()

    def _ensure_table(self) -> None:
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS opt_outs (
                broker_id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                retries INTEGER NOT NULL DEFAULT 0,
                thread_id TEXT,
                last_message_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                notes TEXT NOT NULL DEFAULT ''
            )
        """)
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS email_whitelist (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                broker_id TEXT NOT NULL,
                email TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'manual',
                added_at TEXT NOT NULL,
                UNIQUE(email)
            )
        """)
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS pending_whitelist (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                broker_id TEXT,
                email TEXT NOT NULL,
                message_subject TEXT NOT NULL DEFAULT '',
                message_snippet TEXT NOT NULL DEFAULT '',
                detected_at TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending'
            )
        """)
        self._conn.commit()

    def _row_to_record(self, row: sqlite3.Row) -> OptOutRecord:
        return OptOutRecord(
            broker_id=row["broker_id"],
            status=BrokerStatus(row["status"]),
            retries=row["retries"],
            thread_id=row["thread_id"],
            last_message_id=row["last_message_id"],
            created_at=datetime.fromisoformat(row["created_at"]),
            updated_at=datetime.fromisoformat(row["updated_at"]),
            notes=row["notes"],
        )

    def get(self, broker_id: str) -> OptOutRecord | None:
        row = self._conn.execute(
            "SELECT * FROM opt_outs WHERE broker_id = ?", (broker_id,)
        ).fetchone()
        if row is None:
            return None
        return self._row_to_record(row)

    def list_all(self) -> list[OptOutRecord]:
        rows = self._conn.execute(
            "SELECT * FROM opt_outs ORDER BY broker_id"
        ).fetchall()
        return [self._row_to_record(r) for r in rows]

    def list_by_status(self, status: BrokerStatus) -> list[OptOutRecord]:
        rows = self._conn.execute(
            "SELECT * FROM opt_outs WHERE status = ? ORDER BY broker_id",
            (status.value,),
        ).fetchall()
        return [self._row_to_record(r) for r in rows]

    def upsert(self, record: OptOutRecord) -> None:
        self._conn.execute(
            """
            INSERT INTO opt_outs (broker_id, status, retries, thread_id,
                                  last_message_id, created_at, updated_at, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(broker_id) DO UPDATE SET
                status = excluded.status,
                retries = excluded.retries,
                thread_id = excluded.thread_id,
                last_message_id = excluded.last_message_id,
                updated_at = excluded.updated_at,
                notes = excluded.notes
            """,
            (
                record.broker_id,
                record.status.value,
                record.retries,
                record.thread_id,
                record.last_message_id,
                record.created_at.isoformat(),
                record.updated_at.isoformat(),
                record.notes,
            ),
        )
        self._conn.commit()

    def delete(self, broker_id: str) -> None:
        self._conn.execute("DELETE FROM opt_outs WHERE broker_id = ?", (broker_id,))
        self._conn.commit()

    # --- Whitelist methods ---

    def is_whitelisted(self, email: str) -> bool:
        row = self._conn.execute(
            "SELECT 1 FROM email_whitelist WHERE email = ?", (email,)
        ).fetchone()
        return row is not None

    def list_whitelist(self) -> list[WhitelistEntry]:
        rows = self._conn.execute(
            "SELECT * FROM email_whitelist ORDER BY added_at"
        ).fetchall()
        return [
            WhitelistEntry(
                id=r["id"],
                broker_id=r["broker_id"],
                email=r["email"],
                source=WhitelistSource(r["source"]),
                added_at=datetime.fromisoformat(r["added_at"]),
            )
            for r in rows
        ]

    def add_whitelist(self, entry: WhitelistEntry) -> WhitelistEntry:
        cur = self._conn.execute(
            """
            INSERT INTO email_whitelist (broker_id, email, source, added_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(email) DO UPDATE SET
                broker_id = excluded.broker_id,
                source = excluded.source
            """,
            (
                entry.broker_id,
                entry.email,
                entry.source.value,
                entry.added_at.isoformat(),
            ),
        )
        self._conn.commit()
        entry.id = cur.lastrowid
        return entry

    def delete_whitelist(self, entry_id: int) -> None:
        self._conn.execute("DELETE FROM email_whitelist WHERE id = ?", (entry_id,))
        self._conn.commit()

    def sync_registry_whitelist(self, brokers: list) -> None:
        """Sync broker privacy emails from registry into whitelist."""
        for broker in brokers:
            self._conn.execute(
                """
                INSERT INTO email_whitelist (broker_id, email, source, added_at)
                VALUES (?, ?, 'registry', ?)
                ON CONFLICT(email) DO NOTHING
                """,
                (broker.id, broker.privacy_email, datetime.utcnow().isoformat()),
            )
        self._conn.commit()

    # --- Pending whitelist methods ---

    def list_pending_whitelist(
        self, status: PendingWhitelistStatus | None = None
    ) -> list[PendingWhitelistEntry]:
        if status is not None:
            rows = self._conn.execute(
                "SELECT * FROM pending_whitelist WHERE status = ? ORDER BY detected_at",
                (status.value,),
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT * FROM pending_whitelist ORDER BY detected_at"
            ).fetchall()
        return [
            PendingWhitelistEntry(
                id=r["id"],
                broker_id=r["broker_id"],
                email=r["email"],
                message_subject=r["message_subject"],
                message_snippet=r["message_snippet"],
                detected_at=datetime.fromisoformat(r["detected_at"]),
                status=PendingWhitelistStatus(r["status"]),
            )
            for r in rows
        ]

    def add_pending_whitelist(
        self, entry: PendingWhitelistEntry
    ) -> PendingWhitelistEntry:
        cur = self._conn.execute(
            """
            INSERT INTO pending_whitelist
                (broker_id, email, message_subject,
                 message_snippet, detected_at, status)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                entry.broker_id,
                entry.email,
                entry.message_subject,
                entry.message_snippet,
                entry.detected_at.isoformat(),
                entry.status.value,
            ),
        )
        self._conn.commit()
        entry.id = cur.lastrowid
        return entry

    def approve_pending(self, entry_id: int) -> WhitelistEntry | None:
        row = self._conn.execute(
            "SELECT * FROM pending_whitelist WHERE id = ?", (entry_id,)
        ).fetchone()
        if row is None:
            return None
        self._conn.execute(
            "UPDATE pending_whitelist SET status = ? WHERE id = ?",
            (PendingWhitelistStatus.APPROVED.value, entry_id),
        )
        entry = WhitelistEntry(
            broker_id=row["broker_id"] or "",
            email=row["email"],
            source=WhitelistSource.MANUAL,
        )
        result = self.add_whitelist(entry)
        return result

    def reject_pending(self, entry_id: int) -> bool:
        cur = self._conn.execute(
            "UPDATE pending_whitelist SET status = ? WHERE id = ?",
            (PendingWhitelistStatus.REJECTED.value, entry_id),
        )
        self._conn.commit()
        return cur.rowcount > 0

    def close(self) -> None:
        self._conn.close()
