#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cleanup() {
  local pids
  pids="$(jobs -p)"
  if [[ -n "${pids}" ]]; then
    kill ${pids} 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

(cd "${root}" && uv run smokescreen serve --host 127.0.0.1 --port 8000) &
(cd "${root}/web" && npm run dev) &

wait
