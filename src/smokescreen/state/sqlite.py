"""SQLite implementation of StateStore for local development."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from pathlib import Path

from smokescreen.models import BrokerStatus, OptOutRecord


class SQLiteStore:
    """SQLite-backed state store."""

    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        self._conn = sqlite3.connect(str(db_path))
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
        rows = self._conn.execute("SELECT * FROM opt_outs ORDER BY broker_id").fetchall()
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

    def close(self) -> None:
        self._conn.close()
