"""Runtime app version resolution.

Reads the installed package metadata so the Docker image reports the
release-tagged version without any source-tree fallback shenanigans. In a
source checkout without an installed distribution (unlikely in normal dev,
since we use ``uv sync``), falls back to reading ``pyproject.toml`` so the
endpoint stays useful during ad-hoc runs.
"""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _pkg_version
from pathlib import Path

_PACKAGE_NAME = "smokescreen"
_UNKNOWN = "0.0.0"


def _read_pyproject_version() -> str | None:
    pyproject = Path(__file__).resolve().parents[2] / "pyproject.toml"
    if not pyproject.is_file():
        return None
    for line in pyproject.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith("version"):
            _, _, value = stripped.partition("=")
            return value.strip().strip('"').strip("'") or None
    return None


def get_app_version() -> str:
    """Return the currently running smokescreen version string."""
    try:
        return _pkg_version(_PACKAGE_NAME)
    except PackageNotFoundError:
        fallback = _read_pyproject_version()
        return fallback or _UNKNOWN
