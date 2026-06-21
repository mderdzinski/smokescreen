FROM node:22-slim AS web-build

WORKDIR /app
COPY web/package*.json web/
RUN npm --prefix web ci
COPY web/ web/
RUN npm --prefix web run build

FROM python:3.11-slim

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

# Copy project files
COPY pyproject.toml uv.lock* README.md ./
COPY src/ src/
COPY --from=web-build /app/src/smokescreen/web_dist/ src/smokescreen/web_dist/

# Install dependencies
RUN uv sync --no-dev --frozen 2>/dev/null || uv sync --no-dev

# Default entrypoint — overridden by Cloud Run Job args
ENTRYPOINT ["/app/.venv/bin/smokescreen"]
