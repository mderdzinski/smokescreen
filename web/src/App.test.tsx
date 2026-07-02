import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  App,
  NeedsAttentionPage,
  OverviewPage,
  SettingsPage,
  TrustedSendersPage,
} from "./App";
import { BrokerRegistryPage } from "./pages/BrokerRegistryPage";
import { OnboardingPage } from "./pages/OnboardingPage";
import type {
  AdvancedSettings,
  Broker,
  ExtendedStats,
  FriendlySettings,
  OptOutRecord,
  PendingWhitelistEntry,
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
  identity_docs_dir: "identity/",
  sender_email: "jane@example.com",
  sender_email_from_env: false,
  sender_name: "Jane Doe",
  sender_name_from_env: false,
};

const advancedSettings: AdvancedSettings = {
  anthropic_model: "claude-sonnet-4-20250514",
  dry_run: false,
  max_retries: 5,
  poll_label: "smokescreen",
  rerequest_interval_days: 60,
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
    last_message_id: "msg-1",
    notes: "",
    retries: 0,
    status: "AWAITING_RESPONSE",
    thread_id: "thread-1",
    updated_at: "2026-06-21T12:00:00Z",
    ...overrides,
  };
}

function parseJsonBody(request: MockApiRequest): unknown {
  return JSON.parse(String(request.init?.body));
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

    expect(screen.getByRole("link", { name: "Status" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Setup" })).toHaveAttribute("href", "/setup");
    expect(screen.getByRole("link", { name: "Brokers" })).toHaveAttribute("href", "/brokers");
    expect(screen.getByRole("link", { name: /Needs Attention/ })).toHaveAttribute("href", "/needs-attention");
    expect(screen.getByRole("link", { name: "Status" })).toHaveAttribute("aria-current", "page");
    expect(await screen.findByText("2")).toHaveClass("ss-badge-live");
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

    renderWithProviders(<App />, { route: "/setup" });

    const statusTab = screen.getByRole("link", { name: "Status" });
    const setupTab = screen.getByRole("link", { name: "Setup" });

    expect(statusTab).not.toHaveAttribute("aria-current");
    expect(statusTab.querySelector("[data-ss-active-tab-rule='true']")).toBeNull();
    expect(setupTab).toHaveAttribute("aria-current", "page");
    expect(setupTab.querySelector("[data-ss-active-tab-rule='true']")).toBeInTheDocument();
  });

  it("shows a sign-out button linking to the signed-out route and surfaces the operator email", async () => {
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

    expect(await screen.findByTestId("app-user-email")).toHaveTextContent("signed-in@example.com");
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

  it("warns when no brokers are enabled and outreach will not run", async () => {
    mockApi([
      { body: emptyStats, path: "/api/stats/extended" },
      { body: [], path: "/api/optouts" },
      // Default mock already returns { enabled_broker_ids: [] } — keep it.
    ]);

    renderWithProviders(<OverviewPage />);

    const banner = await screen.findByTestId("no-brokers-enabled-banner");
    expect(banner).toHaveTextContent(/No brokers configured/i);
    expect(within(banner).getByRole("link", { name: /Configure brokers/i })).toHaveAttribute(
      "href",
      "/setup",
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
    ]);

    renderWithProviders(<OverviewPage />);

    expect(await screen.findByRole("heading", { name: "0 brokers requesting removal of your data" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Review requests/ })).toHaveAttribute("href", "/needs-attention");
    expect(screen.getByText("Review")).toBeInTheDocument();
    expect(screen.getByText("Broker requested a signed identity form.")).toBeInTheDocument();
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
            IDENTITY_REQUESTED: 1,
            IDENTITY_SENT: 1,
            INITIAL_SENT: 1,
            PENDING: 1,
            REJECTED: 1,
          },
          completed_count: 1,
          needs_attention: 2,
          total: 8,
        },
        path: "/api/stats/extended",
      },
      {
        body: [
          optOut({ broker_id: "queued", broker_name: "Queued Broker", status: "PENDING" }),
          optOut({ broker_id: "sent", broker_name: "Sent Broker", status: "INITIAL_SENT" }),
          optOut({ broker_id: "awaiting", broker_name: "Awaiting Broker", status: "AWAITING_RESPONSE" }),
          optOut({ broker_id: "id-requested", broker_name: "ID Request Broker", status: "IDENTITY_REQUESTED" }),
          optOut({ broker_id: "id-sent", broker_name: "ID Sent Broker", status: "IDENTITY_SENT" }),
          optOut({ broker_id: "done", broker_name: "Done Broker", status: "COMPLETED" }),
          optOut({ broker_id: "rejected", broker_name: "Rejected Broker", status: "REJECTED" }),
          optOut({ broker_id: "failed", broker_name: "Failed Broker", status: "FAILED" }),
        ],
        path: "/api/optouts",
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
    expect(within(workingColumn).getByText("ID Request Broker")).toBeInTheDocument();
    expect(within(workingColumn).getByText("ID Sent Broker")).toBeInTheDocument();
    expect(within(doneColumn).getByText("Done Broker")).toBeInTheDocument();
    expect(within(attentionColumn).getByText("Rejected Broker")).toBeInTheDocument();
    expect(within(attentionColumn).getByText("Failed Broker")).toBeInTheDocument();
  });
});

