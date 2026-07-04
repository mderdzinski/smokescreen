#!/usr/bin/env python3
"""Check copyable shell snippets in markdown runbooks.

The docs are often pasted into interactive zsh sessions where
`interactivecomments` may be disabled. Keep shell fences command-only: prose
belongs outside the fence, and heredocs must quote the delimiter so shell
metacharacters in the body stay literal.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

DEFAULT_PATHS = (
    Path("README.md"),
    Path("CLAUDE.md"),
    Path("ARCHITECTURE.md"),
    Path("docs"),
)
SHELL_LANGS = {"bash", "sh", "shell", "zsh"}
FENCE_RE = re.compile(r"^```(?P<lang>[A-Za-z0-9_+.-]*)\b")


@dataclass(frozen=True)
class Violation:
    path: Path
    line_number: int
    code: str
    message: str
    line: str

    def format(self) -> str:
        return (
            f"{self.path}:{self.line_number}: {self.code}: {self.message}\n"
            f"    {self.line.rstrip()}"
        )


def markdown_files(paths: list[Path]) -> list[Path]:
    files: list[Path] = []
    for path in paths:
        if not path.exists():
            continue
        if path.is_dir():
            files.extend(sorted(path.rglob("*.md")))
        elif path.suffix == ".md":
            files.append(path)
    return sorted(dict.fromkeys(files))


def has_unquoted_hash(line: str) -> bool:
    quote: str | None = None
    escaped = False

    for char in line:
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if quote:
            if char == quote:
                quote = None
            continue
        if char in {"'", '"'}:
            quote = char
            continue
        if char == "#":
            return True
    return False


def unquoted_heredoc_delimiter(line: str) -> str | None:
    quote: str | None = None
    escaped = False
    index = 0

    while index < len(line):
        char = line[index]
        if escaped:
            escaped = False
            index += 1
            continue
        if char == "\\":
            escaped = True
            index += 1
            continue
        if quote:
            if char == quote:
                quote = None
            index += 1
            continue
        if char in {"'", '"'}:
            quote = char
            index += 1
            continue
        if line.startswith("<<<", index):
            index += 3
            continue
        if line.startswith("<<", index):
            delimiter_start = index + 2
            if delimiter_start < len(line) and line[delimiter_start] == "-":
                delimiter_start += 1
            while delimiter_start < len(line) and line[delimiter_start].isspace():
                delimiter_start += 1
            if delimiter_start >= len(line):
                return ""
            if line[delimiter_start] != "'":
                delimiter = line[delimiter_start:].split(maxsplit=1)[0]
                return delimiter
        index += 1
    return None


def check_markdown(path: Path) -> list[Violation]:
    violations: list[Violation] = []
    in_shell_fence = False

    lines = path.read_text(encoding="utf-8").splitlines()
    for line_number, line in enumerate(lines, 1):
        fence = FENCE_RE.match(line)
        if fence and not in_shell_fence:
            in_shell_fence = fence.group("lang").lower() in SHELL_LANGS
            continue
        if line.startswith("```") and in_shell_fence:
            in_shell_fence = False
            continue
        if not in_shell_fence:
            continue

        if has_unquoted_hash(line):
            violations.append(
                Violation(
                    path=path,
                    line_number=line_number,
                    code="RUNBOOK001",
                    message=(
                        "move comments/prose outside shell fences; unquoted # "
                        "is unsafe in interactive zsh"
                    ),
                    line=line,
                )
            )
        delimiter = unquoted_heredoc_delimiter(line)
        if delimiter is not None:
            violations.append(
                Violation(
                    path=path,
                    line_number=line_number,
                    code="RUNBOOK002",
                    message=(
                        "use a single-quoted heredoc delimiter, for example "
                        "<<'BODY', for rich text"
                    ),
                    line=line,
                )
            )

    return violations


def run(paths: list[Path]) -> list[Violation]:
    violations: list[Violation] = []
    for path in markdown_files(paths):
        violations.extend(check_markdown(path))
    return violations


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "paths",
        nargs="*",
        type=Path,
        default=list(DEFAULT_PATHS),
        help="Markdown files or directories to check.",
    )
    args = parser.parse_args()

    violations = run(args.paths)
    if violations:
        print("Unsafe shell snippets found:", file=sys.stderr)
        for violation in violations:
            print(violation.format(), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
