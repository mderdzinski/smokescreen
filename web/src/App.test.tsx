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
  anthropic_api_key: "",
  gmail_connected: false,
  gmail_connected_email: "",
  gmail_credentials_available: false,
  gmail_token_available: false,
  identity_configured: false,
  identity_docs_dir: "identity/",
  sender_email: "jane@example.com",
  sender_name: "Jane Doe",
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
    ]);

    renderWithProviders(<App />);

    expect(screen.getByRole("link", { name: "Status" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Setup" })).toHaveAttribute("href", "/setup");
    expect(screen.getByRole("link", { name: "Brokers" })).toHaveAttribute("href", "/brokers");
    expect(screen.getByRole("link", { name: /Needs Attention/ })).toHaveAttribute("href", "/needs-attention");
    expect(screen.getByRole("link", { name: "Status" })).toHaveAttribute("aria-current", "page");
    expect(await screen.findByText("2")).toHaveClass("ss-badge-live");
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
});

describe("OnboardingPage", () => {
  it("blocks the first batch until identity, Gmail, Claude, and brokers are ready", async () => {
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
    expect(window.localStorage.getItem("smokescreen:onboarding-complete")).toBe("true");
  });
});

describe("BrokerRegistryPage", () => {
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

    renderWithProviders(<NeedsAttentionPage />);

    expect(await screen.findByText("Broker wants a signed form before continuing.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Mark handled" }));

    expect(await screen.findByRole("button", { name: "Marking handled" })).toBeDisabled();
    await waitFor(() => expect(handledIds).toEqual(["acme"]));
    expect(await screen.findByText("Queue clear")).toBeInTheDocument();
  });
});
