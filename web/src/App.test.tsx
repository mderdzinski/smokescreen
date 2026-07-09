import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocation } from "react-router-dom";

import {
  App,
  NeedsAttentionPage,
  OverviewPage,
  SettingsPage,
  TrustedSendersPage,
} from "./App";
import { BrokerRegistryPage } from "./pages/BrokerRegistryPage";
import { router } from "./router";
import type {
  AdvancedSettings,
  Broker,
  ExtendedStats,
  FriendlySettings,
  OptOutRecord,
  PendingWhitelistEntry,
  ProfileGap,
  VerificationProfile,
  WhitelistEntry,
} from "./lib/api";
import { mockApi, type MockApiRequest, renderWithProviders } from "./test/test-utils";

const broker: Broker = {
  aliases: ["acme-search.com"],
  domain: "acme.example",
  id: "acme",
  name: "Acme Data",
  notes: "Requires email confirmation.",
  privacy_email: "privacy@acme.example",
};

const secondBroker: Broker = {
  aliases: [],
  domain: "second.example",
  id: "second",
  name: "Second Broker",
  notes: "",
  privacy_email: "privacy@second.example",
};

const thirdBroker: Broker = {
  aliases: [],
  domain: "third.example",
  id: "third",
  name: "Third Broker",
  notes: "",
  privacy_email: "privacy@third.example",
};

const settings: FriendlySettings = {
  ai_provider: "anthropic",
  anthropic_api_key: "",
  anthropic_key_from_secret: false,
  gemini_model: "gemini-3.1-flash-lite",
  gmail_configured: false,
  gmail_connected: false,
  gmail_connected_email: "",
  gmail_credentials_available: false,
  gmail_token_available: false,
  identity_configured: false,
  rerequest_interval_days: 30,
  rerequest_interval_days_from_env: false,
  sender_email: "jane@example.com",
  sender_email_from_env: false,
  sender_name: "Jane Doe",
  sender_name_from_env: false,
  state_timeout_days: 14,
  state_timeout_days_from_env: false,
};

const advancedSettings: AdvancedSettings = {
  ai_provider: "anthropic",
  anthropic_model: "claude-sonnet-4-20250514",
  dry_run: false,
  gemini_location: "global",
  gemini_model: "gemini-3.1-flash-lite",
  gemini_project: "",
  max_retries: 5,
  poll_label: "smokescreen",
};

const verificationProfile: VerificationProfile = {
  home_addresses: [],
  phone_numbers: [],
  email_aliases: [],
  documents: [],
  date_of_birth: null,
  last_four_ssn: null,
  employer_name: null,
  additional_notes: null,
};

const emptyStats: ExtendedStats = {
  avg_completion_hours: null,
  by_status: {},
  completed_count: 0,
  needs_attention: 0,
  recent_activity: [],
  success_rate: 0,
  total: 0,
};

function optOut(overrides: Partial<OptOutRecord>): OptOutRecord {
  return {
    broker_domain: "acme.example",
    broker_id: "acme",
    broker_name: "Acme Data",
    broker_privacy_email: "privacy@acme.example",
    created_at: "2026-06-20T12:00:00Z",
    last_completed_at: null,
    last_message_id: "msg-1",
    missing_fields: [],
    needs_manual_reason: null,
    notes: "",
    previous_status: null,
    requested_fields: [],
    requested_other_details: "",
    retries: 0,
    state_history: [],
    status: "AWAITING_RESPONSE",
    thread_id: "thread-1",
    updated_at: "2026-06-21T12:00:00Z",
    ...overrides,
  };
}