describe("OnboardingPage", () => {
  it("walks through the four setup steps and gates launch until prerequisites are complete", async () => {
    const user = userEvent.setup();
    const savedBodies: unknown[] = [];
    mockApi([
      { body: settings, path: "/api/settings" },
      { body: advancedSettings, path: "/api/settings/advanced" },
      { body: [broker, secondBroker], path: "/api/brokers" },
      {
        assert: (request) => savedBodies.push(parseJsonBody(request)),
        body: { restart_required: false, status: "saved" },
        method: "PUT",
        path: "/api/settings",
      },
    ]);

    renderWithProviders(<OnboardingPage />);

    expect(await screen.findByRole("heading", { name: "Configure identity" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Brokers Step 3/ }));
    expect(await screen.findByRole("heading", { name: "Pick brokers" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continue/ })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /Identity Step 1/ }));
    await screen.findByRole("heading", { name: "Configure identity" });
    await user.clear(screen.getByLabelText("Full name"));
    await user.type(screen.getByLabelText("Full name"), "Jane Smith");
    await user.clear(screen.getByLabelText("Gmail address"));
    await user.type(screen.getByLabelText("Gmail address"), "jane@gmail.com");
    await user.click(screen.getByRole("button", { name: "Save identity" }));

    expect(await screen.findByRole("heading", { name: "AI provider" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Anthropic API key"), "sk-ant-test");
    await user.click(screen.getByRole("button", { name: "Save API key" }));

    expect(await screen.findByRole("heading", { name: "Pick brokers" })).toBeInTheDocument();
    const acmeCheckbox = screen.getByRole("checkbox", { name: /Acme Data/ });
    await user.click(acmeCheckbox);

    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(acmeCheckbox.closest("label")).toHaveClass("bg-fill-olive");
    await user.click(screen.getByRole("button", { name: /Continue/ }));

    expect(await screen.findByRole("heading", { name: "Send first batch" })).toBeInTheDocument();
    expect(screen.getByText("Anthropic (Claude)")).toBeInTheDocument();
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send first batch" })).toBeEnabled();
    expect(savedBodies).toEqual([
      {
        sender_email: "jane@gmail.com",
        sender_name: "Jane Smith",
      },
      {
        anthropic_api_key: "sk-ant-test",
      },
    ]);
  });

  it("persists broker picks to the server when the user toggles them", async () => {
    const user = userEvent.setup();
    const selectionBodies: string[][] = [];
    window.localStorage.setItem("smokescreen:onboarding-step", "2");
    mockApi([
      { body: settings, path: "/api/settings" },
      { body: advancedSettings, path: "/api/settings/advanced" },
      { body: [broker, secondBroker], path: "/api/brokers" },
      {
        assert: (request) => {
          const body = parseJsonBody(request) as { enabled_broker_ids: string[] };
          selectionBodies.push(body.enabled_broker_ids);
        },
        body: { enabled_broker_ids: ["acme"] },
        method: "PUT",
        path: "/api/brokers/selections",
      },
    ]);

    renderWithProviders(<OnboardingPage />);

    expect(await screen.findByRole("heading", { name: "Pick brokers" })).toBeInTheDocument();
    const acmeCheckbox = await screen.findByRole("checkbox", { name: /Acme Data/ });
    await user.click(acmeCheckbox);

    await waitFor(() => {
      expect(selectionBodies).toContainEqual(["acme"]);
    });
    // Toggling a second broker persists the accumulated set — proving the
    // picker treats the server, not localStorage, as the source of truth.
    await user.click(await screen.findByRole("checkbox", { name: /Second Broker/ }));
    await waitFor(() => {
      expect(selectionBodies.some((body) => body.length === 2 && body.includes("acme") && body.includes("second"))).toBe(
        true,
      );
    });
  });

  it("blocks the first batch until required setup is ready", async () => {
    window.localStorage.setItem("smokescreen:onboarding-step", "3");
    window.localStorage.setItem("smokescreen:onboarding-brokers", JSON.stringify(["acme"]));
    const { calls } = mockApi([
      { body: settings, path: "/api/settings" },
      { body: advancedSettings, path: "/api/settings/advanced" },
      { body: [broker], path: "/api/brokers" },
    ]);

    renderWithProviders(<OnboardingPage />);

    expect(await screen.findByRole("heading", { name: "Send first batch" })).toBeInTheDocument();
    expect(screen.getByText("Missing identity")).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText("Missing key")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send first batch" })).toBeDisabled();
    expect(calls.some((call) => call.path === "/api/outreach")).toBe(false);
  });

  it("starts the first batch with selected brokers and shows the throw overlay when setup is complete", async () => {
    const user = userEvent.setup();
    const outreachBodies: unknown[] = [];
    mockReducedSmokeOverlay();
    window.localStorage.setItem("smokescreen:onboarding-step", "3");
    window.localStorage.setItem("smokescreen:onboarding-brokers", JSON.stringify(["acme"]));
    mockApi([
      {
        body: {
          ...settings,
          anthropic_api_key: "stored",
          gmail_connected: true,
          gmail_connected_email: "jane@gmail.com",
          identity_configured: true,
        },
        path: "/api/settings",
      },
      { body: { ...advancedSettings, dry_run: true }, path: "/api/settings/advanced" },
      { body: [broker], path: "/api/brokers" },
      {
        assert: (request) => outreachBodies.push(parseJsonBody(request)),
        body: { dry_run: true, processed: ["acme"], processed_count: 1, status: "sent" },
        method: "POST",
        path: "/api/outreach",
      },
    ]);

    renderWithProviders(<OnboardingPage />);

    expect(await screen.findByText("Dry run is on. The first batch will be prepared without sending email.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send first batch" }));

    expect(screen.getByRole("dialog", { name: "Sending opt-out requests" })).toBeInTheDocument();
    await waitFor(() => expect(outreachBodies).toEqual([{ broker_ids: ["acme"] }]));
    expect(await screen.findByText("Deployment complete")).toBeInTheDocument();
    expect(screen.getByText(/1 opt-out request is on their way/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(await screen.findByText("Smoke's out.")).toBeInTheDocument();
    expect(screen.getByText("1 opt-out request is on the way. Track them on the Status board.")).toBeInTheDocument();
    expect(window.localStorage.getItem("smokescreen:onboarding-complete")).toBe("true");
  });

  it("keeps the launch overlay pending until the first batch is accepted", async () => {
    const user = userEvent.setup();
    let resolveOutreach: (() => void) | undefined;
    mockReducedSmokeOverlay();
    window.localStorage.setItem("smokescreen:onboarding-step", "3");
    window.localStorage.setItem("smokescreen:onboarding-brokers", JSON.stringify(["acme"]));
    mockApi([
      {
        body: {
          ...settings,
          anthropic_api_key: "stored",
          gmail_connected: true,
          gmail_connected_email: "jane@gmail.com",
          identity_configured: true,
        },
        path: "/api/settings",
      },
      { body: advancedSettings, path: "/api/settings/advanced" },
      { body: [broker], path: "/api/brokers" },
      {
        method: "POST",
        path: "/api/outreach",
        respond: () =>
          new Promise<Response>((resolve) => {
            resolveOutreach = () =>
              resolve(
                new Response(JSON.stringify({ dry_run: false, processed: ["acme"], processed_count: 1, status: "sent" }), {
                  headers: { "Content-Type": "application/json" },
                }),
              );
          }),
      },
    ]);

    renderWithProviders(<OnboardingPage />);

    expect(await screen.findByRole("heading", { name: "Send first batch" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send first batch" }));
    expect(screen.getByRole("dialog", { name: "Sending opt-out requests" })).toBeInTheDocument();

    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(screen.getByText("Deploying smokescreen · going dark")).toBeInTheDocument();
    expect(screen.queryByText("Deployment complete")).not.toBeInTheDocument();

    resolveOutreach?.();

    expect(await screen.findByText("Deployment complete")).toBeInTheDocument();
    expect(screen.getByText(/1 opt-out request is on their way/)).toBeInTheDocument();
  });

  it("renders identity read-only when sender is configured via deployment", async () => {
    mockApi([
      {
        body: {
          ...settings,
          sender_email: "deploy@example.com",
          sender_email_from_env: true,
          sender_name: "Deploy User",
          sender_name_from_env: true,
        },
        path: "/api/settings",
      },
      { body: advancedSettings, path: "/api/settings/advanced" },
      { body: [broker], path: "/api/brokers" },
    ]);

    renderWithProviders(<OnboardingPage />);

    expect(await screen.findByRole("heading", { name: "Configure identity" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("identity-sender-email")).toHaveTextContent("deploy@example.com"),
    );
    expect(screen.getByText(/Configured via deployment/)).toBeInTheDocument();
    expect(screen.getByTestId("identity-sender-name")).toHaveTextContent("Deploy User");
    expect(screen.getByText(/update your Terraform variables/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Full name")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Gmail address")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save identity" })).not.toBeInTheDocument();
  });

  it("shows Gemini AI provider as configured with no API key input", async () => {
    window.localStorage.setItem("smokescreen:onboarding-step", "1");
    mockApi([
      {
        body: {
          ...settings,
          ai_provider: "gemini",
          gemini_model: "gemini-3.1-flash-lite",
          sender_email_from_env: true,
          sender_name_from_env: true,
        },
        path: "/api/settings",
      },
      { body: advancedSettings, path: "/api/settings/advanced" },
      { body: [broker], path: "/api/brokers" },
    ]);

    renderWithProviders(<OnboardingPage />);

    expect(await screen.findByText(/Gemini \(gemini-3\.1-flash-lite\)/)).toBeInTheDocument();
    expect(screen.getByText(/Vertex AI/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Anthropic API key")).not.toBeInTheDocument();
    expect(screen.queryByText(/Claude reads/i)).not.toBeInTheDocument();
  });

  it("shows Anthropic secret-manager mode as configured with no API key input", async () => {
    window.localStorage.setItem("smokescreen:onboarding-step", "1");
    mockApi([
      {
        body: {
          ...settings,
          ai_provider: "anthropic",
          anthropic_key_from_secret: true,
        },
        path: "/api/settings",
      },
      { body: advancedSettings, path: "/api/settings/advanced" },
      { body: [broker], path: "/api/brokers" },
    ]);

    renderWithProviders(<OnboardingPage />);

    expect(await screen.findByText(/Secret Manager/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Anthropic API key")).not.toBeInTheDocument();
  });

  it("keeps launch checklist honest for a fully deployed environment", async () => {
    window.localStorage.setItem("smokescreen:onboarding-step", "3");
    window.localStorage.setItem("smokescreen:onboarding-brokers", JSON.stringify(["acme"]));
    mockApi([
      {
        body: {
          ...settings,
          ai_provider: "gemini",
          gemini_model: "gemini-3.1-flash-lite",
          gmail_configured: true,
          gmail_connected: true,
          gmail_connected_email: "deploy@example.com",
          identity_configured: true,
          sender_email: "deploy@example.com",
          sender_email_from_env: true,
          sender_name: "Deploy User",
          sender_name_from_env: true,
        },
        path: "/api/settings",
      },
      { body: advancedSettings, path: "/api/settings/advanced" },
      { body: [broker], path: "/api/brokers" },
      { body: { enabled_broker_ids: ["acme"] }, path: "/api/brokers/selections" },
    ]);

    renderWithProviders(<OnboardingPage />);

    expect(await screen.findByRole("heading", { name: "Send first batch" })).toBeInTheDocument();
    expect(await screen.findByText("Gemini (gemini-3.1-flash-lite)")).toBeInTheDocument();
    expect(screen.getAllByText("deploy@example.com").length).toBeGreaterThan(0);
    expect(screen.queryByText("Missing identity")).not.toBeInTheDocument();
    expect(screen.queryByText("Missing key")).not.toBeInTheDocument();
  });
});

describe("BrokerRegistryPage", () => {
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
    expect(screen.getByText("2 brokers")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Search brokers"), "privacy@second.example");
    expect(screen.getByText("Second Broker")).toBeInTheDocument();
    expect(screen.queryByText("Acme Data")).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText("Search brokers"));
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
    expect(screen.getByText("3 brokers")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete Acme Data" }));

    await waitFor(() => expect(deletedIds).toEqual(["acme"]));
    expect(screen.queryByText("Acme Data")).not.toBeInTheDocument();
    expect(screen.getByText("2 brokers")).toBeInTheDocument();
  });

  it("shows Enabled/Disabled per broker and persists toggles to the server", async () => {
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
    expect(acmeToggle).toHaveTextContent(/Enabled/);
    expect(acmeToggle).toHaveAttribute("aria-pressed", "true");
    // New brokers are disabled by default until explicitly enabled.
    expect(secondToggle).toHaveTextContent(/Disabled/);
    expect(secondToggle).toHaveAttribute("aria-pressed", "false");

    await user.click(secondToggle);

    await waitFor(() => {
      expect(putBodies).toContainEqual(["acme", "second"]);
    });
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
  it("saves identity settings and shows the saved state", async () => {
    const user = userEvent.setup();
    const savedBodies: unknown[] = [];
    mockApi([
      { body: settings, path: "/api/settings" },
      { body: advancedSettings, path: "/api/settings/advanced" },
      {
        assert: (request) => savedBodies.push(parseJsonBody(request)),
        body: { restart_required: false, status: "saved" },
        method: "PUT",
        path: "/api/settings",
      },
    ]);

    renderWithProviders(<SettingsPage />);

    await screen.findByDisplayValue("Jane Doe");
    await user.clear(screen.getByLabelText("Sender name"));
    await user.type(screen.getByLabelText("Sender name"), "Jane Smith");
    await user.click(screen.getByRole("button", { name: "Save identity" }));

    await waitFor(() =>
      expect(savedBodies).toEqual([
        {
          identity_docs_dir: "identity/",
          sender_email: "jane@example.com",
          sender_name: "Jane Smith",
        },
      ]),
    );
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
  });

  it("shows an error state when settings fail to save", async () => {
    const user = userEvent.setup();
    mockApi([
      { body: settings, path: "/api/settings" },
      { body: advancedSettings, path: "/api/settings/advanced" },
      {
        body: { detail: "settings backend rejected the update" },
        method: "PUT",
        path: "/api/settings",
        status: 500,
      },
    ]);

    renderWithProviders(<SettingsPage />);

    await screen.findByDisplayValue("Jane Doe");
    await user.clear(screen.getByLabelText("Sender name"));
    await user.type(screen.getByLabelText("Sender name"), "Jane Smith");
    await user.click(screen.getByRole("button", { name: "Save identity" }));

    expect(await screen.findByText("Settings were not saved")).toBeInTheDocument();
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
            notes: "The broker declined the request.",
            status: "REJECTED",
          }),
          optOut({
            broker_id: "manual",
            broker_name: "Manual Broker",
            notes: "The broker asked for a signed form.",
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
    ]);

    renderWithProviders(<NeedsAttentionPage />);

    expect(await screen.findByText("Rejected Broker")).toBeInTheDocument();
    expect(screen.getByText("Broker rejected the request")).toBeInTheDocument();
    expect(screen.getByText("Read the reply, change the request details, then retry — or mark handled.")).toBeInTheDocument();
    expect(screen.getByText("Review the broker reply")).toBeInTheDocument();
    expect(
      screen.getByText("Open the source email. Resolve it yourself and mark handled, or retry the request."),
    ).toBeInTheDocument();
    expect(screen.getByText("Retry after checking details")).toBeInTheDocument();
    expect(screen.getByText("Check the broker contact and reply. Retry when fixed, or mark handled.")).toBeInTheDocument();
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
    ]);

    const { container } = renderWithProviders(<NeedsAttentionPage />);

    expect(await screen.findByText("Broker wants a signed form before continuing.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Mark handled" }));

    expect(await screen.findByRole("button", { name: "Marking handled" })).toBeDisabled();
    await waitFor(() => expect(handledIds).toEqual(["acme"]));
    expect(await screen.findByText("Queue clear")).toBeInTheDocument();
    expect(screen.getByText("Every broker reply has been handled.")).toBeInTheDocument();
    expect(container.querySelector('img[src="/assets/glyph-mail-smoke.png"]')).toBeInTheDocument();
  });
});
