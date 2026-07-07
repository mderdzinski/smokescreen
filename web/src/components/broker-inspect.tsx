import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ExternalLink, Eye, RefreshCw, X } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { api, type BrokerStatus, type OptOutRecord, type StateTransition } from "../lib/api";
import { cn } from "../lib/utils";
import { BROKER_STATUS_DISPLAY } from "./ui/status-pill";
import { Badge, type BadgeProps } from "./ui/badge";
import { Button, type ButtonProps } from "./ui/button";

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

const RESCAN_TOOLTIP =
  "Ask the AI pipeline to re-read the latest broker message and re-classify. Useful if you think the current classification is wrong.";
const RESCAN_CONFIRM_MESSAGE =
  "Rescan this record? The AI will re-classify the latest broker reply on the next poll.";
const RESCAN_SUCCESS_MESSAGE =
  "Rescan queued. The next scheduled poll will re-classify this record.";

type BadgeVariant = NonNullable<BadgeProps["variant"]>;

interface BrokerInspectActionProps {
  brokerName: string;
  buttonClassName?: string;
  className?: string;
  record?: OptOutRecord | null;
  size?: ButtonProps["size"];
  variant?: ButtonProps["variant"];
}

interface InspectMetadataRow {
  label: string;
  mono?: boolean;
  value: string;
}

