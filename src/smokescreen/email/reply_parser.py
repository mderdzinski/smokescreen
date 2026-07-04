"""Extract the newest human-authored portion of an email reply."""

from __future__ import annotations

import re

_GMAIL_WROTE_RE = re.compile(r"^\s*On .+\bwrote:\s*$", re.IGNORECASE)
_OUTLOOK_ORIGINAL_RE = re.compile(
    r"^\s*-{2,}\s*Original Message\s*-{2,}\s*$", re.IGNORECASE
)
_FORWARDED_RE = re.compile(r"^\s*-{2,}\s*Forwarded message\s*-{2,}\s*$", re.IGNORECASE)
_MOBILE_SIGNATURE_RE = re.compile(
    r"^\s*(Sent from my (?:iPhone|iPad|Android|mobile device)|"
    r"Sent via .+|Get Outlook for (?:iOS|Android))\.?\s*$",
    re.IGNORECASE,
)
_QUOTED_LINE_RE = re.compile(r"^\s*>+")


def parse_latest_reply(raw_body: str) -> str:
    """Return the top reply text with common quoted thread history removed."""
    if not raw_body:
        return ""

    lines = raw_body.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    kept: list[str] = []

    for index, line in enumerate(lines):
        stripped = line.strip()
        if _starts_quoted_history(lines, index):
            break
        if _QUOTED_LINE_RE.match(stripped):
            continue
        if _MOBILE_SIGNATURE_RE.match(stripped):
            break
        kept.append(line.rstrip())

    return _trim_blank_lines(kept)


def _starts_quoted_history(lines: list[str], index: int) -> bool:
    stripped = lines[index].strip()
    if not stripped:
        return False
    if _GMAIL_WROTE_RE.match(stripped):
        return True
    if stripped.lower().startswith("on ") and _nearby_wrote_marker(lines, index):
        return True
    if _OUTLOOK_ORIGINAL_RE.match(stripped) or _FORWARDED_RE.match(stripped):
        return True
    return bool(_looks_like_outlook_header(lines, index))


def _nearby_wrote_marker(lines: list[str], index: int) -> bool:
    for lookahead in lines[index + 1 : index + 3]:
        if lookahead.strip().lower() == "wrote:":
            return True
    return False


def _looks_like_outlook_header(lines: list[str], index: int) -> bool:
    if not lines[index].strip().lower().startswith("from:"):
        return False

    header_lines = [line.strip().lower() for line in lines[index + 1 : index + 6]]
    return any(line.startswith("sent:") for line in header_lines) and any(
        line.startswith(("to:", "subject:")) for line in header_lines
    )


def _trim_blank_lines(lines: list[str]) -> str:
    start = 0
    end = len(lines)
    while start < end and not lines[start].strip():
        start += 1
    while end > start and not lines[end - 1].strip():
        end -= 1
    return "\n".join(lines[start:end]).strip()
