import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ExternalLink, Eye, RefreshCw, X } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import {
  api,
  type BrokerStatus,
  type OptOutRecord,
  type ThreadHistoryEntry,
} from "../lib/api";
import { cn } from "../lib/utils";
import { BROKER_STATUS_DISPLAY } from "./ui/status-pill";
import { Badge, type BadgeProps } from "./ui/badge";
import { Button, type ButtonProps } from "./ui/button";
import { PollNowButton } from "./poll-now-button";
import { StateTimeline } from "./state-timeline";

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
  const currentThreadIds = inspectCurrentThreadIds(record);
  const threadHistory = record.thread_history ?? [];
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
    if (currentThreadIds.length === 0 || rescanMutation.isPending) {
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
          {currentThreadIds.length > 0 ? (
            <div className="grid gap-3 rounded-sm border border-bd-olive bg-fill-olive px-[13px] py-[12px]">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="ss-label text-soft-olive">Current cycle</div>
                  <p className="mt-[5px] text-xs text-content-muted">
                    {currentThreadIds.length === 1 ? "1 Gmail thread" : `${currentThreadIds.length} Gmail threads`}
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <PollNowButton />
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
                </div>
              </div>
              <ul className="grid gap-2">
                {currentThreadIds.map((threadId) => (
                  <li
                    className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-bd-olive/60 bg-surface-card/70 px-3 py-2"
                    key={threadId}
                  >
                    <p className="min-w-0 break-all font-mono text-xs text-content-body">
                      {threadId}
                    </p>
                    <Button asChild size="sm" variant="secondary">
                      <a href={gmailThreadHref(threadId) ?? "#"} target="_blank" rel="noopener noreferrer">
                        <ExternalLink aria-hidden="true" />
                        Open in Gmail
                      </a>
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {threadHistory.length > 0 ? <PreviousCycles cycles={threadHistory} /> : null}

          {rescanMutation.error ? (
            <div
              className="rounded-sm border border-bd-rust bg-fill-rust px-3 py-2 text-sm text-soft-rust"
              role="alert"
            >
              {rescanMutation.error.message || "Could not queue a rescan for this record."}
            </div>
          ) : null}

          <InspectSection title="State timeline">
            <StateTimeline
              previousStatus={record.previous_status}
              stateHistory={record.state_history}
              status={record.status}
              updatedAt={record.updated_at}
            />
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

function PreviousCycles({ cycles }: { cycles: ThreadHistoryEntry[] }) {
  return (
    <details className="group rounded-sm border border-border bg-surface-sunken px-[13px] py-[12px]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
        <span className="ss-label text-content-muted">Previous cycles</span>
        <ChevronDown
          aria-hidden="true"
          className="h-4 w-4 text-content-muted transition-transform group-open:rotate-180"
        />
      </summary>
      <ol className="mt-3 grid gap-3">
        {cycles.map((cycle) => (
          <li
            className="grid gap-2 rounded-sm border border-border bg-surface-card px-3 py-3"
            key={threadHistoryEntryKey(cycle)}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="ss-label text-content-muted">Cycle {cycle.cycle_number}</div>
              <Badge variant={statusBadgeVariantOrOutline(cycle.final_status)}>
                {statusText(cycle.final_status)}
              </Badge>
            </div>
            <dl className="grid gap-2 sm:grid-cols-2">
              <div>
                <dt className="ss-label mb-[5px]">started</dt>
                <dd className="font-mono text-xs text-content-muted">
                  {formatDateTime(cycle.started_at)}
                </dd>
              </div>
              <div>
                <dt className="ss-label mb-[5px]">ended</dt>
                <dd className="font-mono text-xs text-content-muted">
                  {formatDateTime(cycle.ended_at)}
                </dd>
              </div>
            </dl>
            <ul className="grid gap-2">
              {cycle.thread_ids.map((threadId) => (
                <li className="flex flex-wrap items-center justify-between gap-2" key={threadId}>
                  <span className="min-w-0 break-all font-mono text-xs text-content-body">
                    {threadId}
                  </span>
                  <Button asChild size="sm" variant="outline">
                    <a href={gmailThreadHref(threadId) ?? "#"} target="_blank" rel="noopener noreferrer">
                      <ExternalLink aria-hidden="true" />
                      Open in Gmail
                    </a>
                  </Button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </details>
  );
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

function statusText(status: string): string {
  const brokerStatus = toBrokerStatus(status);
  return brokerStatus ? statusLabel(brokerStatus) : status;
}

function toBrokerStatus(status: string): BrokerStatus | null {
  if (status in BROKER_STATUS_DISPLAY) {
    return status as BrokerStatus;
  }
  return null;
}

function statusBadgeVariantOrOutline(status: string): BadgeVariant {
  const brokerStatus = toBrokerStatus(status);
  return brokerStatus ? statusBadgeVariant(brokerStatus) : "outline";
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

function inspectCurrentThreadIds(record: OptOutRecord): string[] {
  return dedupeStrings([...(record.thread_ids ?? []), record.thread_id ?? ""]);
}

function dedupeStrings(values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  values.forEach((value) => {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    result.push(trimmed);
  });
  return result;
}

function threadHistoryEntryKey(cycle: ThreadHistoryEntry): string {
  return `${cycle.cycle_number}-${cycle.started_at}-${cycle.ended_at}`;
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
