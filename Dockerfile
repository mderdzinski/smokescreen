FROM python:3.11-slim

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

# Copy project files
COPY pyproject.toml uv.lock* ./
COPY src/ src/

# Install dependencies
RUN uv sync --no-dev --frozen 2>/dev/null || uv sync --no-dev

# Default entrypoint — overridden by Cloud Run Job args
ENTRYPOINT ["uv", "run", "smokescreen"]
