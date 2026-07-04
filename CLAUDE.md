# Smokescreen Agent Notes

Smokescreen automates data broker opt-out requests. It sends Gmail-based
privacy/deletion requests, classifies broker replies with the configured AI
provider (Anthropic Claude or Vertex AI Gemini; Gemini is the deployment
default), tracks state, and exposes a local dashboard/API for monitoring and
manual review.

## Stack

- Python 3.11 package managed with `uv`
- Click CLI in `src/smokescreen/cli.py`
- FastAPI dashboard/API in `src/smokescreen/api.py`
- Gmail OAuth/client code under `src/smokescreen/email/`
- AI classifier/composer code for Anthropic Claude and Vertex AI Gemini under `src/smokescreen/ai/`
- State backends: SQLite and Firestore under `src/smokescreen/state/`
- Broker registry in `src/smokescreen/brokers/brokers.yaml`
- Terraform/GCP deployment files in `infra/`

## Project Brief

Start with `README.md` for product scope, setup, commands, architecture, and
deployment notes. This repository may be checked out inside a gt-managed
workspace; keep repository changes scoped to Smokescreen and follow the current
assignment context supplied by the environment.

## Workflow

- Keep changes scoped to the requested behavior.
- Track newly discovered work separately instead of expanding scope.
- Use semantic commit messages such as `fix: resolve ruff lint failures (sm-45a)`.
- Do not use `--no-verify`.
- Do not commit secrets, tokens, databases, sensitive verification data, or runtime state.

## Commands

Install dependencies:

```bash
uv sync --extra dev
```

Run tests:

```bash
uv run pytest tests/ -v
```

Run lint:

```bash
uv run ruff check src/ tests/ scripts/check_runbook_shell.py
```

Run runbook shell-safety checks:

```bash
uv run python scripts/check_runbook_shell.py
```

Useful smoke commands:

```bash
uv run smokescreen --help
uv run smokescreen --dry-run status
uv run smokescreen serve
```

## Definition of Done

- Acceptance criteria are satisfied.
- Relevant manual verification has been performed and noted when useful.
- `uv run pytest tests/ -v` passes unless the task explicitly narrows scope.
- `uv run ruff check src/ tests/` is clean.
- Any docs/config touched by the change match runtime behavior.