export function BrokerInspectAction({
  brokerName,
  buttonClassName,
  className,
  record,
  size = "sm",
  variant = "outline",
}: BrokerInspectActionProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  if (!record) {
    return null;
  }

  function closeDialog() {
    setOpen(false);
    window.setTimeout(() => {
      triggerRef.current?.focus({ preventScroll: true });
    }, 0);
  }

  return (
    <div className={cn("inline-flex", className)}>
      <Button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Inspect ${brokerName} record`}
        className={buttonClassName}
        iconOnly
        onClick={() => setOpen(true)}
        ref={triggerRef}
        size={size}
        type="button"
        variant={variant}
      >
        <Eye aria-hidden="true" />
      </Button>
      {open ? (
        <BrokerInspectDialog
          brokerName={brokerName}
          onClose={closeDialog}
          record={record}
        />
      ) : null}
    </div>
  );
}

function BrokerInspectDialog({
  brokerName,
  onClose,
  record: initialRecord,
}: {
  brokerName: string;
  onClose: () => void;
  record: OptOutRecord;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const queryClient = useQueryClient();
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [record, setRecord] = useState(initialRecord);
  const [rescanSuccessMessage, setRescanSuccessMessage] = useState<string | null>(null);
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: api.getSettings,
    enabled: record.status === "COMPLETED" && Boolean(record.last_completed_at),
  });
  const rescanMutation = useMutation({
    mutationFn: (brokerId: string) => api.rescanClassification(brokerId),
    onSuccess: async (updatedRecord) => {
      setRecord(updatedRecord);
      setRescanSuccessMessage(RESCAN_SUCCESS_MESSAGE);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["opt-outs"] }),
        queryClient.invalidateQueries({ queryKey: ["extended-stats"] }),
      ]);
    },
  });
  const gmailHref = gmailThreadHref(record.thread_id);
  const metadataRows = inspectMetadataRows(record);
  const manualSummary = record.needs_manual_reason?.short_summary.trim();
  const notes = record.notes.trim();
  const nextRerequestText = nextRerequestLine({
    intervalDays: settingsQuery.data?.rerequest_interval_days,
    lastCompletedAt: record.last_completed_at,
    status: record.status,
  });

  useEffect(() => {
    setRecord(initialRecord);
  }, [initialRecord]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const restoreHiddenSiblings = hideBodySiblingsFromModal(overlayRef.current);

    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    return () => {
      restoreHiddenSiblings();
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") {
      return;
    }

    const focusableElements = getFocusableElements(dialogRef.current);
    if (focusableElements.length === 0) {
      event.preventDefault();
      return;
    }

    const firstElement = focusableElements[0]!;
    const lastElement = focusableElements[focusableElements.length - 1]!;
    const activeElement = document.activeElement;

    if (event.shiftKey && activeElement === firstElement) {
      event.preventDefault();
      lastElement.focus();
      return;
    }

    if (!event.shiftKey && activeElement === lastElement) {
      event.preventDefault();
      firstElement.focus();
      return;
    }

    if (!dialogRef.current?.contains(activeElement)) {
      event.preventDefault();
      firstElement.focus();
    }
  }

  function handleRescan() {
    if (!record.thread_id || rescanMutation.isPending) {
      return;
    }
    if (!window.confirm(RESCAN_CONFIRM_MESSAGE)) {
      return;
    }

    setRescanSuccessMessage(null);
    rescanMutation.reset();
    rescanMutation.mutate(record.broker_id);
  }

  return createPortal(
    <div
      className="pointer-events-auto fixed inset-0 z-[1000] isolate flex items-end justify-center px-3 py-4 sm:items-center sm:px-5"
      data-testid="broker-inspect-overlay"
      ref={overlayRef}
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-black/65 [animation:ss-ov-in_170ms_var(--ease-standard)_both]"
        data-testid="broker-inspect-backdrop"
        onMouseDown={onClose}
      />
      <div
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-modal="true"
        className="relative z-10 max-h-[92vh] w-full max-w-[720px] overflow-hidden rounded-md border border-border bg-surface-card shadow-lg [animation:ss-panel-rise_220ms_var(--ease-out)_both]"
        onKeyDown={handleDialogKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge variant={statusBadgeVariant(record.status)}>
                {statusLabel(record.status)}
              </Badge>
              <span className="font-mono text-2xs font-semibold uppercase tracking-label text-content-faint">
                Updated {formatRelativeTime(record.updated_at)}
              </span>
            </div>
            <h2
              className="break-words font-display text-2xl font-semibold leading-tight text-content-strong"
              id={titleId}
            >
              {brokerName}
            </h2>
            <p className="mt-1 text-sm text-content-muted" id={descriptionId}>
              Opt-out record state, thread link, and metadata.
            </p>
          </div>
          <Button
            aria-label="Close inspect record"
            iconOnly
            onClick={onClose}
            ref={closeButtonRef}
            size="sm"
            type="button"
            variant="ghost"
          >
            <X aria-hidden="true" />
          </Button>
        </div>

        <div className="grid max-h-[calc(92vh-112px)] gap-4 overflow-y-auto px-5 py-5">
          {gmailHref ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-bd-olive bg-fill-olive px-[13px] py-[12px]">
              <div>
                <div className="ss-label text-soft-olive">Gmail thread</div>
                <p className="mt-[5px] break-all font-mono text-xs text-content-body">
                  {record.thread_id}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  aria-label={`Rescan ${brokerName} record`}
                  disabled={rescanMutation.isPending}
                  onClick={handleRescan}
                  size="sm"
                  title={RESCAN_TOOLTIP}
                  type="button"
                  variant="secondary"
                >
                  <RefreshCw
                    aria-hidden="true"
                    className={cn(rescanMutation.isPending && "animate-spin")}
                  />
                  {rescanMutation.isPending ? "Rescanning" : "Rescan"}
                </Button>
                <Button asChild size="sm" variant="secondary">
                  <a href={gmailHref} target="_blank" rel="noopener noreferrer">
                    <ExternalLink aria-hidden="true" />
                    Open in Gmail
                  </a>
                </Button>
              </div>
            </div>
          ) : null}

          {rescanMutation.error ? (
            <div
              className="rounded-sm border border-bd-rust bg-fill-rust px-3 py-2 text-sm text-soft-rust"
              role="alert"
            >
              {rescanMutation.error.message || "Could not queue a rescan for this record."}
            </div>
          ) : null}

          <InspectSection title="State timeline">
            <StateTimeline record={record} />
          </InspectSection>

          <InspectSection title="Metadata">
            <dl className="grid gap-3 sm:grid-cols-2">
              {metadataRows.map((row) => (
                <div key={row.label} className="min-w-0">
                  <dt className="ss-label mb-[5px]">{row.label}</dt>
                  <dd
                    className={cn(
                      "break-words text-sm text-content-body",
                      row.mono && "break-all font-mono text-xs text-content-muted",
                    )}
                  >
                    {row.value}
                  </dd>
                </div>
              ))}
              {nextRerequestText ? (
                <div className="min-w-0 sm:col-span-2">
                  <dt className="ss-label mb-[5px]">next re-request</dt>
                  <dd className="text-sm leading-relaxed text-content-body">{nextRerequestText}</dd>
                </div>
              ) : null}
            </dl>
          </InspectSection>

          <InspectSection title="Notes">
            <div className="grid gap-3">
              {manualSummary ? (
                <div>
                  <div className="ss-label mb-[5px]">manual review summary</div>
                  <p className="text-sm leading-relaxed text-content-body">{manualSummary}</p>
                </div>
              ) : null}
              {notes ? (
                <div>
                  <div className="ss-label mb-[5px]">record notes</div>
                  <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-content-body">
                    {notes}
                  </p>
                </div>
              ) : null}
              {!manualSummary && !notes ? (
                <p className="text-sm leading-relaxed text-content-muted">No notes saved for this record.</p>
              ) : null}
            </div>
          </InspectSection>
        </div>
      </div>
      {rescanSuccessMessage ? (
        <div
          aria-live="polite"
          className="absolute right-4 top-4 z-20 max-w-[min(360px,calc(100vw-32px))] rounded-sm border border-bd-green bg-fill-green px-3 py-2 text-sm font-medium text-soft-green shadow-lg"
          role="status"
        >
          {rescanSuccessMessage}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

function InspectSection({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="rounded-sm border border-border bg-surface-sunken px-[13px] py-[12px]">
      <h3 className="ss-label mb-[10px] text-content-muted">{title}</h3>
      {children}
    </section>
  );
}

export function StateTimeline({ className, record }: { className?: string; record: OptOutRecord }) {
  const transitions = record.state_history ?? [];

  if (transitions.length === 0) {
    return (
      <ol className={cn("grid gap-3", className)} data-testid="state-timeline">
        <li
          className="relative grid gap-1 border-l-2 border-bd-olive pl-4"
          data-testid="state-timeline-current"
        >
          <span
            aria-hidden="true"
            className="absolute -left-[5px] top-[5px] h-2 w-2 rounded-pill bg-brand"
          />
          <div className="flex flex-wrap items-center gap-2">
            <TransitionStatusBadge status={record.status} />
            <span className="font-mono text-xs font-semibold text-soft-olive">
              {formatRelativeTime(record.updated_at)}
            </span>
          </div>
          <p className="text-xs leading-relaxed text-content-muted">
            Current state as of {formatDateTime(record.updated_at)}
          </p>
          {record.previous_status ? (
            <p className="text-xs leading-relaxed text-content-muted">
              Previous status: {statusLabel(record.previous_status)}
            </p>
          ) : null}
        </li>
      </ol>
    );
  }

  return (
    <ol className={cn("grid gap-3", className)} data-testid="state-timeline">
      {transitions.map((transition, index) => {
        const isLatest = index === transitions.length - 1;
        return (
          <StateTimelineItem
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
  isLatest,
  transition,
}: {
  isLatest: boolean;
  transition: StateTransition;
}) {
  const reason = transition.reason?.trim();

  return (
    <li
      className={cn(
        "relative grid gap-2 border-l-2 pl-4",
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
        <TransitionStatusBadge status={transition.from_status} />
        <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 text-content-faint" />
        <TransitionStatusBadge status={transition.to_status} />
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
    </li>
  );
}

function TransitionStatusBadge({ status }: { status: string }) {
  const brokerStatus = toBrokerStatus(status);
  return (
    <Badge variant={brokerStatus ? statusBadgeVariant(brokerStatus) : "outline"}>
      {brokerStatus ? statusLabel(brokerStatus) : status}
    </Badge>
  );
}

function stateTransitionKey(transition: StateTransition, index: number): string {
  return `${transition.from_status}-${transition.to_status}-${transition.transitioned_at}-${index}`;
}

function getFocusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) {
    return [];
  }

  return Array.from(root.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) => !element.hasAttribute("disabled") && element.tabIndex !== -1,
  );
}

function hideBodySiblingsFromModal(modalRoot: HTMLElement | null): () => void {
  if (!modalRoot) {
    return () => undefined;
  }

  const hiddenSiblings = Array.from(document.body.children)
    .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== modalRoot)
    .map((element) => {
      const inertElement = element as HTMLElement & { inert?: boolean };
      const hadInertProperty = "inert" in inertElement;
      const previousState = {
        ariaHidden: element.getAttribute("aria-hidden"),
        element,
        hadInertProperty,
        inert: inertElement.inert,
        inertAttribute: element.getAttribute("inert"),
      };

      element.setAttribute("aria-hidden", "true");
      element.setAttribute("inert", "");
      inertElement.inert = true;

      return previousState;
    });

  return () => {
    hiddenSiblings.forEach(({ ariaHidden, element, hadInertProperty, inert, inertAttribute }) => {
      const inertElement = element as HTMLElement & { inert?: boolean };

      if (ariaHidden === null) {
        element.removeAttribute("aria-hidden");
      } else {
        element.setAttribute("aria-hidden", ariaHidden);
      }

      if (inertAttribute === null) {
        element.removeAttribute("inert");
      } else {
        element.setAttribute("inert", inertAttribute);
      }

      if (hadInertProperty) {
        inertElement.inert = inert;
      } else {
        Reflect.deleteProperty(inertElement, "inert");
      }
    });
  };
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

function gmailThreadHref(threadId: string | null): string | null {
  const trimmedThreadId = threadId?.trim();
  if (!trimmedThreadId) {
    return null;
  }
  return `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(trimmedThreadId)}`;
}

function inspectMetadataRows(record: OptOutRecord): InspectMetadataRow[] {
  const rows: InspectMetadataRow[] = [
    { label: "broker_id", value: record.broker_id, mono: true },
    { label: "thread_id", value: record.thread_id?.trim() || "Not linked", mono: true },
    {
      label: "last_message_id",
      value: record.last_message_id?.trim() || "Not available",
      mono: true,
    },
    { label: "retries", value: String(record.retries) },
  ];

  if (record.last_completed_at) {
    rows.push({
      label: "last_completed_at",
      value: formatDateTime(record.last_completed_at),
      mono: true,
    });
  }

  return rows;
}

function nextRerequestLine({
  intervalDays,
  lastCompletedAt,
  status,
}: {
  intervalDays?: number;
  lastCompletedAt: string | null;
  status: BrokerStatus;
}): string | null {
  if (status !== "COMPLETED" || !lastCompletedAt || !intervalDays) {
    return null;
  }

  const completedAt = Date.parse(lastCompletedAt);
  if (Number.isNaN(completedAt)) {
    return null;
  }

  const nextRequestAt = new Date(completedAt + intervalDays * 24 * 60 * 60 * 1000);
  return `Next re-request approximately ${intervalDays} days from last completion (${formatDateTime(
    nextRequestAt.toISOString(),
  )}).`;
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
