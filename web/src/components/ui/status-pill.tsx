import * as React from "react";

import { cn } from "../../lib/utils";

export type BrokerStatus =
  | "PENDING"
  | "INITIAL_SENT"
  | "INITIAL_SENT_PINGED"
  | "AWAITING_RESPONSE"
  | "AWAITING_RESPONSE_PINGED"
  | "INFO_REQUESTED"
  | "INFO_REQUESTED_PINGED"
  | "FOLLOW_UP_SENT"
  | "FOLLOW_UP_SENT_PINGED"
  | "COMPLETED"
  | "REJECTED"
  | "NEEDS_MANUAL"
  | "FAILED";

type StatusTone = "working" | "done" | "attention" | "idle";

export const BROKER_STATUS_DISPLAY: Record<BrokerStatus, { tone: StatusTone; label: string }> = {
  PENDING: { tone: "working", label: "Queued" },
  INITIAL_SENT: { tone: "working", label: "Request sent" },
  INITIAL_SENT_PINGED: { tone: "working", label: "Pinged" },
  AWAITING_RESPONSE: { tone: "working", label: "Awaiting broker" },
  AWAITING_RESPONSE_PINGED: { tone: "working", label: "Pinged" },
  INFO_REQUESTED: { tone: "working", label: "Info requested" },
  INFO_REQUESTED_PINGED: { tone: "working", label: "Pinged" },
  FOLLOW_UP_SENT: { tone: "working", label: "Follow-up sent" },
  FOLLOW_UP_SENT_PINGED: { tone: "working", label: "Pinged" },
  COMPLETED: { tone: "done", label: "Removed" },
  REJECTED: { tone: "attention", label: "Blocked" },
  NEEDS_MANUAL: { tone: "attention", label: "Review" },
  FAILED: { tone: "attention", label: "Failed" },
};

const toneClasses: Record<StatusTone, { root: string; led: string }> = {
  working: {
    root: "border-bd-amber bg-fill-amber text-soft-amber",
    led: "bg-status-working shadow-[0_0_0_2px_var(--status-working-soft)]",
  },
  done: {
    root: "border-bd-green bg-fill-green text-soft-green",
    led: "bg-status-done shadow-[0_0_0_2px_var(--status-done-soft)]",
  },
  attention: {
    root: "border-bd-rust bg-fill-rust text-soft-rust",
    led: "bg-status-attention shadow-[0_0_0_2px_var(--status-attention-soft)]",
  },
  idle: {
    root: "border-border bg-fill-neutral text-soft-neutral",
    led: "bg-status-idle shadow-[0_0_0_2px_var(--status-idle-soft)]",
  },
};

export interface StatusPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  status?: BrokerStatus;
  tone?: StatusTone;
  label?: string;
  pulse?: boolean;
}

export function StatusPill({ className, label, pulse, status, tone, ...props }: StatusPillProps) {
  const mapped = status ? BROKER_STATUS_DISPLAY[status] : undefined;
  const resolvedTone = tone ?? mapped?.tone ?? "idle";
  const shouldPulse = pulse ?? resolvedTone === "working";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-[.5em] whitespace-nowrap rounded-sm border px-[.7em] py-[.4em] pl-[.55em] font-mono text-2xs font-semibold uppercase leading-none tracking-label",
        toneClasses[resolvedTone].root,
        className,
      )}
      {...props}
    >
      <span
        className={cn(
          "h-[7px] w-[7px] flex-none rounded-pill",
          toneClasses[resolvedTone].led,
          shouldPulse && "animate-[ss-led_1.6s_var(--ease-standard)_infinite] motion-reduce:animate-none",
        )}
      />
      {label ?? mapped?.label ?? status ?? "Idle"}
    </span>
  );
}
