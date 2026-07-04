import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { OptOutRecord } from "../lib/api";
import { mockApi, renderWithProviders } from "../test/test-utils";
import { BrokerInspectAction } from "./broker-inspect";

function optOut(overrides: Partial<OptOutRecord> = {}): OptOutRecord {
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
    notes: "Internal review note.",
    previous_status: null,
    requested_fields: [],
    requested_other_details: "",
    retries: 2,
    status: "AWAITING_RESPONSE",
    thread_id: "thread-1",
    updated_at: "2026-06-21T12:00:00Z",
    ...overrides,
  };
}

describe("BrokerInspectAction", () => {
  it("test_inspect_button_renders_on_broker_with_record", () => {
    renderWithProviders(<BrokerInspectAction brokerName="Acme Data" record={optOut()} />);

    expect(screen.getByRole("button", { name: "Inspect Acme Data record" })).toBeInTheDocument();
  });

  it("test_inspect_button_does_not_render_when_no_record", () => {
    renderWithProviders(<BrokerInspectAction brokerName="Second Broker" record={null} />);

    expect(screen.queryByRole("button", { name: "Inspect Second Broker record" })).not.toBeInTheDocument();
  });

  it("test_inspect_modal_opens_and_shows_state", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <BrokerInspectAction
        brokerName="Acme Data"
        record={optOut({
          needs_manual_reason: {
            broker_reply_excerpt: "This raw reply should not render in inspect.",
            classifier_output: { classification: "NEEDS_MANUAL" },
            missing_fields: [],
            reason_code: "info_request_missing_fields",
            short_summary: "Broker asked for proof of identity.",
            transitioned_at: "2026-06-21T13:00:00Z",
          },
          previous_status: "AWAITING_RESPONSE",
          status: "NEEDS_MANUAL",
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Inspect Acme Data record" }));

    const dialog = screen.getByRole("dialog", { name: "Acme Data" });
    expect(within(dialog).getAllByText("Review").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("Previous status: Awaiting broker")).toBeInTheDocument();
    expect(within(dialog).getByText("broker_id")).toBeInTheDocument();
    expect(within(dialog).getByText("acme")).toBeInTheDocument();
    expect(within(dialog).getByText("last_message_id")).toBeInTheDocument();
    expect(within(dialog).getByText("msg-1")).toBeInTheDocument();
    expect(within(dialog).getByText("Broker asked for proof of identity.")).toBeInTheDocument();
    expect(within(dialog).getByText("Internal review note.")).toBeInTheDocument();
    expect(within(dialog).queryByText("This raw reply should not render in inspect.")).not.toBeInTheDocument();
  });

  it("test_inspect_modal_gmail_link_present_when_thread_id", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BrokerInspectAction brokerName="Acme Data" record={optOut()} />);

    await user.click(screen.getByRole("button", { name: "Inspect Acme Data record" }));

    const link = screen.getByRole("link", { name: "Open in Gmail" });
    expect(link).toHaveAttribute("href", "https://mail.google.com/mail/u/0/#inbox/thread-1");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("test_inspect_modal_closes_on_escape", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BrokerInspectAction brokerName="Acme Data" record={optOut()} />);

    const trigger = screen.getByRole("button", { name: "Inspect Acme Data record" });
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "Acme Data" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Acme Data" })).not.toBeInTheDocument();
    });
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("test_inspect_modal_focus_trap", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BrokerInspectAction brokerName="Acme Data" record={optOut()} />);

    await user.click(screen.getByRole("button", { name: "Inspect Acme Data record" }));

    const closeButton = screen.getByRole("button", { name: "Close inspect record" });
    const gmailLink = screen.getByRole("link", { name: "Open in Gmail" });
    await waitFor(() => expect(closeButton).toHaveFocus());

    await user.tab({ shift: true });
    expect(gmailLink).toHaveFocus();

    await user.tab();
    expect(closeButton).toHaveFocus();
  });

  it("shows completed rerequest timing when cadence settings are available", async () => {
    const user = userEvent.setup();
    mockApi([{ body: { rerequest_interval_days: 45 }, path: "/api/settings" }]);
    renderWithProviders(
      <BrokerInspectAction
        brokerName="Acme Data"
        record={optOut({
          last_completed_at: "2026-06-01T12:00:00Z",
          status: "COMPLETED",
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Inspect Acme Data record" }));

    expect(await screen.findByText(/Next re-request approximately 45 days from last completion/)).toBeInTheDocument();
  });
});
