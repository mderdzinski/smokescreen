import { ArrowRight } from "lucide-react";

import { type BrokerStatus, type StateTransition } from "../lib/api";
import { cn } from "../lib/utils";
import { BROKER_STATUS_DISPLAY } from "./ui/status-pill";
import { Badge, type BadgeProps } from "./ui/badge";

type BadgeVariant = NonNullable<BadgeProps["variant"]>;

interface StateTimelineProps {
  className?: string;
  compact?: boolean;
  previousStatus?: BrokerStatus | null;
  stateHistory?: StateTransition[];
  status: BrokerStatus;
  updatedAt: string;
}

export function StateTimeline({
  className,
  compact = false,
  previousStatus,
  stateHistory = [],
  status,
  updatedAt,
}: StateTimelineProps) {
  const transitions = stateHistory;

  if (transitions.length === 0) {
    return (
      <ol className={cn("grid", compact ? "gap-2" : "gap-3", className)} data-testid="state-timeline">
        <li
          className={cn(
            "relative grid gap-1 border-l-2 border-bd-olive",
            compact ? "pl-3" : "pl-4",
          )}
          data-testid="state-timeline-current"
        >
          <span
            aria-hidden="true"
            className="absolute -left-[5px] top-[5px] h-2 w-2 rounded-pill bg-brand"
          />
          <div className="flex flex-wrap items-center gap-2">
            <TransitionStatusBadge compact={compact} status={status} />
            <span className="font-mono text-xs font-semibold text-soft-olive">
              {formatRelativeTime(updatedAt)}
            </span>
          </div>
          <p className="text-xs leading-relaxed text-content-muted">
            Current state as of {formatDateTime(updatedAt)}
          </p>
          {previousStatus ? (
            <p className="text-xs leading-relaxed text-content-muted">
              Previous status: {statusLabel(previousStatus)}
            </p>
          ) : null}
        </li>
      </ol>
    );
  }

  return (
    <ol className={cn("grid", compact ? "gap-2" : "gap-3", className)} data-testid="state-timeline">
      {transitions.map((transition, index) => {
        const isLatest = index === transitions.length - 1;
        return (
          <StateTimelineItem
            compact={compact}
            isLatest={isLatest}
            key={stateTransitionKey(transition, index)}
            transition={transition}
          />
        );
      })}
    </ol>
  );
}

function StateTimelineItem({
  compact,
  isLatest,
  transition,
}: {
  compact: boolean;
  isLatest: boolean;
  transition: StateTransition;
}) {
  const reason = transition.reason?.trim();
  const messageId = transition.message_id?.trim();

  return (
    <li
      className={cn(
        "relative grid border-l-2",
        compact ? "gap-1 pl-3" : "gap-2 pl-4",
        isLatest ? "border-bd-olive" : "border-border",
      )}
      data-testid={isLatest ? "state-timeline-latest" : undefined}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute -left-[5px] top-[5px] rounded-pill",
          isLatest ? "h-2.5 w-2.5 bg-brand" : "h-2 w-2 bg-border",
        )}
      />
      <div className="flex flex-wrap items-center gap-2">
        <TransitionStatusBadge compact={compact} status={transition.from_status} />
        <ArrowRight
          aria-hidden="true"
          className={cn(compact ? "h-3 w-3" : "h-3.5 w-3.5", "text-content-faint")}
        />
        <TransitionStatusBadge compact={compact} status={transition.to_status} />
        <span
          className={cn(
            "font-mono text-xs",
            isLatest ? "font-semibold text-soft-olive" : "text-content-muted",
          )}
        >
          {formatRelativeTime(transition.transitioned_at)}
        </span>
      </div>
      {reason ? (
        <p
          className={cn(
            "text-xs leading-relaxed",
            isLatest ? "font-medium text-soft-olive" : "text-content-muted",
          )}
        >
          {reason}
        </p>
      ) : null}
      {messageId ? (
        <p className="flex min-w-0 flex-wrap items-center gap-2 text-xs leading-relaxed text-content-muted">
          <span className="ss-label">message id</span>
          <span className="break-all font-mono">{messageId}</span>
        </p>
      ) : null}
    </li>
  );
}

function TransitionStatusBadge({ compact, status }: { compact: boolean; status: string }) {
  const brokerStatus = toBrokerStatus(status);
  return (
    <Badge
      className={compact ? "px-[.5em] py-[.28em] text-[10px]" : undefined}
      variant={brokerStatus ? statusBadgeVariant(brokerStatus) : "outline"}
    >
      {brokerStatus ? statusLabel(brokerStatus) : status}
    </Badge>
  );
}

function stateTransitionKey(transition: StateTransition, index: number): string {
  return `${transition.from_status}-${transition.to_status}-${transition.transitioned_at}-${index}`;
}

function statusLabel(status: BrokerStatus): string {
  return BROKER_STATUS_DISPLAY[status]?.label ?? status;
}

function toBrokerStatus(status: string): BrokerStatus | null {
  if (status in BROKER_STATUS_DISPLAY) {
    return status as BrokerStatus;
  }
  return null;
}

function statusBadgeVariant(status: BrokerStatus): BadgeVariant {
  if (status === "COMPLETED") {
    return "success";
  }
  if (status === "REJECTED") {
    return "neutral";
  }
  if (status === "NEEDS_MANUAL") {
    return "amber";
  }
  if (status === "FAILED") {
    return "danger";
  }
  return "olive";
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatRelativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return "recently";
  }

  const elapsedSeconds = Math.round((Date.now() - timestamp) / 1000);
  const absoluteSeconds = Math.abs(elapsedSeconds);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

  if (absoluteSeconds < 60) {
    return elapsedSeconds >= 0 ? "just now" : formatter.format(-elapsedSeconds, "second");
  }

  const elapsedMinutes = Math.round(elapsedSeconds / 60);
  if (Math.abs(elapsedMinutes) < 60) {
    return formatter.format(-elapsedMinutes, "minute");
  }

  const elapsedHours = Math.round(elapsedMinutes / 60);
  if (Math.abs(elapsedHours) < 24) {
    return formatter.format(-elapsedHours, "hour");
  }

  const elapsedDays = Math.round(elapsedHours / 24);
  if (Math.abs(elapsedDays) < 45) {
    return formatter.format(-elapsedDays, "day");
  }

  const elapsedMonths = Math.round(elapsedDays / 30);
  if (Math.abs(elapsedMonths) < 18) {
    return formatter.format(-elapsedMonths, "month");
  }

  return formatter.format(-Math.round(elapsedDays / 365), "year");
}
