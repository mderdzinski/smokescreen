import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StateTimeline } from "./state-timeline";

describe("StateTimeline", () => {
  it("test_state_timeline_component_renders_with_empty_history", () => {
    render(
      <StateTimeline
        previousStatus="INITIAL_SENT"
        stateHistory={[]}
        status="AWAITING_RESPONSE"
        updatedAt="2026-06-21T12:00:00Z"
      />,
    );

    const current = screen.getByTestId("state-timeline-current");
    expect(within(current).getByText("Awaiting broker")).toBeInTheDocument();
    expect(within(current).getByText(/Current state as of/)).toBeInTheDocument();
    expect(within(current).getByText("Previous status: Request sent")).toBeInTheDocument();
  });

  it("test_state_timeline_component_renders_multiple_transitions", () => {
    render(
      <StateTimeline
        stateHistory={[
          {
            from_status: "PENDING",
            message_id: "sent-1",
            reason: "initial opt-out request sent",
            to_status: "INITIAL_SENT",
            transitioned_at: "2026-07-07T12:00:00Z",
          },
          {
            from_status: "INITIAL_SENT",
            message_id: "reply-1",
            reason: "broker asked for unavailable information",
            to_status: "NEEDS_MANUAL",
            transitioned_at: "2026-07-07T15:00:00Z",
          },
        ]}
        status="NEEDS_MANUAL"
        updatedAt="2026-07-07T15:00:00Z"
      />,
    );

    const timeline = screen.getByTestId("state-timeline");
    const items = within(timeline).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText("Queued")).toBeInTheDocument();
    expect(within(items[0]!).getByText("Request sent")).toBeInTheDocument();
    expect(within(items[0]!).getByText("sent-1")).toBeInTheDocument();
    expect(within(items[1]!).getByText("Review")).toBeInTheDocument();
    expect(within(items[1]!).getByText("broker asked for unavailable information")).toBeInTheDocument();
    expect(within(items[1]!).getByText("reply-1")).toBeInTheDocument();
  });

  it("test_state_timeline_component_compact_variant", () => {
    render(
      <StateTimeline
        compact
        stateHistory={[
          {
            from_status: "PENDING",
            message_id: null,
            reason: "initial opt-out request sent",
            to_status: "INITIAL_SENT",
            transitioned_at: "2026-07-07T12:00:00Z",
          },
        ]}
        status="INITIAL_SENT"
        updatedAt="2026-07-07T12:00:00Z"
      />,
    );

    const latest = screen.getByTestId("state-timeline-latest");
    expect(latest).toHaveClass("gap-1", "pl-3");
    expect(within(latest).getByText("Queued")).toHaveClass("text-[10px]");
  });
});