function parseJsonBody(request: MockApiRequest): unknown {
  return JSON.parse(String(request.init?.body));
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function brokerSelectionResponse(enabledBrokerIds: string[], warning: string | null = null) {
  return {
    enabled_broker_ids: enabledBrokerIds,
    selection_document_size_bytes: 25 + enabledBrokerIds.join("").length,
    selection_size_warning: warning,
  };
}

const optOutsIncludeDisabledPath = "/api/optouts?include_disabled=true";

function LocationProbe() {
  const location = useLocation();

  return <div data-testid="location-path">{location.pathname}</div>;
}

function mockReducedSmokeOverlay() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  );

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect: vi.fn(),
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);

  class MockImage {
    onload: (() => void) | null = null;

    set src(_value: string) {
      window.setTimeout(() => this.onload?.(), 0);
    }
  }

  vi.stubGlobal("Image", MockImage);
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("App", () => {
  it("renders the command-bar tabs with the live attention count", async () => {
    mockApi([
      {
        body: [
          optOut({
            broker_id: "manual",
            status: "NEEDS_MANUAL",
          }),
          optOut({
            broker_id: "failed",
            status: "FAILED",
          }),
        ],
        path: "/api/optouts?status=needs_attention",
      },
      { body: settings, path: "/api/settings" },
      { body: { version: "0.1.0" }, path: "/api/version" },
    ]);

    renderWithProviders(<App />);

    const primaryNav = screen.getByRole("navigation", { name: "Primary" });
    expect(primaryNav).toHaveClass("overflow-x-auto", "overflow-y-hidden");
    expect(within(primaryNav).getAllByRole("link")).toHaveLength(4);
    expect(within(primaryNav).getByRole("link", { name: "Status" })).toHaveAttribute("href", "/");
    expect(within(primaryNav).getByRole("link", { name: "Brokers" })).toHaveAttribute("href", "/brokers");
    expect(within(primaryNav).getByRole("link", { name: /Needs Attention/ })).toHaveAttribute("href", "/needs-attention");
    expect(within(primaryNav).getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
    expect(within(primaryNav).queryByRole("link", { name: "Setup" })).not.toBeInTheDocument();
    expect(within(primaryNav).getByRole("link", { name: "Status" })).toHaveAttribute("aria-current", "page");
    expect(await screen.findByText("2")).toHaveClass("ss-badge-live");
  });

  it("does not register obsolete setup or onboarding routes", () => {
    const rootRoute = router.routes.find((route) => route.path === "/");
    const childPaths = rootRoute?.children?.map((route) => route.path).filter(Boolean);

    expect(childPaths).not.toContain("setup");
    expect(childPaths).not.toContain("onboarding");
  });

  it("renders the backend-provided version in the top bar", async () => {
    mockApi([
      { body: [], path: "/api/optouts?status=needs_attention" },
      { body: settings, path: "/api/settings" },
      { body: { version: "1.2.3" }, path: "/api/version" },
    ]);

    renderWithProviders(<App />);

    const versionLink = await screen.findByRole("link", { name: /Smokescreen version v1\.2\.3/ });
    expect(versionLink).toHaveTextContent("v1.2.3");
    expect(versionLink).toHaveAttribute(
      "href",
      "https://github.com/mderdzinski/smokescreen/releases/tag/v1.2.3",
    );
  });

  it("hides the version badge when the backend endpoint fails", async () => {
    mockApi([
      { body: [], path: "/api/optouts?status=needs_attention" },
      { body: settings, path: "/api/settings" },
      { path: "/api/version", status: 500 },
    ]);

    renderWithProviders(<App />);

    await screen.findByRole("link", { name: "Status" });
    await waitFor(() => {
      expect(screen.queryByRole("link", { name: /Smokescreen version/ })).not.toBeInTheDocument();
    });
  });

  it("marks the active shell tab from the current route", async () => {
    mockApi([
      { body: [], path: "/api/optouts?status=needs_attention" },
      { body: settings, path: "/api/settings" },
      { body: { version: "0.1.0" }, path: "/api/version" },
    ]);

    renderWithProviders(<App />, { route: "/settings" });

    const statusTab = screen.getByRole("link", { name: "Status" });
    const settingsTab = screen.getByRole("link", { name: "Settings" });

    expect(statusTab).not.toHaveAttribute("aria-current");
    expect(statusTab.querySelector("[data-ss-active-tab-rule='true']")).toBeNull();
    expect(screen.queryByRole("link", { name: "Setup" })).not.toBeInTheDocument();
    expect(settingsTab).toHaveAttribute("aria-current", "page");
    expect(settingsTab.querySelector("[data-ss-active-tab-rule='true']")).toBeInTheDocument();
  });

  it("shows a sign-out button linking to the signed-out route and does not surface the operator email", async () => {
    mockApi([
      { body: [], path: "/api/optouts?status=needs_attention" },
      {
        body: { ...settings, gmail_connected: true, gmail_connected_email: "signed-in@example.com" },
        path: "/api/settings",
      },
      { body: { version: "0.1.0" }, path: "/api/version" },
    ]);

    renderWithProviders(<App />);

    const signOutLink = screen.getByRole("link", {
      name: /Sign out of the Smokescreen dashboard/,
    });
    expect(signOutLink).toHaveAttribute("href", "/signed-out");
    expect(screen.queryByTestId("app-user-email")).not.toBeInTheDocument();
  });
});

describe("OverviewPage", () => {
  it("shows loading status while dashboard data is pending", () => {
    mockApi([
      {
        path: "/api/stats/extended",
        respond: () => new Promise<Response>(() => {}),
      },
      {
        path: "/api/optouts",
        respond: () => new Promise<Response>(() => {}),
      },
    ]);

    renderWithProviders(<OverviewPage />);

    expect(screen.getByRole("heading", { name: "Checking broker removals" })).toBeInTheDocument();
    expect(screen.getAllByText("Loading requests")).toHaveLength(3);
  });

  it("shows the empty dashboard state before any broker requests exist", async () => {
    mockApi([
      { body: emptyStats, path: "/api/stats/extended" },
      { body: [], path: "/api/optouts" },
      { body: brokerSelectionResponse(["acme"]), path: "/api/brokers/selections" },
    ]);

    renderWithProviders(<OverviewPage />);

    expect(
      await screen.findByRole("heading", { name: "0 brokers requesting removal of your data" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Review requests/ })).toHaveAttribute("href", "/needs-attention");
    expect(screen.getAllByText("Nothing here")).toHaveLength(3);
    expect(screen.getByText("No requests in flight.")).toBeInTheDocument();
    expect(screen.getAllByText("Empty for now.")).toHaveLength(2);
  });

  it("queues a manual poll from the overview action bar", async () => {
    const user = userEvent.setup();
    const pollCalls: string[] = [];
    mockApi([
      { body: emptyStats, path: "/api/stats/extended" },
      { body: [], path: "/api/optouts" },
      { body: brokerSelectionResponse(["acme"]), path: "/api/brokers/selections" },
      {
        assert: (request) => pollCalls.push(request.path),
        body: { message: "Poll run queued", status: "queued" },
        method: "POST",
        path: "/api/poll",
        status: 202,
      },
    ]);

    renderWithProviders(<OverviewPage />);

    await screen.findByRole("heading", { name: "0 brokers requesting removal of your data" });
    await user.click(screen.getByRole("button", { name: "Poll now" }));

    await waitFor(() => expect(pollCalls).toEqual(["/api/poll"]));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Poll queued. State will update within about a minute.",
    );
  });

  it("shows a rate-limit toast when overview poll-now is throttled", async () => {
    const user = userEvent.setup();
    mockApi([
      { body: emptyStats, path: "/api/stats/extended" },
      { body: [], path: "/api/optouts" },
      { body: brokerSelectionResponse(["acme"]), path: "/api/brokers/selections" },
      {
        method: "POST",
        path: "/api/poll",
        respond: () =>
          new Response(
            JSON.stringify({
              detail: {
                code: "poll_rate_limited",
                message: "Manual poll trigger is limited to once per minute.",
              },
            }),
            {
              headers: {
                "Content-Type": "application/json",
                "Retry-After": "42",
              },
              status: 429,
            },
          ),
      },
    ]);

    renderWithProviders(<OverviewPage />);

    await screen.findByRole("heading", { name: "0 brokers requesting removal of your data" });
    await user.click(screen.getByRole("button", { name: "Poll now" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Please wait a moment before triggering another poll.",
    );
  });

  it("warns when no brokers are enabled and outreach will not run", async () => {
    mockApi([
      { body: emptyStats, path: "/api/stats/extended" },
      { body: [], path: "/api/optouts" },
      // Default mock already returns { enabled_broker_ids: [] } — keep it.
    ]);

    renderWithProviders(<OverviewPage />);

    const banner = await screen.findByTestId("no-brokers-enabled-banner");
    expect(banner).toHaveTextContent("No enabled brokers. Enable brokers in Settings to see their status here.");
    expect(within(banner).getByRole("link", { name: /Configure brokers/i })).toHaveAttribute(
      "href",
      "/brokers",
    );
    expect(within(banner).getByRole("link", { name: /Open registry/i })).toHaveAttribute(
      "href",
      "/brokers",
    );
  });

  it("hides the no-brokers banner once selections are configured", async () => {
    mockApi([
      { body: emptyStats, path: "/api/stats/extended" },
      { body: [], path: "/api/optouts" },
      { body: { enabled_broker_ids: ["spokeo"] }, path: "/api/brokers/selections" },
    ]);

    renderWithProviders(<OverviewPage />);

    await screen.findByRole("heading", { name: "0 brokers requesting removal of your data" });
    expect(screen.queryByTestId("no-brokers-enabled-banner")).not.toBeInTheDocument();
  });

  it("groups broker replies that need review in the attention column", async () => {
    mockApi([
      {
        body: {
          ...emptyStats,
          by_status: { COMPLETED: 1, NEEDS_MANUAL: 1 },
          completed_count: 1,
          needs_attention: 1,
          total: 2,
        },
        path: "/api/stats/extended",
      },
      {
        body: [
          optOut({
            broker_id: "acme",
            notes: "Broker requested a signed identity form.",
            status: "NEEDS_MANUAL",
          }),
          optOut({
            broker_id: "done",
            broker_name: "Done Broker",
            status: "COMPLETED",
          }),
        ],
        path: "/api/optouts",
      },
      { body: brokerSelectionResponse(["acme", "done"]), path: "/api/brokers/selections" },
    ]);

    renderWithProviders(<OverviewPage />);

    expect(await screen.findByRole("heading", { name: "0 brokers requesting removal of your data" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Review requests/ })).toHaveAttribute("href", "/needs-attention");
    expect(screen.getByRole("button", { name: "Inspect Acme Data record" })).toBeInTheDocument();
    expect(screen.getByText("Needs Attention Details")).toBeInTheDocument();
    expect(screen.getByText("Broker requested a signed identity form.")).toBeInTheDocument();
  });

  it("keeps overview broker reply excerpts in expanded details", async () => {
    mockApi([
      {
        body: {
          ...emptyStats,
          by_status: { NEEDS_MANUAL: 1 },
          needs_attention: 1,
          total: 1,
        },
        path: "/api/stats/extended",
      },
      {
        body: [
          optOut({
            broker_id: "acme",
            needs_manual_reason: {
              reason_code: "classifier_returned_needs_manual",
              short_summary: "Broker reply needs a manual review.",
              broker_reply_excerpt: "Broker-only latest reply excerpt.",
              classifier_output: { classification: "NEEDS_MANUAL" },
              missing_fields: [],
              transitioned_at: "2026-06-22T15:30:00Z",
            },
            notes: "Saved reply body should stay expanded.",
            status: "NEEDS_MANUAL",
          }),
        ],
        path: "/api/optouts",
      },
      { body: brokerSelectionResponse(["acme"]), path: "/api/brokers/selections" },
    ]);

    renderWithProviders(<OverviewPage />);

    expect(await screen.findByText("Broker reply needs a manual review.")).toBeInTheDocument();
    expect(screen.queryByText("Broker-only latest reply excerpt.")).not.toBeInTheDocument();

    const attentionColumn = screen.getByRole("heading", { name: "Needs attention" }).closest("section") as HTMLElement;
    fireEvent.click(within(attentionColumn).getByText("Needs Attention Details"));

    expect(screen.getByText("Broker-only latest reply excerpt.")).toBeInTheDocument();
  });

  it("filters disabled broker opt-out records before grouping status columns", async () => {
    mockApi([
      {
        body: {
          ...emptyStats,
          by_status: { AWAITING_RESPONSE: 1, FAILED: 1 },
          needs_attention: 1,
          total: 2,
        },
        path: "/api/stats/extended",
      },
      {
        body: [
          optOut({ broker_id: "acme", broker_name: "Acme Data", status: "AWAITING_RESPONSE" }),
          optOut({ broker_id: "second", broker_name: "Disabled Broker", status: "FAILED" }),
        ],
        path: "/api/optouts",
      },
      { body: brokerSelectionResponse(["acme"]), path: "/api/brokers/selections" },
    ]);

    renderWithProviders(<OverviewPage />);

    expect(await screen.findByRole("heading", { name: "1 broker requesting removal of your data" })).toBeInTheDocument();
    expect(screen.getByText("Acme Data")).toBeInTheDocument();
    expect(screen.queryByText("Disabled Broker")).not.toBeInTheDocument();
    const attentionColumn = screen.getByRole("heading", { name: "Needs attention" }).closest("section") as HTMLElement;
    expect(within(attentionColumn).getByText("Nothing here")).toBeInTheDocument();
  });

  it("maps every broker status into the correct T4 dashboard column", async () => {
    mockApi([
      {
        body: {
          ...emptyStats,
          by_status: {
            AWAITING_RESPONSE: 1,
            COMPLETED: 1,
            FAILED: 1,
            INFO_REQUESTED: 1,
            FOLLOW_UP_SENT: 1,
            INITIAL_SENT: 1,
            PENDING: 1,
            REJECTED: 1,
          },
          completed_count: 1,
          needs_attention: 1,
          total: 8,
        },
        path: "/api/stats/extended",
      },
      {
        body: [
          optOut({ broker_id: "queued", broker_name: "Queued Broker", status: "PENDING" }),
          optOut({ broker_id: "sent", broker_name: "Sent Broker", status: "INITIAL_SENT" }),
          optOut({ broker_id: "awaiting", broker_name: "Awaiting Broker", status: "AWAITING_RESPONSE" }),
          optOut({ broker_id: "id-requested", broker_name: "Info Request Broker", status: "INFO_REQUESTED" }),
          optOut({ broker_id: "id-sent", broker_name: "Follow Up Broker", status: "FOLLOW_UP_SENT" }),
          optOut({ broker_id: "done", broker_name: "Done Broker", status: "COMPLETED" }),
          optOut({ broker_id: "rejected", broker_name: "Rejected Broker", status: "REJECTED" }),
          optOut({ broker_id: "failed", broker_name: "Failed Broker", status: "FAILED" }),
        ],
        path: "/api/optouts",
      },
      {
        body: brokerSelectionResponse([
          "queued",
          "sent",
          "awaiting",
          "id-requested",
          "id-sent",
          "done",
          "rejected",
          "failed",
        ]),
        path: "/api/brokers/selections",
      },
    ]);

    renderWithProviders(<OverviewPage />);

    expect(await screen.findByRole("heading", { name: "5 brokers requesting removal of your data" })).toBeInTheDocument();
    const workingColumn = screen.getByRole("heading", { name: "Working" }).closest("section") as HTMLElement;
    const doneColumn = screen.getByRole("heading", { name: "Done" }).closest("section") as HTMLElement;
    const attentionColumn = screen.getByRole("heading", { name: "Needs attention" }).closest("section") as HTMLElement;

    expect(within(workingColumn).getByText("Queued Broker")).toBeInTheDocument();
    expect(within(workingColumn).getByText("Sent Broker")).toBeInTheDocument();
    expect(within(workingColumn).getByText("Awaiting Broker")).toBeInTheDocument();
    expect(within(workingColumn).getByText("Info Request Broker")).toBeInTheDocument();
    expect(within(workingColumn).getByText("Follow Up Broker")).toBeInTheDocument();
    expect(within(doneColumn).getByText("Done Broker")).toBeInTheDocument();
    expect(within(doneColumn).getByText("Rejected Broker")).toBeInTheDocument();
    expect(within(attentionColumn).getByText("Failed Broker")).toBeInTheDocument();
  });

  it("keeps pinged brokers in the working column", async () => {
    mockApi([
      {
        body: {
          ...emptyStats,
          by_status: {
            INITIAL_SENT_PINGED: 1,
            AWAITING_RESPONSE_PINGED: 1,
            INFO_REQUESTED_PINGED: 1,
            FOLLOW_UP_SENT_PINGED: 1,
          },
          total: 4,
        },
        path: "/api/stats/extended",
      },
      {
        body: [
          optOut({ broker_id: "a", broker_name: "Initial Pinged", status: "INITIAL_SENT_PINGED" }),
          optOut({ broker_id: "b", broker_name: "Awaiting Pinged", status: "AWAITING_RESPONSE_PINGED" }),
          optOut({ broker_id: "c", broker_name: "Info Pinged", status: "INFO_REQUESTED_PINGED" }),
          optOut({ broker_id: "d", broker_name: "Follow Pinged", status: "FOLLOW_UP_SENT_PINGED" }),
        ],
        path: "/api/optouts",
      },
      { body: brokerSelectionResponse(["a", "b", "c", "d"]), path: "/api/brokers/selections" },
    ]);

    renderWithProviders(<OverviewPage />);

    expect(await screen.findByText("Initial Pinged")).toBeInTheDocument();
    const workingColumn = screen.getByRole("heading", { name: "Working" }).closest("section") as HTMLElement;
    expect(within(workingColumn).getByText("Initial Pinged")).toBeInTheDocument();
    expect(within(workingColumn).getByText("Awaiting Pinged")).toBeInTheDocument();
    expect(within(workingColumn).getByText("Info Pinged")).toBeInTheDocument();
    expect(within(workingColumn).getByText("Follow Pinged")).toBeInTheDocument();
  });
});

describe("BrokerRegistryPage", () => {
  it("filters brokers with a debounced search, match count, and empty state", async () => {
    const user = userEvent.setup();
    mockApi([{ body: [broker, secondBroker, thirdBroker], path: "/api/brokers" }]);

    renderWithProviders(<BrokerRegistryPage />);

    expect(await screen.findByText("Acme Data")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Search brokers"), "second");

    expect(await screen.findByText("1 of 3 matches")).toBeInTheDocument();
    expect(screen.getByText("Second Broker")).toBeInTheDocument();
    expect(screen.queryByText("Acme Data")).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText("Search brokers"));
    await user.type(screen.getByLabelText("Search brokers"), "missing broker");

    expect(await screen.findByText("0 of 3 matches")).toBeInTheDocument();
    expect(screen.getByText("No brokers match that search.")).toBeInTheDocument();
  });

  it("bulk enables and disables the currently filtered broker set", async () => {
    const user = userEvent.setup();
    const putBodies: string[][] = [];
    mockApi([
      { body: [broker, secondBroker, thirdBroker], path: "/api/brokers" },
      { body: brokerSelectionResponse([]), path: "/api/brokers/selections" },
      {
        assert: (request) => {
          const body = parseJsonBody(request) as { enabled_broker_ids: string[] };
          putBodies.push(body.enabled_broker_ids);
        },
        method: "PUT",
        path: "/api/brokers/selections",
        respond: (request) => {
          const body = parseJsonBody(request) as { enabled_broker_ids: string[] };
          return jsonResponse(brokerSelectionResponse(body.enabled_broker_ids));
        },
      },
    ]);

    renderWithProviders(<BrokerRegistryPage />);

    expect(await screen.findByText("Acme Data")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Search brokers"), "second");
    await screen.findByText("1 of 3 matches");

    await user.click(screen.getByRole("button", { name: "Enable all" }));
    await waitFor(() => expect(putBodies).toContainEqual(["second"]));

    await user.click(screen.getByRole("button", { name: "Disable all" }));
    await waitFor(() => expect(putBodies).toContainEqual([]));
  });

  it("opens a reset-all confirmation modal and resets only filtered opt-out records", async () => {
    const user = userEvent.setup();
    const resetPaths: string[] = [];
    mockApi([
      { body: [broker, secondBroker, thirdBroker], path: "/api/brokers" },
      { body: brokerSelectionResponse(["second"]), path: "/api/brokers/selections" },
      {
        body: [
          optOut({ broker_id: "acme", broker_name: "Acme Data", status: "COMPLETED" }),
          optOut({ broker_id: "second", broker_name: "Second Broker", status: "FAILED" }),
        ],
        path: optOutsIncludeDisabledPath,
      },
      {
        assert: (request) => resetPaths.push(request.path),
        body: { broker_id: "second", status: "reset" },
        method: "POST",
        path: "/api/optouts/second/reset",
      },
    ]);

    renderWithProviders(<BrokerRegistryPage />);

    expect(await screen.findByText("Acme Data")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Search brokers"), "second");
    await screen.findByText("1 of 3 matches");

    await user.click(screen.getByRole("button", { name: "Reset all" }));

    const dialog = screen.getByRole("dialog", { name: "Reset 1 brokers?" });
    expect(dialog).toHaveTextContent(
      "This will reset opt-out records for 1 brokers back to PENDING. Active outreach and completion state will be lost. Continue?",
    );

    await user.click(within(dialog).getByRole("button", { name: "Confirm reset" }));

    await waitFor(() => expect(resetPaths).toEqual(["/api/optouts/second/reset"]));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Reset 1 brokers?" })).not.toBeInTheDocument());
  });

  it("shows a warning when persisted broker selections approach Firestore limits", async () => {
    mockApi([
      { body: [broker], path: "/api/brokers" },
      {
        body: brokerSelectionResponse(
          ["acme"],
          "Broker selection document is 512,000 bytes, approaching the 1 MiB Firestore document limit.",
        ),
        path: "/api/brokers/selections",
      },
    ]);

    renderWithProviders(<BrokerRegistryPage />);

    expect(await screen.findByTestId("broker-selection-size-warning")).toHaveTextContent(
      "Broker selection document is 512,000 bytes",
    );
  });

  it("shows reset only for broker rows with opt-out records", async () => {
    mockApi([
      { body: [broker, secondBroker], path: "/api/brokers" },
      { body: brokerSelectionResponse(["acme"]), path: "/api/brokers/selections" },
      {
        body: [optOut({ broker_id: "acme", broker_name: "Acme Data", status: "COMPLETED" })],
        path: optOutsIncludeDisabledPath,
      },
    ]);

    renderWithProviders(<BrokerRegistryPage />);

    const acmeRow = (await screen.findByText("Acme Data")).closest("tr");
    const secondRow = screen.getByText("Second Broker").closest("tr");
    expect(acmeRow).not.toBeNull();
    expect(secondRow).not.toBeNull();
    expect(within(acmeRow as HTMLTableRowElement).getByRole("button", { name: "Reset opt-out for Acme Data" }))
      .toBeInTheDocument();
    expect(within(acmeRow as HTMLTableRowElement).getByRole("button", { name: "Inspect Acme Data record" }))
      .toBeInTheDocument();
    expect(within(acmeRow as HTMLTableRowElement).getByText("Removed")).toBeInTheDocument();
    expect(
      within(secondRow as HTMLTableRowElement).queryByRole("button", { name: "Reset opt-out for Second Broker" }),
    ).not.toBeInTheDocument();
    expect(
      within(secondRow as HTMLTableRowElement).queryByRole("button", { name: "Inspect Second Broker record" }),
    ).not.toBeInTheDocument();
    expect(within(secondRow as HTMLTableRowElement).getByText("No record")).toBeInTheDocument();
  });

  it("hides reset actions for disabled broker rows", async () => {
    mockApi([
      { body: [broker, secondBroker], path: "/api/brokers" },
      { body: brokerSelectionResponse(["second"]), path: "/api/brokers/selections" },
      {
        body: [
          optOut({ broker_id: "acme", broker_name: "Acme Data", status: "COMPLETED" }),
          optOut({ broker_id: "second", broker_name: "Second Broker", status: "FAILED" }),
        ],
        path: optOutsIncludeDisabledPath,
      },
    ]);

    renderWithProviders(<BrokerRegistryPage />);

    const acmeRow = (await screen.findByText("Acme Data")).closest("tr");
    const secondRow = screen.getByText("Second Broker").closest("tr");
    expect(acmeRow).not.toBeNull();
    expect(secondRow).not.toBeNull();
    expect(
      within(acmeRow as HTMLTableRowElement).queryByRole("button", { name: "Reset opt-out for Acme Data" }),
    ).not.toBeInTheDocument();
    expect(acmeRow).toHaveAttribute(
      "title",
      "This broker is disabled. Enable it in Settings to include in outreach.",
    );
    expect(acmeRow).toHaveClass("bg-surface-sunken");
    expect(within(acmeRow as HTMLTableRowElement).getByText("Removed")).toHaveClass("opacity-60", "grayscale");
    expect(within(secondRow as HTMLTableRowElement).getByRole("button", { name: "Reset opt-out for Second Broker" }))
      .toBeInTheDocument();
  });

  it("requires confirmation before resetting and refreshes broker data on success", async () => {
    const user = userEvent.setup();
    let resetRequests = 0;
    const brokerLoads: MockApiRequest[] = [];
    const optOutLoads: MockApiRequest[] = [];
    mockApi([
      {
        assert: (request) => brokerLoads.push(request),
        body: [broker, secondBroker],
        path: "/api/brokers",
      },
      { body: brokerSelectionResponse(["acme"]), path: "/api/brokers/selections" },
      {
        assert: (request) => optOutLoads.push(request),
        path: optOutsIncludeDisabledPath,
        respond: () =>
          jsonResponse([
            optOut({
              broker_id: "acme",
              broker_name: "Acme Data",
              status: resetRequests > 0 ? "PENDING" : "COMPLETED",
            }),
          ]),
      },
      {
        assert: () => {
          resetRequests += 1;
        },
        body: { broker_id: "acme", status: "reset" },
        method: "POST",
        path: "/api/optouts/acme/reset",
      },
    ]);

    renderWithProviders(<BrokerRegistryPage />);

    await user.click(await screen.findByRole("button", { name: "Reset opt-out for Acme Data" }));

    expect(resetRequests).toBe(0);
    expect(screen.getByRole("button", { name: "Confirm reset for Acme Data" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Confirm reset for Acme Data" }));

    await waitFor(() => expect(resetRequests).toBe(1));
    await waitFor(() => expect(brokerLoads.length).toBeGreaterThan(1));
    await waitFor(() => expect(optOutLoads.length).toBeGreaterThan(1));
    expect(await screen.findByText("Queued")).toBeInTheDocument();
  });

  it("shows row loading state while reset is pending", async () => {
    const user = userEvent.setup();
    let resolveReset!: (response: Response) => void;
    const pendingReset = new Promise<Response>((resolve) => {
      resolveReset = resolve;
    });
    mockApi([
      { body: [broker], path: "/api/brokers" },
      { body: brokerSelectionResponse(["acme"]), path: "/api/brokers/selections" },
      {
        body: [optOut({ broker_id: "acme", broker_name: "Acme Data", status: "COMPLETED" })],
        path: optOutsIncludeDisabledPath,
      },
      {
        method: "POST",
        path: "/api/optouts/acme/reset",
        respond: () => pendingReset,
      },
    ]);

    renderWithProviders(<BrokerRegistryPage />);

    await user.click(await screen.findByRole("button", { name: "Reset opt-out for Acme Data" }));
    await user.click(screen.getByRole("button", { name: "Confirm reset for Acme Data" }));

    expect(await screen.findByRole("button", { name: "Resetting opt-out for Acme Data" })).toBeDisabled();

    resolveReset(jsonResponse({ broker_id: "acme", status: "reset" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Reset opt-out for Acme Data" })).toBeInTheDocument(),
    );
  });

  it("shows missing broker details as inline field feedback", async () => {
    const user = userEvent.setup();
    mockApi([{ body: [broker], path: "/api/brokers" }]);

    renderWithProviders(<BrokerRegistryPage />);

    expect(await screen.findByText("Acme Data")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add broker" }));

    expect(screen.getAllByText("Broker name and domain are required.")).toHaveLength(2);
    expect(screen.queryByRole("heading", { name: "Broker registry is unavailable" })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Broker name"), "New Broker");
    expect(screen.queryByText("Broker name and domain are required.")).not.toBeInTheDocument();
  });

  it("searches brokers, adds a broker to the top, and deletes rows", async () => {
    const user = userEvent.setup();
    const createdBodies: unknown[] = [];
    const deletedIds: string[] = [];
    mockApi([
      { body: [broker, secondBroker], path: "/api/brokers" },
      {
        assert: (request) => createdBodies.push(parseJsonBody(request)),
        body: {
          aliases: [],
          domain: "new.example",
          id: "new-broker",
          name: "New Broker",
          notes: "",
          privacy_email: "privacy@new.example",
        },
        method: "POST",
        path: "/api/brokers",
      },
      {
        assert: (request) => deletedIds.push(request.path.split("/").pop() ?? ""),
        method: "DELETE",
        path: "/api/brokers/acme",
      },
    ]);

    renderWithProviders(<BrokerRegistryPage />);

    expect(await screen.findByText("Acme Data")).toBeInTheDocument();
    expect(screen.getByText("0 of 2 enabled")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Search brokers"), "privacy@second.example");
    expect(await screen.findByText("Second Broker")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Acme Data")).not.toBeInTheDocument());

    await user.clear(screen.getByLabelText("Search brokers"));
    await waitFor(() => expect(screen.getByText("Acme Data")).toBeInTheDocument());
    await user.type(screen.getByLabelText("Broker name"), " New Broker ");
    await user.type(screen.getByLabelText("Domain"), " new.example ");
    await user.click(screen.getByRole("button", { name: "Add broker" }));

    await waitFor(() =>
      expect(createdBodies).toEqual([
        {
          aliases: [],
          domain: "new.example",
          name: "New Broker",
          notes: "",
          privacy_email: "privacy@new.example",
        },
      ]),
    );

    const tableRows = within(screen.getByRole("table", { name: "Broker registry" })).getAllByRole("row");
    expect(tableRows[1]).toHaveTextContent("New Broker");
    expect(screen.getByText("New Broker").closest("tr")).toHaveClass("ss-rowin");
    expect(screen.getByText("0 of 3 enabled")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete Acme Data" }));

    await waitFor(() => expect(deletedIds).toEqual(["acme"]));
    expect(screen.queryByText("Acme Data")).not.toBeInTheDocument();
    expect(screen.getByText("0 of 2 enabled")).toBeInTheDocument();
  });

  it("shows the enabled count, warns at zero enabled, and disables outreach", async () => {
    mockApi([{ body: [broker, secondBroker], path: "/api/brokers" }]);

    renderWithProviders(<BrokerRegistryPage />);

    expect(await screen.findByText("0 of 2 enabled")).toBeInTheDocument();
    expect(screen.getByTestId("brokers-no-enabled-warning")).toHaveTextContent(
      "No brokers enabled — outreach won't run",
    );
    expect(screen.getByRole("button", { name: "Run outreach" })).toBeDisabled();
  });

  it("shows Switch toggles per broker and persists toggles to the server", async () => {
    const user = userEvent.setup();
    const putBodies: string[][] = [];
    mockApi([
      { body: [broker, secondBroker], path: "/api/brokers" },
      { body: { enabled_broker_ids: ["acme"] }, path: "/api/brokers/selections" },
      {
        assert: (request) => {
          const body = parseJsonBody(request) as { enabled_broker_ids: string[] };
          putBodies.push(body.enabled_broker_ids);
        },
        body: { enabled_broker_ids: ["acme", "second"] },
        method: "PUT",
        path: "/api/brokers/selections",
      },
    ]);

    renderWithProviders(<BrokerRegistryPage />);

    const acmeToggle = await screen.findByTestId("broker-enabled-toggle-acme");
    const secondToggle = await screen.findByTestId("broker-enabled-toggle-second");
    expect(screen.getByText("1 of 2 enabled")).toBeInTheDocument();
    expect(acmeToggle).toHaveAttribute("role", "switch");
    expect(acmeToggle).toHaveAttribute("aria-checked", "true");
    expect(acmeToggle.closest("td")).toHaveTextContent("On");
    // New brokers are disabled by default until explicitly enabled.
    expect(secondToggle).toHaveAttribute("role", "switch");
    expect(secondToggle).toHaveAttribute("aria-checked", "false");
    expect(secondToggle.closest("td")).toHaveTextContent("Off");

    await user.click(secondToggle);

    await waitFor(() => {
      expect(putBodies).toContainEqual(["acme", "second"]);
    });
  });

  it("runs outreach from enabled brokers and routes the throw overlay to status", async () => {
    const user = userEvent.setup();
    const outreachBodies: unknown[] = [];
    mockReducedSmokeOverlay();
    mockApi([
      { body: [broker, secondBroker], path: "/api/brokers" },
      { body: { enabled_broker_ids: ["acme", "second"] }, path: "/api/brokers/selections" },
      {
        assert: (request) => outreachBodies.push(parseJsonBody(request)),
        body: { dry_run: false, processed: ["acme", "second"], processed_count: 2, status: "sent" },
        method: "POST",
        path: "/api/outreach",
      },
    ]);

    renderWithProviders(
      <>
        <BrokerRegistryPage />
        <LocationProbe />
      </>,
      { route: "/brokers" },
    );

    expect(await screen.findByText("Acme Data")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Run outreach" }));

    expect(screen.getByRole("dialog", { name: "Sending opt-out requests" })).toBeInTheDocument();
    await waitFor(() => expect(outreachBodies).toEqual([{ broker_ids: ["acme", "second"] }]));
    expect(await screen.findByText("Deployment complete")).toBeInTheDocument();
    expect(screen.getByText(/2 opt-out requests are on their way/)).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Sending opt-out requests" })).not.toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "Run outreach" }));
    expect(await screen.findByText("Deployment complete")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View status" }));

    expect(screen.getByTestId("location-path")).toHaveTextContent("/");
    expect(screen.queryByRole("dialog", { name: "Sending opt-out requests" })).not.toBeInTheDocument();
  });
});

describe("TrustedSendersPage", () => {
  it("approves pending senders and adds manual trusted senders", async () => {
    const user = userEvent.setup();
    const approvedIds: number[] = [];
    const manualBodies: unknown[] = [];
    const trustedSender: WhitelistEntry = {
      added_at: "2026-06-20T12:00:00Z",
      broker_id: "acme",
      email: "privacy@acme.example",
      id: 1,
      source: "registry",
    };
    const pendingSender: PendingWhitelistEntry = {
      broker_id: "acme",
      detected_at: "2026-06-21T12:00:00Z",
      email: "unknown@relay.example",
      id: 7,
      message_snippet: "Please reply from this address.",
      message_subject: "Opt-out request",
      status: "pending",
    };
    mockApi([
      { body: [trustedSender], path: "/api/whitelist" },
      { body: [pendingSender], path: "/api/whitelist/pending" },
      { body: [broker], path: "/api/brokers" },
      {
        assert: () => approvedIds.push(7),
        body: { ...trustedSender, email: pendingSender.email, id: 8, source: "manual" },
        method: "POST",
        path: "/api/whitelist/pending/7/approve",
      },
      {
        assert: (request) => manualBodies.push(parseJsonBody(request)),
        body: { ...trustedSender, email: "manual@acme.example", id: 9, source: "manual" },
        method: "POST",
        path: "/api/whitelist",
      },
    ]);

    renderWithProviders(<TrustedSendersPage />);

    expect(await screen.findByText("unknown@relay.example")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Trust" }));
    await waitFor(() => expect(approvedIds).toEqual([7]));

    await user.selectOptions(screen.getByLabelText("Broker"), "acme");
    await user.type(screen.getByLabelText("Email address"), "manual@acme.example");
    await user.click(screen.getByRole("button", { name: "Add sender" }));

    await waitFor(() => expect(manualBodies).toEqual([{ broker_id: "acme", email: "manual@acme.example" }]));
  });
});

describe("SettingsPage", () => {
  const trustedSender: WhitelistEntry = {
    added_at: "2026-06-20T12:00:00Z",
    broker_id: "acme",
    email: "privacy@acme.example",
    id: 1,
    source: "registry",
  };
  const pendingSender: PendingWhitelistEntry = {
    broker_id: "acme",
    detected_at: "2026-06-21T12:00:00Z",
    email: "unknown@relay.example",
    id: 7,
    message_snippet: "Please reply from this address.",
    message_subject: "Opt-out request",
    status: "pending",
  };
  const profileGap: ProfileGap = {
    ask_count: 2,
    broker_ids: ["acme", "second"],
    field_label: "Phone number",
    field_name: "phone_number",
    first_asked_at: "2026-07-01T12:00:00Z",
    last_asked_at: "2026-07-03T12:00:00Z",
  };

  function settingsPageRoutes({
    advancedBody = advancedSettings,
    pendingBody = [pendingSender],
    profileGapsBody = [],
    profileBody = verificationProfile,
    settingsBody = settings,
    whitelistBody = [trustedSender],
  }: {
    advancedBody?: AdvancedSettings;
    pendingBody?: PendingWhitelistEntry[];
    profileGapsBody?: ProfileGap[];
    profileBody?: VerificationProfile;
    settingsBody?: FriendlySettings;
    whitelistBody?: WhitelistEntry[];
  } = {}): Parameters<typeof mockApi>[0] {
    return [
      { body: settingsBody, path: "/api/settings" },
      { body: profileBody, path: "/api/settings/verification-profile" },
      { body: profileGapsBody, path: "/api/settings/profile-gaps" },
      { body: advancedBody, path: "/api/settings/advanced" },
      { body: whitelistBody, path: "/api/whitelist" },
      { body: pendingBody, path: "/api/whitelist/pending" },
      { body: [broker], path: "/api/brokers" },
    ];
  }

  it("renders the redesigned shell with rail badge and no per-card save buttons", async () => {
    const user = userEvent.setup();
    mockApi(settingsPageRoutes());

    renderWithProviders(<SettingsPage />);

    expect(await screen.findByLabelText("Full name")).toHaveValue("Jane Doe");
    expect(screen.getByLabelText("Sender email")).toHaveValue("jane@example.com");
    const rail = screen.getByRole("navigation", { name: "Settings sections" });
    const trustedRailItem = within(rail).getByRole("button", { name: /Trusted senders/ });
    expect(trustedRailItem).toHaveTextContent("1");
    expect(screen.getByRole("slider", { name: "Re-request cadence" })).toHaveValue("30");
    expect(screen.getByRole("slider", { name: "Silent-broker timeout" })).toHaveValue("14");
    expect(screen.queryByRole("button", { name: "Save identity" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save cadence" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save timeout" })).not.toBeInTheDocument();

    await user.click(within(rail).getByRole("button", { name: "Cadence" }));
    expect(within(rail).getByRole("button", { name: "Cadence" })).toHaveAttribute("aria-current", "true");
  });

  it("test_settings_shows_gap_advisory_panel_when_gaps_exist", async () => {
    mockApi(settingsPageRoutes({ profileGapsBody: [profileGap] }));

    renderWithProviders(<SettingsPage />);

    expect(await screen.findByTestId("profile-gap-advisory")).toBeInTheDocument();
    expect(screen.getByText("Field requests from brokers")).toBeInTheDocument();
    expect(
      screen.getByText("Adding these to your Verification Profile may help future opt-outs proceed without manual review."),
    ).toBeInTheDocument();
    expect(screen.getByText("Phone number")).toBeInTheDocument();
    expect(screen.getByText("2 brokers asked")).toBeInTheDocument();
  });

  it("test_settings_hides_gap_advisory_panel_when_no_gaps", async () => {
    mockApi(settingsPageRoutes({ profileGapsBody: [] }));

    renderWithProviders(<SettingsPage />);

    expect(await screen.findByLabelText("Full name")).toBeInTheDocument();
    expect(screen.queryByTestId("profile-gap-advisory")).not.toBeInTheDocument();
    expect(screen.queryByText("Field requests from brokers")).not.toBeInTheDocument();
  });

  it("test_gap_advisory_expands_broker_list_on_click", async () => {
    const user = userEvent.setup();
    mockApi(settingsPageRoutes({ profileGapsBody: [profileGap] }));

    renderWithProviders(<SettingsPage />);

    await screen.findByTestId("profile-gap-advisory");
    const disclosure = screen.getByText("Which brokers?").closest("details");
    expect(disclosure).not.toHaveAttribute("open");

    await user.click(screen.getByText("Which brokers?"));

    expect(disclosure).toHaveAttribute("open");
    expect(screen.getByText("acme")).toBeInTheDocument();
    expect(screen.getByText("second")).toBeInTheDocument();
  });

  it("filters trusted senders inside a scrollable container and restores the full list when cleared", async () => {
    const user = userEvent.setup();
    const trustedSenders: WhitelistEntry[] = [
      { ...trustedSender, id: 1, email: "privacy@acme.example", broker_id: "acme", source: "registry" },
      { ...trustedSender, id: 2, email: "billing@acme.example", broker_id: "acme", source: "manual" },
      { ...trustedSender, id: 3, email: "newsletter@acme.example", broker_id: "acme", source: "manual" },
      { ...trustedSender, id: 4, email: "ops@relay.example", broker_id: "second", source: "manual" },
      { ...trustedSender, id: 5, email: "alerts@relay.example", broker_id: "second", source: "registry" },
      { ...trustedSender, id: 6, email: "support@acme.example", broker_id: "acme", source: "manual" },
      { ...trustedSender, id: 7, email: "legal@acme.example", broker_id: "acme", source: "registry" },
      { ...trustedSender, id: 8, email: "reply@acme.example", broker_id: "acme", source: "manual" },
    ];
    mockApi(settingsPageRoutes({ whitelistBody: trustedSenders }));

    renderWithProviders(<SettingsPage />);

    const scrollContainer = await screen.findByTestId("trusted-senders-scroll");
    expect(scrollContainer).toHaveClass("overflow-y-auto");
    expect(scrollContainer).toHaveClass("max-h-[360px]");

    const searchInput = screen.getByLabelText("Search trusted senders");
    await user.type(searchInput, "SECOND");

    await waitFor(() => expect(screen.getByText("2 of 8 matches")).toBeInTheDocument());
    expect(screen.getByText("ops@relay.example")).toBeInTheDocument();
    expect(screen.getByText("alerts@relay.example")).toBeInTheDocument();
    expect(screen.queryByText("privacy@acme.example")).not.toBeInTheDocument();

    await user.clear(searchInput);
    await waitFor(() => expect(screen.queryByText("2 of 8 matches")).not.toBeInTheDocument());
    expect(screen.getByText("privacy@acme.example")).toBeInTheDocument();

    await user.type(searchInput, "zzz");
    await waitFor(() =>
      expect(screen.getByText("No approved senders match your search.")).toBeInTheDocument(),
    );
    expect(screen.queryByText("ops@relay.example")).not.toBeInTheDocument();
  });

  it("saves a verification profile from settings", async () => {
    const user = userEvent.setup();
    const savedProfiles: unknown[] = [];
    mockApi([
      ...settingsPageRoutes(),
      {
        assert: (request) => {
          if (request.init?.body) {
            savedProfiles.push(parseJsonBody(request));
          }
        },
        respond: (request) => jsonResponse(parseJsonBody(request)),
        method: "PUT",
        path: "/api/settings/verification-profile",
      },
    ]);

    renderWithProviders(<SettingsPage />);

    await screen.findByRole("heading", { name: "Fields brokers may ask for" });
    await user.type(screen.getByLabelText("Street"), "1 Main St");
    await user.type(screen.getByLabelText("City"), "Springfield");
    await user.type(screen.getByLabelText("State"), "CA");
    await user.type(screen.getByLabelText("ZIP"), "90210");
    await user.type(screen.getByLabelText("Country"), "US");
    await user.type(screen.getByLabelText("Phone numbers 1"), "+1 555 0100");
    await user.type(screen.getByLabelText("Email aliases 1"), "old@example.com");
    await user.type(screen.getByLabelText("Document label"), "Utility Bill");
    await user.type(screen.getByLabelText("Storage note"), "Offline file cabinet");
    await user.type(screen.getByLabelText("Date of birth"), "1990-01-01");
    await user.type(screen.getByLabelText("Last four SSN"), "1234");
    await user.type(screen.getByLabelText("Employer name"), "Acme");
    await user.click(screen.getByRole("button", { name: "Save profile" }));

    await waitFor(() => {
      expect(savedProfiles).toHaveLength(1);
    });
    expect(savedProfiles[0]).toEqual({
      additional_notes: null,
      date_of_birth: "1990-01-01",
      documents: [
        {
          label: "Utility Bill",
          storage_note: "Offline file cabinet",
        },
      ],
      email_aliases: ["old@example.com"],
      employer_name: "Acme",
      home_addresses: [
        {
          city: "Springfield",
          country: "US",
          state: "CA",
          street: "1 Main St",
          zip: "90210",
        },
      ],
      last_four_ssn: "1234",
      phone_numbers: ["+1 555 0100"],
    });
    expect(await screen.findByText("Verification profile saved.")).toBeInTheDocument();
  });

  it("manages trusted senders from the embedded settings section", async () => {
    const user = userEvent.setup();
    const approvedIds: number[] = [];
    const rejectedIds: number[] = [];
    const deletedIds: number[] = [];
    const manualBodies: unknown[] = [];
    const manualSender: WhitelistEntry = {
      added_at: "2026-06-22T12:00:00Z",
      broker_id: "acme",
      email: "manual@acme.example",
      id: 2,
      source: "manual",
    };
    const rejectedSender: PendingWhitelistEntry = {
      ...pendingSender,
      email: "junk@relay.example",
      id: 8,
    };
    const apiMock = mockApi([
      ...settingsPageRoutes({
        pendingBody: [pendingSender, rejectedSender],
        whitelistBody: [trustedSender, manualSender],
      }),
      {
        assert: () => approvedIds.push(7),
        body: { ...trustedSender, email: pendingSender.email, id: 9, source: "manual" },
        method: "POST",
        path: "/api/whitelist/pending/7/approve",
      },
      {
        assert: () => rejectedIds.push(8),
        body: { id: 8, status: "rejected" },
        method: "POST",
        path: "/api/whitelist/pending/8/reject",
      },
      {
        assert: (request) => manualBodies.push(parseJsonBody(request)),
        body: { ...manualSender, email: "new@acme.example", id: 10 },
        method: "POST",
        path: "/api/whitelist",
      },
      {
        assert: () => deletedIds.push(2),
        method: "DELETE",
        path: "/api/whitelist/2",
      },
    ]);

    renderWithProviders(<SettingsPage />);

    expect(await screen.findByTestId("trusted-senders-section")).toBeInTheDocument();
    expect(screen.getByText("unknown@relay.example")).toBeInTheDocument();
    expect(screen.getByText("2 senders need review")).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: "Approve" })[0]);
    await waitFor(() => expect(approvedIds).toEqual([7]));

    await user.click(screen.getAllByRole("button", { name: "Reject" })[1]);
    await waitFor(() => expect(rejectedIds).toEqual([8]));

    await user.selectOptions(screen.getByLabelText("Broker"), "acme");
    await user.type(screen.getByLabelText("Email address"), "new@acme.example");
    await user.click(screen.getByRole("button", { name: "Add sender" }));
    await waitFor(() => expect(manualBodies).toEqual([{ broker_id: "acme", email: "new@acme.example" }]));

    const initialWhitelistGets = apiMock.calls.filter(
      (call) => call.method === "GET" && call.path === "/api/whitelist",
    ).length;
    await user.click(screen.getByRole("button", { name: "Remove trusted sender manual@acme.example" }));
    expect(screen.getByRole("button", { name: "Confirm remove trusted sender manual@acme.example" })).toBeInTheDocument();
    expect(deletedIds).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Confirm remove trusted sender manual@acme.example" }));
    await waitFor(() => expect(deletedIds).toEqual([2]));
    await waitFor(() =>
      expect(
        apiMock.calls.filter((call) => call.method === "GET" && call.path === "/api/whitelist").length,
      ).toBeGreaterThan(initialWhitelistGets),
    );
  });

  it("batches changed fields into one sticky save-bar PUT", async () => {
    const user = userEvent.setup();
    const savedBodies: unknown[] = [];
    mockApi([
      ...settingsPageRoutes(),
      {
        assert: (request) => savedBodies.push(parseJsonBody(request)),
        body: { restart_required: true, status: "saved" },
        method: "PUT",
        path: "/api/settings",
      },
    ]);

    renderWithProviders(<SettingsPage />);

    const nameInput = await screen.findByLabelText("Full name");
    await user.clear(nameInput);
    await user.type(nameInput, "Jane Smith");
    await user.click(screen.getByRole("button", { name: "Quarterly" }));
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(savedBodies).toEqual([{ rerequest_interval_days: 90, sender_name: "Jane Smith" }]),
    );
    expect(await screen.findByText("Saved. Restart Smokescreen to apply every change.")).toBeInTheDocument();
  });

  it("shows an error state when the sticky save fails", async () => {
    const user = userEvent.setup();
    mockApi([
      ...settingsPageRoutes(),
      {
        body: { detail: "settings backend rejected the update" },
        method: "PUT",
        path: "/api/settings",
        status: 500,
      },
    ]);

    renderWithProviders(<SettingsPage />);

    const nameInput = await screen.findByLabelText("Full name");
    await user.clear(nameInput);
    await user.type(nameInput, "Jane Smith");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Settings were not saved")).toBeInTheDocument();
  });

  it("shows Gemini as the active default provider and saves its model fields without an API key", async () => {
    const user = userEvent.setup();
    const savedBodies: unknown[] = [];
    mockApi([
      ...settingsPageRoutes({
        advancedBody: { ...advancedSettings, ai_provider: "gemini", gemini_project: "smokescreen-prod" },
        settingsBody: { ...settings, ai_provider: "gemini", gemini_model: "gemini-3.1-flash-lite" },
      }),
      {
        assert: (request) => savedBodies.push(parseJsonBody(request)),
        body: { restart_required: false, status: "saved" },
        method: "PUT",
        path: "/api/settings",
      },
    ]);

    renderWithProviders(<SettingsPage />);

    expect(await screen.findAllByText("Active · Vertex AI")).toHaveLength(2);
    expect(screen.queryByLabelText("Anthropic API key")).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText("GCP project"));
    await user.type(screen.getByLabelText("GCP project"), "vertex-prod");
    await user.clear(screen.getByLabelText("Gemini model"));
    await user.type(screen.getByLabelText("Gemini model"), "gemini-2.5-flash");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(savedBodies).toEqual([
        {
          gemini_model: "gemini-2.5-flash",
          gemini_project: "vertex-prod",
        },
      ]),
    );
  });

  it("reveals Claude key and model fields and saves Claude opt-in settings", async () => {
    const user = userEvent.setup();
    const savedBodies: unknown[] = [];
    mockApi([
      ...settingsPageRoutes({
        advancedBody: { ...advancedSettings, ai_provider: "gemini" },
        settingsBody: { ...settings, ai_provider: "gemini", anthropic_api_key: "" },
      }),
      {
        assert: (request) => savedBodies.push(parseJsonBody(request)),
        body: { restart_required: false, status: "saved" },
        method: "PUT",
        path: "/api/settings",
      },
    ]);

    renderWithProviders(<SettingsPage />);

    expect(await screen.findAllByText("Active · Vertex AI")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: /Claude/ }));

    expect(screen.getAllByText("Key required")).toHaveLength(2);
    expect(screen.getByLabelText("Anthropic API key")).toHaveValue("");
    expect(screen.getByLabelText("Claude model")).toHaveValue("claude-sonnet-4-20250514");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();

    await user.type(screen.getByLabelText("Anthropic API key"), "sk-ant-test");
    await user.clear(screen.getByLabelText("Claude model"));
    await user.type(screen.getByLabelText("Claude model"), "claude-opus-test");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(savedBodies).toEqual([
        {
          ai_provider: "anthropic",
          anthropic_api_key: "sk-ant-test",
          anthropic_model: "claude-opus-test",
        },
      ]),
    );
  });

  it("disables env-locked cadence sliders and keeps their copy visible", async () => {
    mockApi(
      settingsPageRoutes({
        settingsBody: {
          ...settings,
          rerequest_interval_days: 90,
          rerequest_interval_days_from_env: true,
          state_timeout_days: 30,
          state_timeout_days_from_env: true,
        },
      }),
    );

    renderWithProviders(<SettingsPage />);

    const rerequestSlider = await screen.findByRole("slider", { name: "Re-request cadence" });
    const timeoutSlider = screen.getByRole("slider", { name: "Silent-broker timeout" });
    expect(rerequestSlider).toBeDisabled();
    expect(rerequestSlider).toHaveAttribute("min", "7");
    expect(rerequestSlider).toHaveAttribute("max", "365");
    expect(rerequestSlider).toHaveValue("90");
    expect(timeoutSlider).toBeDisabled();
    expect(timeoutSlider).toHaveValue("30");
    expect(screen.getAllByText("Set by environment")).toHaveLength(2);
    expect(screen.getByText(/every 90 days - quarterly/i)).toBeInTheDocument();
  });

  it("saves advanced fields and dry-run switch through the sticky save bar", async () => {
    const user = userEvent.setup();
    const savedBodies: unknown[] = [];
    mockApi([
      ...settingsPageRoutes(),
      {
        assert: (request) => savedBodies.push(parseJsonBody(request)),
        body: { restart_required: false, status: "saved" },
        method: "PUT",
        path: "/api/settings",
      },
    ]);

    renderWithProviders(<SettingsPage />);

    await screen.findByLabelText("Full name");
    await user.click(screen.getByRole("button", { name: /Gmail poll label, retries, and dry run/i }));
    await user.clear(screen.getByLabelText("Gmail poll label"));
    await user.type(screen.getByLabelText("Gmail poll label"), "custom-label");
    await user.click(screen.getByRole("switch", { name: "Dry run" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(savedBodies).toEqual([{ dry_run: true, poll_label: "custom-label" }]),
    );
  });

  it("discards unsaved changes from the sticky save bar", async () => {
    const user = userEvent.setup();
    mockApi(settingsPageRoutes());

    renderWithProviders(<SettingsPage />);

    const nameInput = await screen.findByLabelText("Full name");
    await user.clear(nameInput);
    await user.type(nameInput, "Jane Smith");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Discard" }));

    expect(screen.getByLabelText("Full name")).toHaveValue("Jane Doe");
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
  });
});

describe("NeedsAttentionPage", () => {
  it("renders status-specific guidance for attention records", async () => {
    mockApi([
      {
        body: [
          optOut({
            broker_id: "rejected",
            broker_name: "Rejected Broker",
            needs_manual_reason: {
              reason_code: "broker_rejected",
              short_summary: "Broker rejected the deletion request.",
              broker_reply_excerpt: "The broker declined the request.",
              classifier_output: { classification: "REJECTED" },
              missing_fields: [],
              transitioned_at: "2026-06-22T15:30:00Z",
            },
            notes: "The broker declined the request.",
            status: "NEEDS_MANUAL",
          }),
          optOut({
            broker_id: "manual",
            broker_name: "Manual Broker",
            missing_fields: ["phone_number"],
            notes: "The broker asked for a signed form.",
            requested_fields: ["home_address", "phone_number"],
            status: "NEEDS_MANUAL",
          }),
          optOut({
            broker_id: "failed",
            broker_name: "Failed Broker",
            notes: "The broker contact bounced.",
            status: "FAILED",
          }),
        ],
        path: "/api/optouts?status=needs_attention",
      },
      { body: brokerSelectionResponse(["rejected", "manual", "failed"]), path: "/api/brokers/selections" },
    ]);

    renderWithProviders(<NeedsAttentionPage />);

    expect(await screen.findByText("Rejected Broker")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Inspect Rejected Broker record" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Inspect Manual Broker record" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Inspect Failed Broker record" })).toBeInTheDocument();
    screen.getAllByText("Needs Attention Details").forEach((summary) => fireEvent.click(summary));
    expect(screen.getByText("Broker rejected the request")).toBeInTheDocument();
    expect(
      screen.getByText("Review the reply, accept the rejection, or escalate with additional context."),
    ).toBeInTheDocument();
    expect(screen.getByText("Review the broker reply")).toBeInTheDocument();
    expect(
      screen.getByText("Open the source email. Resolve it yourself and mark handled, or retry the request."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Broker asked for: Home address, Phone number. You are missing: Phone number."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Verification Profile/ })).toHaveAttribute(
      "href",
      "/settings#settings-verification-profile",
    );
    expect(screen.getByText("Retry after checking details")).toBeInTheDocument();
    expect(screen.getByText("Check the broker contact and reply. Retry when fixed, or mark handled.")).toBeInTheDocument();
  });

  it("test_needs_attention_shows_accept_and_escalate_for_broker_rejected", async () => {
    mockApi([
      {
        body: [
          optOut({
            broker_id: "rejected",
            broker_name: "Rejected Broker",
            needs_manual_reason: {
              reason_code: "broker_rejected",
              short_summary: "Broker rejected the deletion request.",
              broker_reply_excerpt: "The broker declined the request.",
              classifier_output: { classification: "REJECTED" },
              missing_fields: [],
              transitioned_at: "2026-06-22T15:30:00Z",
            },
            status: "NEEDS_MANUAL",
          }),
        ],
        path: "/api/optouts?status=needs_attention",
      },
      { body: brokerSelectionResponse(["rejected"]), path: "/api/brokers/selections" },
    ]);

    renderWithProviders(<NeedsAttentionPage />);

    expect(await screen.findByText("Rejected Broker")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept rejection" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Escalate" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark handled" })).not.toBeInTheDocument();
    expect(screen.queryByText("The broker declined the request.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Needs Attention Details"));
    expect(screen.getByText("broker_rejected")).toBeInTheDocument();
    expect(screen.getByText("The broker declined the request.")).toBeInTheDocument();
  });

  it("test_accept_rejection_confirmation_and_mutation", async () => {
    const user = userEvent.setup();
    const acceptPaths: string[] = [];
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    let attentionLoads = 0;
    mockApi([
      {
        path: "/api/optouts?status=needs_attention",
        respond: () => {
          attentionLoads += 1;
          return jsonResponse(
            attentionLoads > 1
              ? []
              : [
                  optOut({
                    broker_id: "acme",
                    broker_name: "Acme Data",
                    needs_manual_reason: {
                      reason_code: "broker_rejected",
                      short_summary: "Broker rejected the deletion request.",
                      broker_reply_excerpt: "The broker declined the request.",
                      classifier_output: { classification: "REJECTED" },
                      missing_fields: [],
                      transitioned_at: "2026-06-22T15:30:00Z",
                    },
                    status: "NEEDS_MANUAL",
                  }),
                ],
          );
        },
      },
      {
        assert: (request) => acceptPaths.push(request.path),
        method: "POST",
        path: "/api/optouts/acme/accept_rejection",
        body: optOut({ broker_id: "acme", needs_manual_reason: null, status: "REJECTED" }),
      },
      { body: brokerSelectionResponse(["acme"]), path: "/api/brokers/selections" },
    ]);

    renderWithProviders(<NeedsAttentionPage />);

    expect(await screen.findByText("Acme Data")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Accept rejection" }));

    expect(confirmSpy).toHaveBeenCalledWith(
      "Accept this rejection? The record will be marked REJECTED and excluded from future outreach cycles.",
    );
    await waitFor(() => expect(acceptPaths).toEqual(["/api/optouts/acme/accept_rejection"]));
    await waitFor(() => expect(attentionLoads).toBeGreaterThan(1));
    expect(await screen.findByText("Queue clear")).toBeInTheDocument();
  });

  it("test_escalate_rejection_form_validation_and_submission", async () => {
    const user = userEvent.setup();
    const escalationBodies: unknown[] = [];
    let attentionLoads = 0;
    mockApi([
      {
        path: "/api/optouts?status=needs_attention",
        respond: () => {
          attentionLoads += 1;
          return jsonResponse(
            attentionLoads > 1
              ? []
              : [
                  optOut({
                    broker_id: "acme",
                    broker_name: "Acme Data",
                    needs_manual_reason: {
                      reason_code: "broker_rejected",
                      short_summary: "Broker rejected the deletion request.",
                      broker_reply_excerpt: "The broker declined the request.",
                      classifier_output: { classification: "REJECTED" },
                      missing_fields: [],
                      transitioned_at: "2026-06-22T15:30:00Z",
                    },
                    status: "NEEDS_MANUAL",
                  }),
                ],
          );
        },
      },
      {
        assert: (request) => escalationBodies.push(parseJsonBody(request)),
        method: "POST",
        path: "/api/optouts/acme/escalate_rejection",
        body: optOut({ broker_id: "acme", needs_manual_reason: null, status: "REJECTED_REBUTTED" }),
      },
      { body: brokerSelectionResponse(["acme"]), path: "/api/brokers/selections" },
    ]);

    renderWithProviders(<NeedsAttentionPage />);

    expect(await screen.findByText("Acme Data")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Escalate" }));
    await user.click(screen.getByRole("button", { name: "Submit escalation" }));

    expect(screen.getByText("Context is required before escalating.")).toBeInTheDocument();
    expect(escalationBodies).toEqual([]);

    await user.type(
      screen.getByLabelText(
        "Provide additional context to strengthen your escalation. This will be used by the AI to compose a stronger rebuttal.",
      ),
      "This listing exposes a minor household member.",
    );
    await user.click(screen.getByRole("button", { name: "Submit escalation" }));

    await waitFor(() =>
      expect(escalationBodies).toEqual([
        { context: "This listing exposes a minor household member." },
      ]),
    );
    await waitFor(() => expect(attentionLoads).toBeGreaterThan(1));
    expect(await screen.findByText("Queue clear")).toBeInTheDocument();
  });

  it("filters disabled broker records out of the review queue", async () => {
    mockApi([
      {
        body: [
          optOut({
            broker_id: "manual",
            broker_name: "Manual Broker",
            notes: "The broker asked for a signed form.",
            status: "NEEDS_MANUAL",
          }),
          optOut({
            broker_id: "disabled",
            broker_name: "Disabled Broker",
            notes: "This disabled broker should stay hidden.",
            status: "FAILED",
          }),
        ],
        path: "/api/optouts?status=needs_attention",
      },
      { body: brokerSelectionResponse(["manual"]), path: "/api/brokers/selections" },
    ]);

    renderWithProviders(<NeedsAttentionPage />);

    expect(await screen.findByText("Manual Broker")).toBeInTheDocument();
    expect(screen.queryByText("Disabled Broker")).not.toBeInTheDocument();
    expect(screen.queryByText("This disabled broker should stay hidden.")).not.toBeInTheDocument();
  });

  it("renders structured needs-manual summary with expandable details", async () => {
    mockApi([
      {
        body: [
          optOut({
            broker_id: "manual",
            broker_name: "Manual Broker",
            missing_fields: ["phone_number"],
            needs_manual_reason: {
              reason_code: "info_request_missing_fields",
              short_summary: "Broker requested a phone number missing from the Verification Profile.",
              broker_reply_excerpt: "Please send the phone number associated with this listing.",
              classifier_output: {
                classification: "INFO_REQUEST",
                requested_fields: ["phone_number"],
                other_details: "Use the listing phone.",
              },
              missing_fields: ["phone_number"],
              transitioned_at: "2026-06-22T15:30:00Z",
            },
            notes: "Legacy note should not be the compact summary.",
            requested_fields: ["phone_number"],
            status: "NEEDS_MANUAL",
          }),
        ],
        path: "/api/optouts?status=needs_attention",
      },
      { body: brokerSelectionResponse(["manual"]), path: "/api/brokers/selections" },
    ]);

    renderWithProviders(<NeedsAttentionPage />);

    expect(
      await screen.findByText("Broker requested a phone number missing from the Verification Profile."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Please send the phone number associated with this listing.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Needs Attention Details"));

    expect(screen.getByText("info_request_missing_fields")).toBeInTheDocument();
    expect(screen.getByText("Please send the phone number associated with this listing.")).toBeInTheDocument();
    expect(screen.getAllByText("phone_number").length).toBeGreaterThan(0);
    expect(screen.getByText(/"classification": "INFO_REQUEST"/)).toBeInTheDocument();
    expect(screen.getAllByText(/2026/).length).toBeGreaterThan(0);
  });

  it("shows the state timeline in expanded needs-manual details", async () => {
    mockApi([
      {
        body: [
          optOut({
            broker_id: "manual",
            broker_name: "Manual Broker",
            needs_manual_reason: {
              reason_code: "info_request_missing_fields",
              short_summary: "Broker requested a phone number.",
              broker_reply_excerpt: "Please send your phone number.",
              classifier_output: { classification: "INFO_REQUEST" },
              missing_fields: ["phone_number"],
              transitioned_at: "2026-07-07T15:00:00Z",
            },
            state_history: [
              {
                from_status: "PENDING",
                to_status: "INITIAL_SENT",
                transitioned_at: "2026-07-07T12:00:00Z",
                reason: "initial opt-out request sent",
                message_id: "sent-1",
              },
              {
                from_status: "INITIAL_SENT",
                to_status: "NEEDS_MANUAL",
                transitioned_at: "2026-07-07T15:00:00Z",
                reason: "broker requested unavailable info",
                message_id: "reply-1",
              },
            ],
            status: "NEEDS_MANUAL",
          }),
        ],
        path: "/api/optouts?status=needs_attention",
      },
      { body: brokerSelectionResponse(["manual"]), path: "/api/brokers/selections" },
    ]);

    renderWithProviders(<NeedsAttentionPage />);

    expect(await screen.findByText("Manual Broker")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Needs Attention Details"));

    const timeline = screen.getByTestId("state-timeline");
    expect(within(timeline).getAllByText("Request sent").length).toBeGreaterThan(0);
    expect(within(timeline).getByText("broker requested unavailable info")).toBeInTheDocument();
    expect(screen.getByTestId("state-timeline-latest")).toHaveClass("border-bd-olive");
  });

  it("test_needs_attention_shows_excerpt_by_default", async () => {
    const replyExcerpt = "Classifier summary: Broker needs the phone number from the listing.";
    const rawReply = `${replyExcerpt}\n\nFull raw broker reply with headers and quoted history.`;
    mockApi([
      {
        body: [
          optOut({
            broker_id: "manual",
            broker_name: "Manual Broker",
            needs_manual_reason: {
              reason_code: "classifier_returned_needs_manual",
              short_summary: "Classifier flagged the broker reply for manual review.",
              broker_reply_excerpt: replyExcerpt,
              raw_reply_body: rawReply,
              classifier_output: { classification: "NEEDS_MANUAL" },
              missing_fields: [],
              transitioned_at: "2026-06-22T15:30:00Z",
            },
            status: "NEEDS_MANUAL",
          }),
        ],
        path: "/api/optouts?status=needs_attention",
      },
      { body: brokerSelectionResponse(["manual"]), path: "/api/brokers/selections" },
    ]);

    renderWithProviders(<NeedsAttentionPage />);

    expect(await screen.findByText("Manual Broker")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Needs Attention Details"));

    expect(screen.getByText(replyExcerpt)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show full reply" })).toBeInTheDocument();
    expect(screen.queryByText("Full raw broker reply with headers and quoted history.")).not.toBeInTheDocument();
  });

  it("test_needs_attention_show_full_reply_expands_to_raw", async () => {
    const replyExcerpt = "Classifier summary: Broker needs the phone number from the listing.";
    const rawReply = `${replyExcerpt}\n\nFull raw broker reply with headers and quoted history.`;
    mockApi([
      {
        body: [
          optOut({
            broker_id: "manual",
            broker_name: "Manual Broker",
            needs_manual_reason: {
              reason_code: "classifier_returned_needs_manual",
              short_summary: "Classifier flagged the broker reply for manual review.",
              broker_reply_excerpt: replyExcerpt,
              raw_reply_body: rawReply,
              classifier_output: { classification: "NEEDS_MANUAL" },
              missing_fields: [],
              transitioned_at: "2026-06-22T15:30:00Z",
            },
            status: "NEEDS_MANUAL",
          }),
        ],
        path: "/api/optouts?status=needs_attention",
      },
      { body: brokerSelectionResponse(["manual"]), path: "/api/brokers/selections" },
    ]);

    renderWithProviders(<NeedsAttentionPage />);

    expect(await screen.findByText("Manual Broker")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Needs Attention Details"));
    fireEvent.click(screen.getByRole("button", { name: "Show full reply" }));

    expect(screen.getByText("Full broker reply")).toBeInTheDocument();
    expect(
      screen.getByText((_, element) => element?.tagName.toLowerCase() === "pre" && element.textContent === rawReply),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide full reply" })).toBeInTheDocument();
  });

  it("test_needs_attention_copy_full_reply", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const replyExcerpt = "Classifier summary: Broker needs the phone number from the listing.";
    const rawReply = `${replyExcerpt}\n\nFull raw broker reply with headers and quoted history.`;
    mockApi([
      {
        body: [
          optOut({
            broker_id: "manual",
            broker_name: "Manual Broker",
            needs_manual_reason: {
              reason_code: "classifier_returned_needs_manual",
              short_summary: "Classifier flagged the broker reply for manual review.",
              broker_reply_excerpt: replyExcerpt,
              raw_reply_body: rawReply,
              classifier_output: { classification: "NEEDS_MANUAL" },
              missing_fields: [],
              transitioned_at: "2026-06-22T15:30:00Z",
            },
            status: "NEEDS_MANUAL",
          }),
        ],
        path: "/api/optouts?status=needs_attention",
      },
      { body: brokerSelectionResponse(["manual"]), path: "/api/brokers/selections" },
    ]);

    renderWithProviders(<NeedsAttentionPage />);

    expect(await screen.findByText("Manual Broker")).toBeInTheDocument();
    await user.click(screen.getByText("Needs Attention Details"));
    await user.click(screen.getByRole("button", { name: "Show full reply" }));
    await user.click(screen.getByRole("button", { name: "Copy to clipboard" }));

    expect(writeText).toHaveBeenCalledWith(rawReply);
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("marks an item handled after manual review", async () => {
    const user = userEvent.setup();
    const handledIds: string[] = [];
    mockApi([
      {
        body: [
          optOut({
            notes: "Broker wants a signed form before continuing.",
            status: "NEEDS_MANUAL",
          }),
        ],
        path: "/api/optouts?status=needs_attention",
      },
      {
        assert: () => handledIds.push("acme"),
        method: "POST",
        path: "/api/optouts/acme/handled",
        body: { broker_id: "acme", status: "handled" },
      },
      { body: brokerSelectionResponse(["acme"]), path: "/api/brokers/selections" },
    ]);

    const { container } = renderWithProviders(<NeedsAttentionPage />);

    expect(
      (await screen.findAllByText("Broker wants a signed form before continuing.")).length,
    ).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Mark handled" }));

    expect(await screen.findByRole("button", { name: "Marking handled" })).toBeDisabled();
    await waitFor(() => expect(handledIds).toEqual(["acme"]));
    expect(await screen.findByText("Queue clear")).toBeInTheDocument();
    expect(screen.getByText("Every broker reply has been handled.")).toBeInTheDocument();
    expect(container.querySelector('img[src="/assets/glyph-mail-smoke.png"]')).toBeInTheDocument();
  });

  it("retries classification through the existing thread and refetches the queue", async () => {
    const user = userEvent.setup();
    const retryPaths: string[] = [];
    let resolveRetry!: (response: Response) => void;
    const pendingRetry = new Promise<Response>((resolve) => {
      resolveRetry = resolve;
    });
    let attentionLoads = 0;
    mockApi([
      {
        path: "/api/optouts?status=needs_attention",
        respond: () => {
          attentionLoads += 1;
          return jsonResponse(
            attentionLoads > 1
              ? []
              : [
                  optOut({
                    broker_id: "acme",
                    broker_name: "Acme Data",
                    notes: "Broker asked for a phone number.",
                    status: "NEEDS_MANUAL",
                  }),
                ],
          );
        },
      },
      {
        assert: (request) => retryPaths.push(request.path),
        method: "POST",
        path: "/api/optouts/acme/retry_classification",
        respond: () => pendingRetry,
      },
      { body: brokerSelectionResponse(["acme"]), path: "/api/brokers/selections" },
    ]);

    renderWithProviders(<NeedsAttentionPage />);

    expect((await screen.findAllByText("Broker asked for a phone number.")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("button", { name: "Retrying" })).toBeDisabled();
    expect(retryPaths).toEqual(["/api/optouts/acme/retry_classification"]);

    resolveRetry(
      jsonResponse(
        optOut({
          broker_id: "acme",
          broker_name: "Acme Data",
          previous_status: null,
          status: "INFO_REQUESTED",
        }),
      ),
    );

    await waitFor(() => expect(attentionLoads).toBeGreaterThan(1));
    expect(await screen.findByText("Queue clear")).toBeInTheDocument();
    expect(screen.queryByText("Broker asked for a phone number.")).not.toBeInTheDocument();
  });

  it("surfaces retry validation errors inline", async () => {
    const user = userEvent.setup();
    mockApi([
      {
        body: [
          optOut({
            broker_id: "acme",
            broker_name: "Acme Data",
            notes: "Old manual record with no source thread.",
            status: "NEEDS_MANUAL",
            thread_id: null,
          }),
        ],
        path: "/api/optouts?status=needs_attention",
      },
      {
        method: "POST",
        path: "/api/optouts/acme/retry_classification",
        respond: () =>
          new Response(
            JSON.stringify({
              detail: "Cannot retry: broker record has no thread. Use Reset to start over.",
            }),
            {
              headers: { "Content-Type": "application/json" },
              status: 400,
            },
          ),
      },
      { body: brokerSelectionResponse(["acme"]), path: "/api/brokers/selections" },
    ]);

    renderWithProviders(<NeedsAttentionPage />);

    expect((await screen.findAllByText("Old manual record with no source thread.")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Request was not retried")).toBeInTheDocument();
    expect(
      screen.getByText("Cannot retry: broker record has no thread. Use Reset to start over."),
    ).toBeInTheDocument();
  });
});
