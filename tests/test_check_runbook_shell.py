from pathlib import Path

import pytest

from scripts.check_runbook_shell import check_markdown


def write_doc(tmp_path: Path, content: str) -> Path:
    path = tmp_path / "runbook.md"
    path.write_text(content, encoding="utf-8")
    return path


def test_rejects_inline_hash_in_shell_fence(tmp_path: Path):
    path = write_doc(
        tmp_path,
        """# Runbook

```bash
mkdir -p ~/.smokescreen   # one-time setup
```
""",
    )

    violations = check_markdown(path)

    assert [violation.code for violation in violations] == ["RUNBOOK001"]


def test_rejects_comment_only_lines_in_shell_fence(tmp_path: Path):
    path = write_doc(
        tmp_path,
        """# Runbook

```bash
# Install dependencies
uv sync
```
""",
    )

    violations = check_markdown(path)

    assert [violation.code for violation in violations] == ["RUNBOOK001"]


@pytest.mark.parametrize(
    "line",
    [
        "gt mail send smokescreen/witness -s \"HELP\" --stdin <<BODY",
        "gt mail send smokescreen/witness -s \"HELP\" --stdin <<-BODY",
    ],
)
def test_rejects_unquoted_heredoc_delimiters(tmp_path: Path, line: str):
    path = write_doc(
        tmp_path,
        f"""# Runbook

```bash
{line}
Text with $(shell syntax) must stay literal.
BODY
```
""",
    )

    violations = check_markdown(path)

    assert [violation.code for violation in violations] == ["RUNBOOK002"]


def test_allows_command_only_shell_fence_and_single_quoted_heredoc(tmp_path: Path):
    path = write_doc(
        tmp_path,
        """# Runbook

```bash
uv sync
printf '%s\\n' '# literal hash'
gt mail send smokescreen/witness -s "HELP" --stdin <<'BODY'
Problem: command output contained $(shell syntax).
Tried: reran the deployment.
BODY
```
""",
    )

    assert check_markdown(path) == []
