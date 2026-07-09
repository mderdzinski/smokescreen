import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { OptOutRecord } from "../lib/api";
import { mockApi, renderWithProviders } from "../test/test-utils";
import { BrokerInspectAction } from "./broker-inspect";
import { StatusPill } from "./ui/status-pill";

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
    state_history: [],
    status: "AWAITING_RESPONSE",
    thread_id: "thread-1",
    thread_ids: ["thread-1"],
    thread_history: [],
    updated_at: "2026-06-21T12:00:00Z",
    ...overrides,
  };
}

function InspectRowsFixture() {
  return (
    <div className="grid gap-3" data-testid="broker-rows">
      <article className="relative z-[95]">
        <button type="button">Underlying row action</button>
        <StatusPill status="INITIAL_SENT" />
        <BrokerInspectAction brokerName="Acme Data" record={optOut()} />
      </article>
      <article className="relative z-[95]">
        <StatusPill
          className="relative z-[95]"
          status="FOLLOW_UP_SENT"
        />
        <BrokerInspectAction
          brokerName="BeenVerified LLC"
          record={optOut({
            broker_id: "beenverified",
            broker_name: "BeenVerified LLC",
            status: "FOLLOW_UP_SENT",
          })}
        />
      </article>
      <article className="relative z-[95]">
        <StatusPill status="COMPLETED" />
      </article>
    </div>
  );
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

  it("renders state history transitions oldest to newest", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <BrokerInspectAction
        brokerName="Acme Data"
        record={optOut({
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
              to_status: "INFO_REQUESTED",
              transitioned_at: "2026-07-07T13:00:00Z",
              reason: "broker asked for verification info",
              message_id: "reply-1",
            },
            {
              from_status: "INFO_REQUESTED",
              to_status: "FOLLOW_UP_SENT",
              transitioned_at: "2026-07-07T13:05:00Z",
              reason: "sent requested verification info",
              message_id: "sent-2",
            },
          ],
          status: "FOLLOW_UP_SENT",
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Inspect Acme Data record" }));

    const timeline = within(screen.getByRole("dialog", { name: "Acme Data" })).getByTestId("state-timeline");
    const items = within(timeline).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(items[0]!).getByText("Queued")).toBeInTheDocument();
    expect(within(items[0]!).getByText("Request sent")).toBeInTheDocument();
    expect(within(items[1]!).getByText("Info requested")).toBeInTheDocument();
    expect(within(items[2]!).getByText("Follow-up sent")).toBeInTheDocument();
    expect(within(items[2]!).getByText("sent requested verification info")).toBeInTheDocument();
  });

  it("marks the latest state history transition as active", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <BrokerInspectAction
        brokerName="Acme Data"
        record={optOut({
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
              transitioned_at: "2026-07-07T14:00:00Z",
              reason: "broker requested unavailable info",
              message_id: "reply-2",
            },
          ],
          status: "NEEDS_MANUAL",
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Inspect Acme Data record" }));

    const latest = screen.getByTestId("state-timeline-latest");
    expect(latest).toHaveClass("border-bd-olive");
    expect(within(latest).getByText("broker requested unavailable info")).toHaveClass(
      "font-medium",
      "text-soft-olive",
    );
  });

  it("falls back to the current state when state history is empty", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <BrokerInspectAction
        brokerName="Acme Data"
        record={optOut({
          previous_status: "AWAITING_RESPONSE",
          state_history: [],
          status: "NEEDS_MANUAL",
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Inspect Acme Data record" }));

    const current = screen.getByTestId("state-timeline-current");
    expect(within(current).getByText("Review")).toBeInTheDocument();
    expect(within(current).getByText(/Current state as of/)).toBeInTheDocument();
    expect(within(current).getByText("Previous status: Awaiting broker")).toBeInTheDocument();
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

  it("test_inspect_modal_shows_previous_cycles_section", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <BrokerInspectAction
        brokerName="Acme Data"
        record={optOut({
          thread_id: "thread-current",
          thread_ids: ["thread-current", "thread-alt"],
          thread_history: [
            {
              cycle_number: 1,
              thread_ids: ["thread-old-a", "thread-old-b"],
              started_at: "2026-05-01T12:00:00Z",
              ended_at: "2026-05-15T12:00:00Z",
              final_status: "COMPLETED",
            },
          ],
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Inspect Acme Data record" }));

    const dialog = screen.getByRole("dialog", { name: "Acme Data" });
    expect(within(dialog).getByText("Current cycle")).toBeInTheDocument();
    expect(within(dialog).getAllByText("thread-current").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("thread-alt")).toBeInTheDocument();

    const previousCycles = within(dialog).getByText("Previous cycles");
    await user.click(previousCycles);

    expect(within(dialog).getByText("Cycle 1")).toBeInTheDocument();
    expect(within(dialog).getByText("Removed")).toBeInTheDocument();
    expect(within(dialog).getByText("thread-old-a")).toBeInTheDocument();
    expect(within(dialog).getByText("thread-old-b")).toBeInTheDocument();
  });

  it("test_inspect_modal_shows_rescan_button_when_thread_id_present", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BrokerInspectAction brokerName="Acme Data" record={optOut()} />);

    await user.click(screen.getByRole("button", { name: "Inspect Acme Data record" }));

    const dialog = screen.getByRole("dialog", { name: "Acme Data" });
    const rescanButton = within(dialog).getByRole("button", { name: "Rescan Acme Data record" });
    expect(rescanButton).toBeInTheDocument();
    expect(rescanButton).toHaveTextContent("Rescan");
    expect(rescanButton).toHaveAttribute(
      "title",
      "Ask the AI pipeline to re-read the latest broker message and re-classify. Useful if you think the current classification is wrong.",
    );
  });

  it("queues a manual poll from the inspect modal", async () => {
    const user = userEvent.setup();
    const pollCalls: string[] = [];
    mockApi([
      {
        assert: (request) => pollCalls.push(request.path),
        body: { message: "Poll run queued", status: "queued" },
        method: "POST",
        path: "/api/poll",
        status: 202,
      },
    ]);
    renderWithProviders(<BrokerInspectAction brokerName="Acme Data" record={optOut()} />);

    await user.click(screen.getByRole("button", { name: "Inspect Acme Data record" }));
    const dialog = screen.getByRole("dialog", { name: "Acme Data" });
    await user.click(within(dialog).getByRole("button", { name: "Poll now" }));

    await waitFor(() => expect(pollCalls).toEqual(["/api/poll"]));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Poll queued. State will update within about a minute.",
    );
  });

  it("test_inspect_modal_rescan_confirmation_flow", async () => {
    const user = userEvent.setup();
    const updatedRecord = optOut({
      last_message_id: null,
      state_history: [
        {
          from_status: "AWAITING_RESPONSE",
          to_status: "AWAITING_RESPONSE",
          transitioned_at: "2026-07-07T18:00:00Z",
          reason: "manual rescan requested",
          message_id: "msg-1",
        },
      ],
      updated_at: "2026-07-07T18:00:00Z",
    });
    let resolveRescan: ((response: Response) => void) | null = null;
    const { calls } = mockApi([
      {
        method: "POST",
        path: "/api/optouts/acme/rescan",
        respond: () =>
          new Promise<Response>((resolve) => {
            resolveRescan = resolve;
          }),
      },
    ]);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderWithProviders(<BrokerInspectAction brokerName="Acme Data" record={optOut()} />);

    await user.click(screen.getByRole("button", { name: "Inspect Acme Data record" }));
    const dialog = screen.getByRole("dialog", { name: "Acme Data" });
    await user.click(within(dialog).getByRole("button", { name: "Rescan Acme Data record" }));

    expect(confirmSpy).toHaveBeenCalledWith(
      "Rescan this record? The AI will re-classify the latest broker reply on the next poll.",
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        method: "POST",
        path: "/api/optouts/acme/rescan",
      }),
    );
    expect(within(dialog).getByRole("button", { name: "Rescan Acme Data record" })).toHaveTextContent(
      "Rescanning",
    );

    await waitFor(() => expect(resolveRescan).not.toBeNull());
    resolveRescan!(
      new Response(JSON.stringify(updatedRecord), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Rescan queued. The next scheduled poll will re-classify this record.",
    );
    await waitFor(() => {
      const updatedDialog = screen.getByRole("dialog", { name: "Acme Data" });
      expect(within(updatedDialog).getByText("manual rescan requested")).toBeInTheDocument();
      expect(within(updatedDialog).getByText("Not available")).toBeInTheDocument();
    });
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

  it("test_inspect_modal_backdrop_covers_viewport_above_underlying_rows", async () => {
    const user = userEvent.setup();
    renderWithProviders(<InspectRowsFixture />);

    const rows = screen.getByTestId("broker-rows");
    await user.click(screen.getByRole("button", { name: "Inspect Acme Data record" }));

    const overlay = screen.getByTestId("broker-inspect-overlay");
    const backdrop = screen.getByTestId("broker-inspect-backdrop");
    const dialog = screen.getByRole("dialog", { name: "Acme Data" });

    expect(document.body).toContainElement(overlay);
    expect(rows).not.toContainElement(overlay);
    expect(overlay).toHaveClass("pointer-events-auto", "fixed", "inset-0", "z-[1000]", "isolate");
    expect(backdrop).toHaveClass("absolute", "inset-0", "bg-black/65");
    expect(dialog).toHaveClass("relative", "z-10");
    expect(rows.closest("[inert]")).not.toBeNull();
  });

  it("test_inspect_modal_keeps_underlying_row_actions_out_of_tab_order", async () => {
    const user = userEvent.setup();
    renderWithProviders(<InspectRowsFixture />);

    const underlyingAction = screen.getByRole("button", { name: "Underlying row action" });
    await user.click(screen.getByRole("button", { name: "Inspect Acme Data record" }));

    const dialog = screen.getByRole("dialog", { name: "Acme Data" });
    const closeButton = within(dialog).getByRole("button", { name: "Close inspect record" });
    await waitFor(() => expect(closeButton).toHaveFocus());

    expect(underlyingAction.closest("[inert]")).not.toBeNull();

    for (let index = 0; index < 6; index += 1) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
      expect(underlyingAction).not.toHaveFocus();
    }

    await user.tab({ shift: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(underlyingAction).not.toHaveFocus();
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
