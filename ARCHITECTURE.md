# Architecture

## Web foundation

The React rewrite lives in `web/` and uses Vite, React, and TypeScript with strict compiler settings. Vite gives a small development server and a static production build without changing the existing Python CLI commands.

The UI foundation follows the shadcn/ui model: Tailwind tokens, Radix primitives, class-variance-authority variants, and local component source in `web/src/components/ui/`. This keeps the design system accessible and easy to customize while avoiding a heavy product framework.

TanStack Query owns server-state fetching and caching. The API client in `web/src/lib/api.ts` uses typed JSON calls against the existing FastAPI `/api/*` endpoints and does not change endpoint shapes. React Router owns the root UI routes, with FastAPI preserving `/api/*` and static asset paths outside the SPA fallback.

## Runtime model

Local development runs two processes:

```bash
scripts/dev.sh
```

That starts FastAPI on `127.0.0.1:8000` via `smokescreen serve` and Vite on `127.0.0.1:5173`. Vite serves the React app at `/` and proxies `/api` to FastAPI.

Production builds the Vite app into `src/smokescreen/web_dist`:

```bash
npm --prefix web run build
smokescreen serve
```

FastAPI serves the React app at `/` and redirects the former `/app` mount to the equivalent root route.

The Dockerfile builds the web bundle before installing the Python package, so container images can serve the React dashboard without a separate frontend server.
