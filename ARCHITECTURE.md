# Architecture

## Web foundation

The React rewrite lives in `web/` and uses Vite, React, and TypeScript with strict compiler settings. Vite gives a small development server and a static production build without changing the existing Python CLI commands.

The UI foundation follows the shadcn/ui model: Tailwind tokens, Radix primitives, class-variance-authority variants, and local component source in `web/src/components/ui/`. This keeps the design system accessible and easy to customize while avoiding a heavy product framework.

TanStack Query owns server-state fetching and caching. The API client in `web/src/lib/api.ts` uses typed JSON calls against the existing FastAPI `/api/*` endpoints and does not change endpoint shapes. React Router is installed and configured with the `/app` basename so future pages can be added without changing the FastAPI mount path.

## Runtime model

Local development runs two processes:

```bash
scripts/dev.sh
```

That starts FastAPI on `127.0.0.1:8000` via `smokescreen serve` and Vite on `127.0.0.1:5173`. Vite proxies `/api` and `/old-dashboard` to FastAPI.

Production builds the Vite app into `src/smokescreen/web_dist`:

```bash
npm --prefix web run build
smokescreen serve
```

FastAPI serves the React app at `/app` and keeps the legacy dashboard available at `/old-dashboard`. The existing `/` route still serves the old dashboard during the rewrite so current CLI and user habits continue to work.

The Dockerfile builds the web bundle before installing the Python package, so container images can serve `/app` without a separate frontend server.
