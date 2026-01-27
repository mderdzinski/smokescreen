"""Gmail API client for sending and reading emails."""

from __future__ import annotations

import base64
import email
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.base import MIMEBase
from email import encoders
from pathlib import Path

import structlog
from googleapiclient.discovery import build

from smokescreen.models import EmailMessage

log = structlog.get_logger()


class GmailClient:
    """Thin wrapper around the Gmail API."""

    def __init__(self, credentials) -> None:
        self._service = build("gmail", "v1", credentials=credentials)

    def send(
        self,
        to: str,
        subject: str,
        body: str,
        sender: str,
        sender_name: str = "",
        thread_id: str | None = None,
        attachment_paths: list[Path] | None = None,
    ) -> EmailMessage:
        """Send an email, optionally as a reply in an existing thread."""
        if attachment_paths:
            msg = MIMEMultipart()
            msg.attach(MIMEText(body, "plain"))
            for path in attachment_paths:
                part = MIMEBase("application", "octet-stream")
                part.set_payload(path.read_bytes())
                encoders.encode_base64(part)
                part.add_header(
                    "Content-Disposition", f"attachment; filename={path.name}"
                )
                msg.attach(part)
        else:
            msg = MIMEText(body, "plain")

        from_header = f"{sender_name} <{sender}>" if sender_name else sender
        msg["to"] = to
        msg["from"] = from_header
        msg["subject"] = subject

        raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
        send_body: dict = {"raw": raw}
        if thread_id:
            send_body["threadId"] = thread_id

        result = (
            self._service.users()
            .messages()
            .send(userId="me", body=send_body)
            .execute()
        )

        log.info(
            "email_sent",
            to=to,
            subject=subject,
            message_id=result["id"],
            thread_id=result.get("threadId"),
        )

        return EmailMessage(
            message_id=result["id"],
            thread_id=result.get("threadId", ""),
            sender=sender,
            to=to,
            subject=subject,
            body=body,
        )

    def search(self, query: str, max_results: int = 50) -> list[str]:
        """Search for message IDs matching a Gmail query."""
        result = (
            self._service.users()
            .messages()
            .list(userId="me", q=query, maxResults=max_results)
            .execute()
        )
        messages = result.get("messages", [])
        return [m["id"] for m in messages]

    def get_message(self, message_id: str) -> EmailMessage:
        """Fetch a full message by ID."""
        msg = (
            self._service.users()
            .messages()
            .get(userId="me", id=message_id, format="full")
            .execute()
        )
        return self._parse_message(msg)

    def get_thread(self, thread_id: str) -> list[EmailMessage]:
        """Fetch all messages in a thread."""
        thread = (
            self._service.users()
            .threads()
            .get(userId="me", id=thread_id)
            .execute()
        )
        return [self._parse_message(m) for m in thread.get("messages", [])]

    def _parse_message(self, msg: dict) -> EmailMessage:
        """Parse a Gmail API message resource into an EmailMessage."""
        headers = {h["name"].lower(): h["value"] for h in msg["payload"]["headers"]}

        body = ""
        payload = msg["payload"]
        if "parts" in payload:
            for part in payload["parts"]:
                if part["mimeType"] == "text/plain" and "data" in part.get("body", {}):
                    body = base64.urlsafe_b64decode(part["body"]["data"]).decode()
                    break
        elif "body" in payload and "data" in payload["body"]:
            body = base64.urlsafe_b64decode(payload["body"]["data"]).decode()

        date = None
        if "date" in headers:
            try:
                parsed = email.utils.parsedate_to_datetime(headers["date"])
                date = parsed
            except (ValueError, TypeError):
                pass

        has_attachments = any(
            p.get("filename") for p in payload.get("parts", [])
        )

        return EmailMessage(
            message_id=msg["id"],
            thread_id=msg.get("threadId", ""),
            sender=headers.get("from", ""),
            to=headers.get("to", ""),
            subject=headers.get("subject", ""),
            body=body,
            date=date,
            has_attachments=has_attachments,
        )
