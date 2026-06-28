import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
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

beforeEach(() => {
  window.localStorage.clear();
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
      await screen.findByRole("heading", { name: "Smokescreen is ready for broker requests" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Add brokers/ })).toHaveAttribute("href", "/brokers");
    expect(screen.getAllByText("No items here")).toHaveLength(3);
  });

  it("prioritizes broker replies that need review", async () => {
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

    expect(await screen.findByRole("heading", { name: "1 broker needs your review" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Review requests/ })).toHaveAttribute("href", "/needs-attention");
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

  it("starts the first batch with selected brokers when setup is complete", async () => {
    const user = userEvent.setup();
    const outreachBodies: unknown[] = [];
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

    await waitFor(() => expect(outreachBodies).toEqual([{ broker_ids: ["acme"] }]));
    expect(window.localStorage.getItem("smokescreen:onboarding-complete")).toBe("true");
  });
});

describe("BrokerRegistryPage", () => {
  it("validates broker details, adds a broker, and edits an existing broker", async () => {
    const user = userEvent.setup();
    const createdBodies: unknown[] = [];
    const updatedBodies: unknown[] = [];
    mockApi([
      { body: [broker], path: "/api/brokers" },
      {
        assert: (request) => createdBodies.push(parseJsonBody(request)),
        body: {
          aliases: ["new.example"],
          domain: "new.example",
          id: "new-broker",
          name: "New Broker",
          notes: "New notes",
          privacy_email: "privacy@new.example",
        },
        method: "POST",
        path: "/api/brokers",
      },
      {
        assert: (request) => updatedBodies.push(parseJsonBody(request)),
        body: { ...broker, name: "Acme Search" },
        method: "PUT",
        path: "/api/brokers/acme",
      },
    ]);

    renderWithProviders(<BrokerRegistryPage />);

    expect(await screen.findByText("Acme Data")).toBeInTheDocument();
    fireEvent.submit(screen.getByRole("button", { name: "Add broker" }).closest("form") as HTMLFormElement);
    expect(await screen.findByText("Company name, website, and opt-out email are required.")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Company"), " New Broker ");
    await user.type(screen.getByLabelText("Website"), " new.example ");
    await user.type(screen.getByLabelText("Opt-out email"), " privacy@new.example ");
    await user.type(screen.getByLabelText("Additional websites"), "new.example, optout.new.example");
    await user.type(screen.getByLabelText("Notes"), " New notes ");
    await user.click(screen.getByRole("button", { name: "Add broker" }));

    await waitFor(() =>
      expect(createdBodies).toEqual([
        {
          aliases: ["new.example", "optout.new.example"],
          domain: "new.example",
          name: "New Broker",
          notes: "New notes",
          privacy_email: "privacy@new.example",
        },
      ]),
    );

    await user.click(screen.getByRole("button", { name: "Edit Acme Data" }));
    await user.clear(screen.getByLabelText("Company"));
    await user.type(screen.getByLabelText("Company"), "Acme Search");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(updatedBodies).toHaveLength(1));
    expect(updatedBodies[0]).toMatchObject({ name: "Acme Search" });
  });

  it("validates CSV imports and posts the selected mapping", async () => {
    const user = userEvent.setup();
    const uploadedFiles: string[] = [];
    const mappingBodies: Array<Record<string, FormDataEntryValue | null>> = [];
    mockApi([
      { body: [broker], path: "/api/brokers" },
      {
        assert: (request) => {
          const formData = request.init?.body as FormData;
          const file = formData.get("file");
          uploadedFiles.push(file instanceof File ? file.name : "");
          mappingBodies.push({
            domain_col: formData.get("domain_col"),
            email_col: formData.get("email_col"),
            id_col: formData.get("id_col"),
            name_col: formData.get("name_col"),
            notes_col: formData.get("notes_col"),
          });
        },
        body: { errors: ["Row 3 missing email"], imported: 2, skipped: 1 },
        method: "POST",
        path: "/api/brokers/import",
      },
    ]);

    renderWithProviders(<BrokerRegistryPage />);
    expect(await screen.findByText("Acme Data")).toBeInTheDocument();

    fireEvent.submit(screen.getByRole("button", { name: "Import brokers" }).closest("form") as HTMLFormElement);
    expect(await screen.findByText("Choose a CSV file before importing.")).toBeInTheDocument();

    await user.upload(
      screen.getByLabelText("CSV file"),
      new File(["Company,Email\nAcme,privacy@acme.example"], "brokers.csv", { type: "text/csv" }),
    );
    await user.click(screen.getByText("Advanced mapping"));
    await user.type(screen.getByLabelText("Company column"), "Company");
    await user.type(screen.getByLabelText("Contact email column"), "Email");
    await user.type(screen.getByLabelText("Website column"), "Website");
    await user.type(screen.getByLabelText("Internal ID column"), "ID");
    await user.type(screen.getByLabelText("Notes column"), "Notes");
    await user.click(screen.getByRole("button", { name: "Import brokers" }));

    expect(await screen.findByText("Imported 2; skipped 1")).toBeInTheDocument();
    expect(uploadedFiles).toEqual(["brokers.csv"]);
    expect(mappingBodies).toEqual([
      {
        domain_col: "Website",
        email_col: "Email",
        id_col: "ID",
        name_col: "Company",
        notes_col: "Notes",
      },
    ]);
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
  it("marks an item handled after manual review", async () => {
    const user = userEvent.setup();
    const handledIds: string[] = [];
    let resolveHandled: (() => void) | undefined;
    vi.stubGlobal("confirm", vi.fn(() => true));
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
        respond: () =>
          new Promise<Response>((resolve) => {
            resolveHandled = () =>
              resolve(
                new Response(JSON.stringify({ broker_id: "acme", status: "handled" }), {
                  headers: { "Content-Type": "application/json" },
                  status: 200,
                }),
              );
          }),
      },
    ]);

    renderWithProviders(<NeedsAttentionPage />);

    expect(await screen.findByText("Broker wants a signed form before continuing.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Mark handled" }));

    expect(await screen.findByRole("button", { name: "Marking handled" })).toBeDisabled();
    resolveHandled?.();
    await waitFor(() => expect(handledIds).toEqual(["acme"]));
  });
});
