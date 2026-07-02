import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderOptions } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";

interface RenderWithProvidersOptions extends Omit<RenderOptions, "wrapper"> {
  route?: string;
}

export interface MockApiRequest {
  init?: RequestInit;
  method: string;
  path: string;
}

interface MockApiRoute {
  assert?: (request: MockApiRequest) => void;
  body?: unknown;
  method?: string;
  path: RegExp | string;
  respond?: (request: MockApiRequest) => Promise<Response> | Response;
  status?: number;
}

export function renderWithProviders(ui: ReactElement, options: RenderWithProvidersOptions = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: {
        retry: false,
      },
      queries: {
        retry: false,
      },
    },
  });
  const route = options.route ?? "/";

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  }

  return {
    queryClient,
    ...render(ui, { ...options, wrapper: Wrapper }),
  };
}

// Routes registered automatically for every mockApi() call unless the test
// provides its own override for the same path. Keeps 20+ existing tests from
// having to declare mocks for cross-cutting endpoints (broker-selections,
// version, etc.) they don't care about.
const DEFAULT_ROUTES: MockApiRoute[] = [
  { body: { enabled_broker_ids: [] }, path: "/api/brokers/selections" },
];

export function mockApi(routes: MockApiRoute[]) {
  const calls: MockApiRequest[] = [];
  const overriddenPaths = new Set(
    routes
      .filter((route) => typeof route.path === "string")
      .map((route) => route.path as string),
  );
  const effectiveRoutes: MockApiRoute[] = [
    ...routes,
    ...DEFAULT_ROUTES.filter(
      (route) =>
        typeof route.path !== "string" ||
        !overriddenPaths.has(route.path),
    ),
  ];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = normalizeRequest(input, init);
    calls.push(request);
    const route = effectiveRoutes.find((candidate) => routeMatches(candidate, request));

    if (!route) {
      throw new Error(`Unhandled ${request.method} ${request.path}`);
    }

    route.assert?.(request);

    if (route.respond) {
      return route.respond(request);
    }

    return jsonResponse(route.body ?? {}, route.status ?? 200);
  });

  vi.stubGlobal("fetch", fetchMock);

  return { calls, fetchMock };
}

function normalizeRequest(input: RequestInfo | URL, init?: RequestInit): MockApiRequest {
  if (input instanceof Request) {
    return {
      init,
      method: (init?.method ?? input.method ?? "GET").toUpperCase(),
      path: normalizePath(input.url),
    };
  }

  return {
    init,
    method: (init?.method ?? "GET").toUpperCase(),
    path: normalizePath(String(input)),
  };
}

function normalizePath(value: string): string {
  if (value.startsWith("http://") || value.startsWith("https://")) {
    const url = new URL(value);
    return `${url.pathname}${url.search}`;
  }
  return value;
}

function routeMatches(route: MockApiRoute, request: MockApiRequest): boolean {
  const method = (route.method ?? "GET").toUpperCase();
  if (method !== request.method) {
    return false;
  }
  if (typeof route.path === "string") {
    return route.path === request.path;
  }
  return route.path.test(request.path);
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
    },
    status,
  });
}
