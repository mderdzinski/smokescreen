import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  ExternalLink,
  LogOut,
  Mail,
  RefreshCcw,
  RotateCcw,
  ShieldCheck,
  ShieldPlus,
  Trash2,
  UserCheck,
  UserPlus,
  XCircle,
} from "lucide-react";
import { Link, NavLink, Outlet } from "react-router-dom";

import {
  api,
  type Broker,
  type BrokerStatus,
  type OptOutRecord,
  type PendingWhitelistEntry,
  type WhitelistEntry,
} from "./lib/api";
import {
  useAppVersion,
  useBrokerSelections,
  useBrokers,
  useExtendedStats,
  useOptOuts,
  usePendingWhitelist,
  useWhitelist,
} from "./lib/queries";
import {
  getAttentionActionLabels,
  getAttentionGuidance,
  getAttentionViewState,
  getBrokerReplyText,
  getNeedsManualSummary,
  getSourceEmailHref,
  getVerificationProfileGap,
} from "./lib/needs-attention";
import { cn } from "./lib/utils";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Logo } from "./components/ui/logo";
import { Metric } from "./components/ui/metric";
import { Poof, ScanSweep, SplashScreen, useCountUp } from "./components/ui/motion";
import { StatusPill } from "./components/ui/status-pill";
import { EmptyState, ErrorState, LoadingState } from "./components/status-state";
import { SettingsPage as SettingsConsolePage } from "./pages/SettingsPage";

type BrokerStatusGroup = "working" | "done" | "attention";

interface BrokerStatusCopy {
  group: BrokerStatusGroup;
  label: string;
  description: string;
}

const brokerStatusGroup: Record<BrokerStatus, BrokerStatusGroup> = {
  PENDING: "working",
  INITIAL_SENT: "working",
  INITIAL_SENT_PINGED: "working",
  AWAITING_RESPONSE: "working",
  AWAITING_RESPONSE_PINGED: "working",
  INFO_REQUESTED: "working",
  INFO_REQUESTED_PINGED: "working",
  FOLLOW_UP_SENT: "working",
  FOLLOW_UP_SENT_PINGED: "working",
  COMPLETED: "done",
  REJECTED: "done",
  REJECTED_REBUTTED: "working",
  NEEDS_MANUAL: "attention",
  FAILED: "attention",
};

const brokerStatusCopy: Record<BrokerStatus, BrokerStatusCopy> = {
  PENDING: {
    group: brokerStatusGroup.PENDING,
    label: "Queued",
    description: "Smokescreen is preparing the removal request.",
  },
  INITIAL_SENT: {
    group: brokerStatusGroup.INITIAL_SENT,
    label: "Request sent",
    description: "The broker has the opt-out request.",
  },
  INITIAL_SENT_PINGED: {
    group: brokerStatusGroup.INITIAL_SENT_PINGED,
    label: "Pinged after initial send",
    description: "Smokescreen sent a status-check ping after a silent period.",
  },
  AWAITING_RESPONSE: {
    group: brokerStatusGroup.AWAITING_RESPONSE,
    label: "Waiting on broker",
    description: "Smokescreen is watching for the broker's reply.",
  },
  AWAITING_RESPONSE_PINGED: {
    group: brokerStatusGroup.AWAITING_RESPONSE_PINGED,
    label: "Pinged waiting broker",
    description: "Smokescreen sent a status-check ping after a silent period.",
  },
  INFO_REQUESTED: {
    group: brokerStatusGroup.INFO_REQUESTED,
    label: "Info requested",
    description: "The broker asked for additional information before continuing.",
  },
  INFO_REQUESTED_PINGED: {
    group: brokerStatusGroup.INFO_REQUESTED_PINGED,
    label: "Pinged after info request",
    description: "Smokescreen pinged after a silent info-request period.",
  },
  FOLLOW_UP_SENT: {
    group: brokerStatusGroup.FOLLOW_UP_SENT,
    label: "Follow-up sent",
    description: "Smokescreen sent the requested follow-up information.",
  },
  FOLLOW_UP_SENT_PINGED: {
    group: brokerStatusGroup.FOLLOW_UP_SENT_PINGED,
    label: "Pinged after follow-up",
    description: "Smokescreen pinged after the follow-up went unanswered.",
  },
  COMPLETED: {
    group: brokerStatusGroup.COMPLETED,
    label: "Removed",
    description: "The broker marked the opt-out request complete.",
  },
  REJECTED: {
    group: brokerStatusGroup.REJECTED,
    label: "Rejected",
    description: "The broker declined the request and the rejection was accepted.",
  },
  REJECTED_REBUTTED: {
    group: brokerStatusGroup.REJECTED_REBUTTED,
    label: "Rebuttal sent",
    description: "Smokescreen challenged the rejection and is waiting for a reply.",
  },
  NEEDS_MANUAL: {
    group: brokerStatusGroup.NEEDS_MANUAL,
    label: "Pending review",
    description: "Smokescreen needs you to review the broker's reply.",
  },
  FAILED: {
    group: brokerStatusGroup.FAILED,
    label: "Could not finish",
    description: "Smokescreen could not complete this request automatically.",
  },
};

const statusGroupLabels: Record<BrokerStatusGroup, { title: string; description: string }> = {
  working: {
    title: "Working",
    description: "Requests Smokescreen is sending or tracking.",
  },
  done: {
    title: "Done",
    description: "Completed removals and accepted terminal outcomes.",
  },
  attention: {
    title: "Needs attention",
    description: "Replies that need a human review.",
  },
};

const statusEmptyDescriptions: Record<BrokerStatusGroup, string> = {
  working: "No requests in flight.",
  done: "Empty for now.",
  attention: "Empty for now.",
};
const noEnabledBrokersStatusCopy = "No enabled brokers. Enable brokers in Settings to see their status here.";

function formatUpdatedAt(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatUpdatedAgo(value: string): string {
  const timestamp = new Date(value).getTime();

  if (!Number.isFinite(timestamp)) {
    return "recently";
  }

  const hours = Math.round((Date.now() - timestamp) / 3_600_000);

  if (hours < 1) {
    return "just now";
  }
  if (hours < 24) {
    return `${hours}h ago`;
  }

  return `${Math.round(hours / 24)}d ago`;
}

const appTabs = [
  { id: "status", label: "Status", to: "/" },
  { id: "brokers", label: "Brokers", to: "/brokers" },
  { id: "attention", label: "Needs Attention", to: "/needs-attention", showAttentionCount: true },
  { id: "settings", label: "Settings", to: "/settings" },
] as const;

function AppNavLink({
  attentionCount = 0,
  children,
  showAttentionCount = false,
  to,
}: {
  attentionCount?: number;
  children: ReactNode;
  showAttentionCount?: boolean;
  to: string;
}) {
  const hasAttention = showAttentionCount && attentionCount > 0;

  return (
    <NavLink
      to={to}
      end={to === "/"}
      className={({ isActive }) =>
        cn(
          "relative inline-flex h-9 shrink-0 items-center gap-[6px] rounded-sm px-[13px] font-mono text-2xs font-semibold uppercase tracking-label text-steel-300 transition-colors duration-fast hover:text-smoke-50",
          isActive && "bg-ink-700 text-smoke-50",
        )
      }
    >
      {({ isActive }) => (
        <>
          <span>{children}</span>
          {hasAttention ? (
            <span
              aria-label={`${attentionCount} item${attentionCount === 1 ? "" : "s"} need attention`}
              aria-live="polite"
              className="ss-badge-live inline-grid h-4 min-w-4 place-items-center rounded-pill bg-rust-500 px-1 text-[10px] font-semibold leading-none text-paper"
              title={`${attentionCount} item${attentionCount === 1 ? "" : "s"} need attention`}
            >
              {attentionCount}
            </span>
          ) : null}
          {isActive ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-[-1px] h-[2px] bg-accent"
              data-ss-active-tab-rule="true"
            />
          ) : null}
        </>
      )}
    </NavLink>
  );
}

function UserMenu() {
  return (
    <div className="flex shrink-0 items-center gap-3">
      <Button asChild size="sm" variant="outline">
        <Link to="/signed-out" aria-label="Sign out of the Smokescreen dashboard">
          <LogOut aria-hidden="true" />
          <span>Sign out</span>
        </Link>
      </Button>
    </div>
  );
}

export function App() {
  const attentionQuery = useOptOuts("needs_attention");
  const attentionCount = attentionQuery.data?.length ?? 0;
  const showBootSplash = attentionQuery.isLoading && !attentionQuery.data;

  return (
    <div className="min-h-screen bg-background text-foreground">
      {showBootSplash ? <SplashScreen /> : null}
      <header
        className="border-b border-ink-600 bg-surface-inverse"
        style={{
          backgroundImage:
            "radial-gradient(120% 140% at 88% -40%, rgb(var(--olive-500-rgb) / 0.28), transparent 55%)",
        }}
      >
        <div className="mx-auto flex min-h-header max-w-container flex-col justify-center gap-4 px-gutter py-4 sm:h-header sm:flex-row sm:items-center sm:justify-between sm:py-0">
          <Logo inverse size="md" tagline="data broker opt-out" />
          <div className="flex max-w-full flex-col items-start gap-3 sm:flex-row sm:items-center sm:gap-6">
            <nav aria-label="Primary" className="flex max-w-full items-center gap-[2px] overflow-x-auto whitespace-nowrap">
              {appTabs.map((tab) => (
                <AppNavLink
                  key={tab.id}
                  attentionCount={attentionCount}
                  showAttentionCount={"showAttentionCount" in tab && tab.showAttentionCount}
                  to={tab.to}
                >
                  {tab.label}
                </AppNavLink>
              ))}
            </nav>
            <AppVersionBadge />
            <UserMenu />
          </div>
        </div>
      </header>
      <Outlet />
    </div>
  );
}

function AppVersionBadge() {
  const { data, isError } = useAppVersion();
  if (isError || !data?.version) {
    return null;
  }
  const label = `v${data.version}`;
  const releaseHref = `https://github.com/mderdzinski/smokescreen/releases/tag/${label}`;
  return (
    <a
      aria-label={`Smokescreen version ${label}`}
      className="shrink-0 font-mono text-2xs uppercase tracking-label text-steel-300 transition-colors duration-fast hover:text-smoke-50"
      href={releaseHref}
      rel="noreferrer"
      target="_blank"
      title={`Release notes for ${label}`}
    >
      {label}
    </a>
  );
}

export function OverviewPage() {
  const statsQuery = useExtendedStats();
  const optOutsQuery = useOptOuts();
  const selectionsQuery = useBrokerSelections();
  const optOuts = optOutsQuery.data ?? [];
  const enabledBrokerIds = selectionsQuery.data?.enabled_broker_ids;
  const visibleOptOuts = useMemo(
    () => filterOptOutsByEnabledBrokerIds(optOuts, enabledBrokerIds),
    [enabledBrokerIds, optOuts],
  );
  const loading = statsQuery.isLoading || optOutsQuery.isLoading || selectionsQuery.isLoading;
  const error = statsQuery.error ?? optOutsQuery.error;
  const noBrokersEnabled =
    selectionsQuery.isSuccess &&
    (selectionsQuery.data?.enabled_broker_ids?.length ?? 0) === 0;
  const groupedOptOuts = useMemo(() => groupOptOuts(visibleOptOuts), [visibleOptOuts]);
  const totalCount = visibleOptOuts.length;
  const workingCount = groupedOptOuts.working.length;
  const doneCount = groupedOptOuts.done.length;
  const attentionCount = groupedOptOuts.attention.length;
  const animatedWorkingCount = useCountUp(loading ? 0 : workingCount);
  const animatedDoneCount = useCountUp(loading ? 0 : doneCount);
  const animatedAttentionCount = useCountUp(loading ? 0 : attentionCount);
  const retryOverview = () => {
    void statsQuery.refetch();
    void optOutsQuery.refetch();
    void selectionsQuery.refetch();
  };

  return (
    <section className="mx-auto grid max-w-container gap-5 px-gutter py-6">
      {error ? (
        <ErrorState
          description="Smokescreen could not refresh broker status from the local API. Check that the service is running, then try again."
          onAction={retryOverview}
          title="Broker status is unavailable"
        />
      ) : null}

      {noBrokersEnabled ? (
        <Card
          className="border-[color:var(--border-strong)] bg-surface-raised px-[22px] py-[16px]"
          data-testid="no-brokers-enabled-banner"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2 text-content-strong">
                <AlertTriangle aria-hidden="true" className="h-5 w-5 text-rust-500" />
                <span className="font-display text-base font-semibold">No enabled brokers</span>
              </div>
              <p className="mt-1 max-w-[62ch] text-sm text-content-muted">{noEnabledBrokersStatusCopy}</p>
            </div>
            <div className="flex flex-wrap gap-[10px]">
              <Button asChild variant="primary">
                <Link to="/brokers">Configure brokers</Link>
              </Button>
              <Button asChild variant="outline">
                <Link to="/brokers">Open registry</Link>
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      <Card variant="accent" className="ss-haze overflow-hidden px-[26px] py-[26px]">
        <div className="flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
          <div className="max-w-[44ch]">
            <span className="ss-label text-brand-strong">Privacy removal status</span>
            <h1 className="mt-2 font-display text-3xl font-semibold leading-tight text-content-strong">
              {statusHeadline({ loading, workingCount })}
            </h1>
            <p className="mt-3 text-base leading-relaxed text-content-muted">
              {statusSummary({ doneCount, loading, totalCount })}
            </p>
          </div>
          <div className="flex flex-wrap gap-[10px]">
            <Button asChild variant="accent">
              <Link to="/needs-attention">
                Review requests
                <ArrowRight />
              </Link>
            </Button>
            <Button variant="outline" onClick={retryOverview} type="button">
              <RefreshCcw />
              Refresh
            </Button>
          </div>
        </div>
      </Card>

      <div className="grid gap-[14px] md:grid-cols-3">
        <Metric
          icon={<Mail />}
          label="Working"
          sub="requests in flight"
          tone="working"
          value={loading ? "--" : animatedWorkingCount}
        />
        <Metric
          icon={<Check />}
          label="Closed"
          sub="terminal records"
          tone="done"
          value={loading ? "--" : animatedDoneCount}
        />
        <Metric
          icon={<AlertTriangle />}
          label="Needs attention"
          sub="awaiting your review"
          tone="attention"
          value={loading ? "--" : animatedAttentionCount}
        />
      </div>

      <div id="broker-status" className="grid scroll-mt-6 gap-[18px] lg:grid-cols-3">
        <StatusGroup
          group="working"
          records={groupedOptOuts.working}
          loading={loading}
          emptyDescription={noBrokersEnabled ? noEnabledBrokersStatusCopy : undefined}
        />
        <StatusGroup
          group="done"
          records={groupedOptOuts.done}
          loading={loading}
          emptyDescription={noBrokersEnabled ? noEnabledBrokersStatusCopy : undefined}
        />
        <StatusGroup
          group="attention"
          records={groupedOptOuts.attention}
          loading={loading}
          emptyDescription={noBrokersEnabled ? noEnabledBrokersStatusCopy : undefined}
        />
      </div>
    </section>
  );
}

function groupOptOuts(records: OptOutRecord[]): Record<BrokerStatusGroup, OptOutRecord[]> {
  return records.reduce<Record<BrokerStatusGroup, OptOutRecord[]>>(
    (groups, record) => {
      groups[brokerStatusGroup[record.status]].push(record);
      return groups;
    },
    {
      working: [],
      done: [],
      attention: [],
    },
  );
}

function filterOptOutsByEnabledBrokerIds(
  records: OptOutRecord[],
  enabledBrokerIds: string[] | undefined,
): OptOutRecord[] {
  if (!enabledBrokerIds) {
    return records;
  }
  const enabled = new Set(enabledBrokerIds);
  return records.filter((record) => enabled.has(record.broker_id));
}

function statusHeadline({
  loading,
  workingCount,
}: {
  loading: boolean;
  workingCount: number;
}): string {
  if (loading) {
    return "Checking broker removals";
  }

  return `${workingCount} ${pluralize("broker", workingCount)} requesting removal of your data`;
}

function statusSummary({
  doneCount,
  loading,
  totalCount,
}: {
  doneCount: number;
  loading: boolean;
  totalCount: number;
}): string {
  if (loading) {
    return "Smokescreen is loading the latest broker status from your local API.";
  }
  if (totalCount === 0) {
    return "0 closed so far. Smokescreen will send requests and watch broker replies when you add brokers.";
  }

  return `${doneCount} closed so far. Smokescreen is sending requests and watching broker replies until every record is done.`;
}

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}

function StatusGroup({
  group,
  records,
  loading,
  emptyDescription,
}: {
  group: BrokerStatusGroup;
  records: OptOutRecord[];
  loading: boolean;
  emptyDescription?: ReactNode;
}) {
  const copy = statusGroupLabels[group];

  return (
    <section className="grid content-start gap-3">
      <div>
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-display text-lg font-semibold leading-tight text-content-strong">{copy.title}</h2>
          <Badge variant={group === "attention" && records.length > 0 ? "danger" : "neutral"}>
            {loading ? "--" : records.length}
          </Badge>
        </div>
        <p className="mt-[3px] text-xs leading-normal text-content-muted">{copy.description}</p>
      </div>

      {loading ? (
        <StatusColumnPlaceholder description="Fetching latest broker status." title="Loading requests" />
      ) : null}
      {!loading && records.length === 0 ? (
        <StatusColumnPlaceholder
          description={emptyDescription ?? statusEmptyDescriptions[group]}
          title="Nothing here"
        />
      ) : null}
      {records.map((record) => (
        <BrokerStatusCard key={record.broker_id} record={record} />
      ))}
    </section>
  );
}

function BrokerStatusCard({ record }: { record: OptOutRecord }) {
  const copy = brokerStatusCopy[record.status];
  const isWorking = copy.group === "working";

  if (copy.group === "attention") {
    return <ManualStatusCard record={record} />;
  }

  return (
    <Card className="grid gap-[10px] overflow-hidden" pad>
      {isWorking ? <ScanSweep /> : null}
      <div className="relative z-[1] flex items-start justify-between gap-[10px]">
        <div className="min-w-0 break-words">
          <div className="font-display text-base font-semibold leading-snug text-content-strong">{record.broker_name}</div>
          <div className="mt-0.5 break-all font-mono text-xs text-content-muted">
            {record.broker_domain || "Domain not listed"}
          </div>
        </div>
        <StatusPill className="shrink-0" status={record.status} />
      </div>
      <div className="relative z-[1] flex items-center gap-[6px] font-mono text-xs text-content-faint">
        <Clock3 className="h-[13px] w-[13px]" />
        Updated {formatUpdatedAgo(record.updated_at)}
      </div>
    </Card>
  );
}

function ManualStatusCard({ record }: { record: OptOutRecord }) {
  const summary = getNeedsManualSummary(record);
  const transitionedAge = record.needs_manual_reason
    ? formatTransitionAge(record.needs_manual_reason.transitioned_at)
    : null;

  return (
    <Card className="grid gap-[10px] overflow-hidden" pad>
      <div className="relative z-[1] min-w-0 break-words">
        <div className="font-display text-base font-semibold leading-snug text-content-strong">{record.broker_name}</div>
        <p className="mt-[7px] break-words text-sm font-medium leading-relaxed text-content-body">{summary}</p>
        {transitionedAge ? (
          <div className="mt-[8px] flex items-center gap-[6px] font-mono text-xs text-content-faint">
            <Clock3 className="h-[13px] w-[13px]" />
            {transitionedAge}
          </div>
        ) : null}
      </div>
      <ManualReasonDetails record={record} />
    </Card>
  );
}

function StatusColumnPlaceholder({ description, title }: { description: ReactNode; title: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-[color:var(--border-strong)] px-3 py-[22px] text-center">
      <div className="font-mono text-xs text-content-faint">{title}</div>
      <div className="mt-1 text-xs leading-normal text-content-muted">{description}</div>
    </div>
  );
}

export function SettingsPage() {
  return <SettingsConsolePage />;
}

export function TrustedSendersPage() {
  const queryClient = useQueryClient();
  const whitelistQuery = useWhitelist();
  const pendingQuery = usePendingWhitelist();
  const brokersQuery = useBrokers();
  const brokers = brokersQuery.data ?? [];
  const brokerById = useMemo(() => new Map(brokers.map((broker) => [broker.id, broker])), [brokers]);
  const [selectedBrokerId, setSelectedBrokerId] = useState("");
  const [email, setEmail] = useState("");
  const trustedSenders = useMemo(
    () => [...(whitelistQuery.data ?? [])].sort((a, b) => a.email.localeCompare(b.email)),
    [whitelistQuery.data],
  );
  const manualCount = trustedSenders.filter((entry) => entry.source === "manual").length;
  const registryCount = trustedSenders.length - manualCount;
  const pendingSenders = pendingQuery.data ?? [];

  const addMutation = useMutation({
    mutationFn: api.addWhitelist,
    onSuccess: async () => {
      setSelectedBrokerId("");
      setEmail("");
      await queryClient.invalidateQueries({ queryKey: ["whitelist"] });
    },
  });
  const deleteMutation = useMutation({
    mutationFn: api.deleteWhitelist,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["whitelist"] });
    },
  });
  const approveMutation = useMutation({
    mutationFn: api.approvePendingWhitelist,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["whitelist"] }),
        queryClient.invalidateQueries({ queryKey: ["pending-whitelist"] }),
      ]);
    },
  });
  const rejectMutation = useMutation({
    mutationFn: api.rejectPendingWhitelist,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["pending-whitelist"] });
    },
  });

  function addTrustedSender(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedBrokerId = selectedBrokerId.trim();
    const trimmedEmail = email.trim();
    if (!trimmedBrokerId || !trimmedEmail) {
      return;
    }
    addMutation.mutate({ broker_id: trimmedBrokerId, email: trimmedEmail });
  }

  function removeTrustedSender(entry: WhitelistEntry) {
    if (entry.source === "registry") {
      return;
    }
    const confirmed = window.confirm(`Remove ${entry.email} from trusted senders?`);
    if (confirmed) {
      deleteMutation.mutate(entry.id);
    }
  }

  function refreshTrustedSenders() {
    void whitelistQuery.refetch();
    void pendingQuery.refetch();
    void brokersQuery.refetch();
  }

  const loadError = whitelistQuery.error ?? pendingQuery.error ?? brokersQuery.error;
  const mutationError = addMutation.error ?? deleteMutation.error ?? approveMutation.error ?? rejectMutation.error;
  const loading = whitelistQuery.isLoading || pendingQuery.isLoading || brokersQuery.isLoading;
  const retryTrustedSenders = () => {
    void whitelistQuery.refetch();
    void pendingQuery.refetch();
    void brokersQuery.refetch();
  };

  return (
    <section className="mx-auto grid max-w-6xl gap-5 px-5 py-6 sm:px-6 lg:px-8">
      {loadError ? (
        <ErrorState
          description="Smokescreen could not load trusted senders. Check the local API, then refresh this list."
          onAction={retryTrustedSenders}
          title="Trusted senders are unavailable"
        />
      ) : null}
      {mutationError ? (
        <ErrorState
          description="Smokescreen could not update that sender. Try again, or refresh before making another change."
          onAction={retryTrustedSenders}
          title="Sender update did not finish"
        />
      ) : null}

      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h2 className="text-2xl font-semibold tracking-normal">Trusted Senders</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Smokescreen only processes replies from approved addresses. Review newly detected senders here before their
            messages are trusted.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refreshTrustedSenders}>
          <RefreshCcw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <TrustMetric
          icon={<ShieldCheck className="h-4 w-4" />}
          label="Trusted senders"
          value={loading ? "--" : trustedSenders.length}
        />
        <TrustMetric
          icon={<AlertTriangle className="h-4 w-4" />}
          label="Need review"
          value={loading ? "--" : pendingSenders.length}
        />
        <TrustMetric
          icon={<UserCheck className="h-4 w-4" />}
          label="Broker list"
          value={loading ? "--" : registryCount}
        />
        <TrustMetric
          icon={<UserPlus className="h-4 w-4" />}
          label="Added by you"
          value={loading ? "--" : manualCount}
        />
      </div>

      <Card>
        <CardHeader className="items-start">
          <div>
            <CardTitle>Approve a sender</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">Add an address when you expect replies from it.</p>
          </div>
          <ShieldPlus className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <form className="grid gap-3 md:grid-cols-[1fr_1fr_auto]" onSubmit={addTrustedSender}>
            <label className="grid gap-1 text-sm font-medium">
              Broker
              <select
                className="h-10 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={selectedBrokerId}
                onChange={(event) => setSelectedBrokerId(event.target.value)}
              >
                <option value="">Choose a broker</option>
                {brokers.map((broker) => (
                  <option key={broker.id} value={broker.id}>
                    {broker.name}
                    {broker.domain ? ` (${broker.domain})` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm font-medium">
              Email address
              <input
                className="h-10 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="privacy@example.com"
                type="email"
                autoComplete="email"
              />
            </label>
            <Button
              className="self-end"
              disabled={addMutation.isPending || !selectedBrokerId.trim() || !email.trim()}
              type="submit"
            >
              <ShieldPlus className="h-4 w-4" />
              {addMutation.isPending ? "Adding" : "Add sender"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="items-start">
          <div>
            <CardTitle>Pending approvals</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Unknown reply addresses wait here until you trust or dismiss them.
            </p>
          </div>
          <Badge variant={pendingSenders.length > 0 ? "destructive" : "secondary"}>{pendingSenders.length}</Badge>
        </CardHeader>
        <CardContent>
          {pendingQuery.isLoading ? (
            <LoadingState
              className="bg-muted/40 py-8 shadow-none"
              description="Checking for newly detected reply addresses."
              title="Loading pending senders"
            />
          ) : null}

          {!pendingQuery.isLoading && pendingSenders.length === 0 ? (
            <EmptyState
              className="bg-muted/40 py-8 shadow-none"
              description="No sender approvals are waiting right now."
              icon={<CheckCircle2 className="h-5 w-5" />}
              title="All senders are reviewed"
            />
          ) : null}

          <div className="grid gap-3">
            {pendingSenders.map((entry) => (
              <PendingApprovalItem
                key={entry.id}
                entry={entry}
                isApproving={approveMutation.isPending && approveMutation.variables === entry.id}
                isRejecting={rejectMutation.isPending && rejectMutation.variables === entry.id}
                onApprove={() => approveMutation.mutate(entry.id)}
                onReject={() => rejectMutation.mutate(entry.id)}
                brokerName={brokerDisplayName(entry.broker_id, brokerById)}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="items-start">
          <div>
            <CardTitle>Trusted addresses</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Addresses that Smokescreen can use when matching broker replies.
            </p>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden rounded-md border">
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <thead className="bg-muted/70 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Email</th>
                  <th className="px-4 py-3 font-medium">Broker</th>
                  <th className="px-4 py-3 font-medium">Source</th>
                  <th className="px-4 py-3 font-medium">Added</th>
                  <th className="px-4 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {whitelistQuery.isLoading ? (
                  <tr>
                    <td className="px-4 py-8" colSpan={5}>
                      <LoadingState
                        className="border-0 bg-transparent py-2 shadow-none"
                        description="Loading trusted addresses."
                        title="Loading senders"
                      />
                    </td>
                  </tr>
                ) : null}
                {trustedSenders.map((entry) => (
                  <tr key={entry.id} className="border-t">
                    <td className="px-4 py-3 font-medium">{entry.email}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {brokerDisplayName(entry.broker_id, brokerById)}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={entry.source === "registry" ? "secondary" : "outline"}>
                        {sourceLabel(entry.source)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{formatUpdatedAt(entry.added_at)}</td>
                    <td className="px-4 py-3">
                      {entry.source === "manual" ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => removeTrustedSender(entry)}
                          disabled={deleteMutation.isPending && deleteMutation.variables === entry.id}
                        >
                          <Trash2 className="h-4 w-4" />
                          {deleteMutation.isPending && deleteMutation.variables === entry.id ? "Removing" : "Remove"}
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">Synced from broker list</span>
                      )}
                    </td>
                  </tr>
                ))}
                {!whitelistQuery.isLoading && trustedSenders.length === 0 ? (
                  <tr>
                    <td className="px-4 py-8" colSpan={5}>
                      <EmptyState
                        className="border-0 bg-transparent py-2 shadow-none"
                        description="Trusted reply addresses will appear here after you add them or approve detected senders."
                        title="No trusted senders yet"
                      />
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

function sourceLabel(source: WhitelistEntry["source"]): string {
  return source === "registry" ? "Broker list" : "Added by you";
}

function brokerDisplayName(brokerId: string | null | undefined, brokerById: Map<string, Broker>): string {
  if (!brokerId) {
    return "Unknown broker";
  }
  return brokerById.get(brokerId)?.name ?? "Unlisted broker";
}

function TrustMetric({ icon, label, value }: { icon: ReactNode; label: string; value: number | string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{label}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold">{value}</p>
      </CardContent>
    </Card>
  );
}

function PendingApprovalItem({
  entry,
  isApproving,
  isRejecting,
  onApprove,
  onReject,
  brokerName,
}: {
  entry: PendingWhitelistEntry;
  isApproving: boolean;
  isRejecting: boolean;
  onApprove: () => void;
  onReject: () => void;
  brokerName: string;
}) {
  return (
    <div className="rounded-md border bg-background p-4">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="break-words text-sm font-semibold">{entry.email}</p>
            <Badge variant="outline">{brokerName}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Detected {formatUpdatedAt(entry.detected_at)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" onClick={onApprove} disabled={isApproving || isRejecting}>
            <UserCheck className="h-4 w-4" />
            {isApproving ? "Approving" : "Trust"}
          </Button>
          <Button variant="outline" size="sm" onClick={onReject} disabled={isApproving || isRejecting}>
            <XCircle className="h-4 w-4" />
            {isRejecting ? "Dismissing" : "Dismiss"}
          </Button>
        </div>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-md border bg-muted/40 p-3">
          <p className="text-xs font-medium uppercase text-muted-foreground">Subject</p>
          <p className="mt-1 break-words text-sm">{entry.message_subject || "No subject saved"}</p>
        </div>
        <div className="rounded-md border bg-muted/40 p-3">
          <p className="text-xs font-medium uppercase text-muted-foreground">Preview</p>
          <p className="mt-1 break-words text-sm">{entry.message_snippet || "No preview saved"}</p>
        </div>
      </div>
    </div>
  );
}

export function NeedsAttentionPage() {
  const queryClient = useQueryClient();
  const attentionQuery = useOptOuts("needs_attention");
  const selectionsQuery = useBrokerSelections();
  const attentionRecords = attentionQuery.data ?? [];
  const enabledBrokerIds = selectionsQuery.data?.enabled_broker_ids;
  const records = useMemo(
    () =>
      filterOptOutsByEnabledBrokerIds(attentionRecords, enabledBrokerIds).filter(
        (record) => record.status === "NEEDS_MANUAL" || record.status === "FAILED",
      ),
    [attentionRecords, enabledBrokerIds],
  );
  const [resolvingBrokerId, setResolvingBrokerId] = useState<string | null>(null);
  const [resolvedBrokerIds, setResolvedBrokerIds] = useState<Set<string>>(() => new Set());
  const visibleRecords = useMemo(
    () => records.filter((record) => !resolvedBrokerIds.has(record.broker_id)),
    [records, resolvedBrokerIds],
  );
  const refreshAttentionData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["opt-outs"] }),
      queryClient.invalidateQueries({ queryKey: ["extended-stats"] }),
    ]);
  };
  const retryMutation = useMutation({
    mutationFn: api.retryClassification,
    onSuccess: refreshAttentionData,
  });
  const acceptRejectionMutation = useMutation({
    mutationFn: api.acceptRejection,
    onSuccess: refreshAttentionData,
  });
  const escalateRejectionMutation = useMutation({
    mutationFn: ({ brokerId, context }: { brokerId: string; context: string }) =>
      api.escalateRejection(brokerId, context),
    onSuccess: refreshAttentionData,
  });
  const markHandledMutation = useMutation({
    mutationFn: api.markOptOutHandled,
    onSuccess: refreshAttentionData,
  });
  const viewState = getAttentionViewState({
    hasError: Boolean(attentionQuery.error),
    isLoading: attentionQuery.isLoading || selectionsQuery.isLoading,
    recordCount: visibleRecords.length,
  });
  const retryAttention = () => {
    void attentionQuery.refetch();
    void selectionsQuery.refetch();
  };

  function retryRecord(record: OptOutRecord) {
    retryMutation.mutate(record.broker_id);
  }

  function acceptRejection(record: OptOutRecord) {
    const confirmed = window.confirm(
      "Accept this rejection? The record will be marked REJECTED and excluded from future outreach cycles.",
    );
    if (!confirmed) {
      return;
    }
    acceptRejectionMutation.mutate(record.broker_id);
  }

  function escalateRejection(record: OptOutRecord, context: string) {
    escalateRejectionMutation.mutate({ brokerId: record.broker_id, context });
  }

  function markRecordHandled(record: OptOutRecord) {
    setResolvingBrokerId(record.broker_id);
  }

  function finishMarkHandled(record: OptOutRecord) {
    setResolvingBrokerId((currentId) => (currentId === record.broker_id ? null : currentId));
    setResolvedBrokerIds((currentIds) => {
      const nextIds = new Set(currentIds);
      nextIds.add(record.broker_id);
      return nextIds;
    });
    markHandledMutation.mutate(record.broker_id);
  }

  return (
    <section className="mx-auto grid max-w-6xl gap-5 px-5 py-6 sm:px-6 lg:px-8">
      {attentionQuery.error ? (
        <ErrorState
          description="Smokescreen could not load broker items that need review. Refresh after checking the local API."
          onAction={retryAttention}
          title="Needs-attention items are unavailable"
        />
      ) : null}
      {retryMutation.error ? (
        <ErrorState
          description={
            retryMutation.error.message ||
            "Smokescreen could not retry that broker. Refresh the queue before trying again."
          }
          onAction={() => {
            retryMutation.reset();
            retryAttention();
          }}
          title="Request was not retried"
        />
      ) : null}
      {markHandledMutation.error ? (
        <ErrorState
          description="Smokescreen could not mark that broker handled. Refresh the queue before trying again."
          onAction={() => {
            markHandledMutation.reset();
            retryAttention();
          }}
          title="Request was not marked handled"
        />
      ) : null}
      {acceptRejectionMutation.error ? (
        <ErrorState
          description={
            acceptRejectionMutation.error.message ||
            "Smokescreen could not accept that rejection. Refresh the queue before trying again."
          }
          onAction={() => {
            acceptRejectionMutation.reset();
            retryAttention();
          }}
          title="Rejection was not accepted"
        />
      ) : null}
      {escalateRejectionMutation.error ? (
        <ErrorState
          description={
            escalateRejectionMutation.error.message ||
            "Smokescreen could not escalate that rejection. Refresh the queue before trying again."
          }
          onAction={() => {
            escalateRejectionMutation.reset();
            retryAttention();
          }}
          title="Rejection was not escalated"
        />
      ) : null}

      <div>
        <h1 className="text-2xl font-semibold tracking-normal">Needs Attention</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Smokescreen handles most of the workflow automatically. These replies need a quick human decision before it can continue.
        </p>
      </div>

      {viewState === "loading" ? (
        <LoadingState description="Checking for broker items that need your review." title="Loading review queue" />
      ) : null}
      {viewState === "empty" ? <EmptyAttentionState /> : null}

      <div className="grid gap-4">
        {visibleRecords.map((record) => (
          <AttentionItem
            key={record.broker_id}
            record={record}
            isMarkingHandled={markHandledMutation.isPending && markHandledMutation.variables === record.broker_id}
            isResolving={resolvingBrokerId === record.broker_id}
            isRetrying={retryMutation.isPending && retryMutation.variables === record.broker_id}
            isAcceptingRejection={
              acceptRejectionMutation.isPending && acceptRejectionMutation.variables === record.broker_id
            }
            isEscalatingRejection={
              escalateRejectionMutation.isPending && escalateRejectionMutation.variables?.brokerId === record.broker_id
            }
            onAcceptRejection={() => acceptRejection(record)}
            onEscalateRejection={(context) => escalateRejection(record, context)}
            onMarkHandled={() => markRecordHandled(record)}
            onResolveDone={() => finishMarkHandled(record)}
            onRetry={() => retryRecord(record)}
          />
        ))}
      </div>
    </section>
  );
}

function AttentionItem({
  record,
  isMarkingHandled,
  isResolving,
  isRetrying,
  isAcceptingRejection,
  isEscalatingRejection,
  onAcceptRejection,
  onEscalateRejection,
  onMarkHandled,
  onResolveDone,
  onRetry,
}: {
  record: OptOutRecord;
  isMarkingHandled: boolean;
  isResolving: boolean;
  isRetrying: boolean;
  isAcceptingRejection: boolean;
  isEscalatingRejection: boolean;
  onAcceptRejection: () => void;
  onEscalateRejection: (context: string) => void;
  onMarkHandled: () => void;
  onResolveDone: () => void;
  onRetry: () => void;
}) {
  const [isEscalationOpen, setIsEscalationOpen] = useState(false);
  const [escalationContext, setEscalationContext] = useState("");
  const [escalationError, setEscalationError] = useState("");
  const guidance = getAttentionGuidance(record);
  const manualSummary = getNeedsManualSummary(record);
  const reason = record.needs_manual_reason;
  const isBrokerRejectedReview = reason?.reason_code === "broker_rejected";
  const transitionedAge = reason ? formatTransitionAge(reason.transitioned_at) : null;
  const sourceEmailHref = getSourceEmailHref(record.thread_id);
  const actionLabels = getAttentionActionLabels({ isMarkingHandled: isMarkingHandled || isResolving, isRetrying });
  const actionPending = isMarkingHandled || isRetrying || isResolving || isAcceptingRejection || isEscalatingRejection;
  const escalationContextId = `escalation-context-${record.broker_id}`;

  function openEscalationForm() {
    setEscalationError("");
    setIsEscalationOpen(true);
  }

  function cancelEscalation() {
    setEscalationContext("");
    setEscalationError("");
    setIsEscalationOpen(false);
  }

  function submitEscalation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const context = escalationContext.trim();
    if (!context) {
      setEscalationError("Context is required before escalating.");
      return;
    }
    setEscalationError("");
    onEscalateRejection(context);
  }

  return (
    <Card
      variant="accent"
      pad
      className={cn(
        "ss-rowin border-t-rust-500 transition-opacity duration-base ease-standard",
        isResolving ? "overflow-visible opacity-50" : "overflow-hidden opacity-100",
      )}
    >
      {isResolving ? <Poof count={9} onDone={onResolveDone} /> : null}
      <div className="flex flex-wrap items-start justify-between gap-[14px]">
        <div className="min-w-0">
          <h2 className="break-words text-lg font-semibold tracking-normal">{record.broker_name}</h2>
          <div className="mt-[9px] flex flex-wrap items-center gap-2">
            <p className="max-w-3xl break-words text-sm font-medium leading-relaxed text-content-body">
              {manualSummary}
            </p>
            {transitionedAge ? (
              <span className="rounded-sm border border-border bg-surface-sunken px-2 py-1 font-mono text-2xs uppercase tracking-label text-content-muted">
                {transitionedAge}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {isBrokerRejectedReview ? (
            <>
              <Button variant="danger" size="sm" onClick={onAcceptRejection} disabled={actionPending}>
                <XCircle className="h-4 w-4" />
                {isAcceptingRejection ? "Accepting" : "Accept rejection"}
              </Button>
              <Button size="sm" onClick={openEscalationForm} disabled={actionPending}>
                <ShieldPlus className="h-4 w-4" />
                {isEscalatingRejection ? "Escalating" : "Escalate"}
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" size="sm" onClick={onRetry} disabled={actionPending}>
                <RotateCcw className="h-4 w-4" />
                {actionLabels.retry}
              </Button>
              <Button size="sm" onClick={onMarkHandled} disabled={actionPending}>
                <Check className="h-4 w-4" />
                {actionLabels.markHandled}
              </Button>
            </>
          )}
        </div>
      </div>

      <ManualReasonDetails
        className="mt-[14px]"
        guidance={guidance}
        record={record}
        sourceEmailHref={sourceEmailHref}
        sourceEmailLabel={actionLabels.sourceEmail}
      />

      {isBrokerRejectedReview && isEscalationOpen ? (
        <form className="mt-[14px] rounded-sm border border-border bg-surface-sunken px-[13px] py-[11px]" onSubmit={submitEscalation}>
          <label className="ss-label mb-[7px] block text-content-muted" htmlFor={escalationContextId}>
            Provide additional context to strengthen your escalation. This will be used by the AI to compose a stronger rebuttal.
          </label>
          <textarea
            className="min-h-28 w-full resize-y rounded-sm border border-border bg-surface px-[11px] py-[9px] text-sm leading-relaxed text-content-body outline-none transition-shadow focus:shadow-focus"
            disabled={isEscalatingRejection}
            id={escalationContextId}
            onChange={(event) => {
              setEscalationContext(event.target.value);
              if (escalationError) {
                setEscalationError("");
              }
            }}
            value={escalationContext}
          />
          {escalationError ? <p className="mt-2 text-sm text-rust-400">{escalationError}</p> : null}
          <div className="mt-[10px] flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={cancelEscalation} disabled={isEscalatingRejection}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={isEscalatingRejection}>
              <ShieldPlus className="h-4 w-4" />
              {isEscalatingRejection ? "Submitting" : "Submit escalation"}
            </Button>
          </div>
        </form>
      ) : null}

    </Card>
  );
}

function ManualReasonDetails({
  className,
  guidance,
  record,
  sourceEmailHref,
  sourceEmailLabel,
}: {
  className?: string;
  guidance?: { recommendedStep: string; title: string };
  record: OptOutRecord;
  sourceEmailHref?: string | null;
  sourceEmailLabel?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const reason = record.needs_manual_reason;
  const classifierOutputText = reason ? formatClassifierOutput(reason.classifier_output) : "";
  const transitionedAt = reason ? formatFriendlyTimestamp(reason.transitioned_at) : null;
  const brokerReplyExcerpt = reason?.broker_reply_excerpt.trim() ?? "";
  const savedReply = record.notes.trim();
  const showSavedReply = savedReply.length > 0 && savedReply !== brokerReplyExcerpt;
  const showMissingReplyFallback = !reason && !savedReply;
  const verificationGap = getVerificationProfileGap(record);

  return (
    <details
      className={cn("group rounded-sm border border-border bg-surface-sunken", className)}
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
    >
      <summary
        className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-[13px] py-[10px] [&::-webkit-details-marker]:hidden"
        onClick={(event) => {
          const details = event.currentTarget.parentElement as HTMLDetailsElement | null;
          setIsOpen(!(details?.open ?? false));
        }}
      >
        <ChevronDown className="h-4 w-4 text-content-muted transition-transform duration-base group-open:rotate-180" />
        <span className="ss-label text-content-muted">Needs Attention Details</span>
      </summary>
      {isOpen ? (
        <div className="grid gap-3 border-t border-border px-[13px] py-[11px] lg:grid-cols-2">
          {guidance ? (
            <div>
              <div className="ss-label mb-[5px]">{guidance.title}</div>
              <p className="text-sm leading-relaxed text-content-body">{guidance.recommendedStep}</p>
            </div>
          ) : null}
          {sourceEmailLabel ? (
            <div>
              <div className="ss-label mb-[5px]">Source email</div>
              {sourceEmailHref ? (
                <Button asChild variant="outline" size="sm">
                  <a href={sourceEmailHref} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-4 w-4" />
                    {sourceEmailLabel}
                  </a>
                </Button>
              ) : (
                <Button variant="outline" size="sm" disabled>
                  <ExternalLink className="h-4 w-4" />
                  {sourceEmailLabel}
                </Button>
              )}
            </div>
          ) : null}
          {verificationGap ? (
            <div className="rounded-sm border border-bd-amber bg-fill-amber px-[13px] py-[11px] lg:col-span-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="ss-label text-soft-amber">Verification profile gap</div>
                <Button asChild variant="outline" size="sm">
                  <Link to="/settings#settings-verification-profile">
                    <ShieldCheck className="h-4 w-4" />
                    Verification Profile
                  </Link>
                </Button>
              </div>
              <p className="mt-[7px] text-sm leading-relaxed text-soft-amber">
                Broker asked for: {verificationGap.askedFor}. You are missing: {verificationGap.missing}.
              </p>
              {verificationGap.otherDetails ? (
                <p className="mt-[5px] text-xs leading-relaxed text-content-body">{verificationGap.otherDetails}</p>
              ) : null}
            </div>
          ) : null}
          {reason ? (
            <div>
              <div className="ss-label mb-[5px]">Reason code</div>
              <Badge className="max-w-full whitespace-normal break-all leading-snug" variant="outline">
                {reason.reason_code}
              </Badge>
            </div>
          ) : null}
          {reason?.missing_fields.length ? (
            <div>
              <div className="ss-label mb-[5px]">Missing fields</div>
              <div className="flex flex-wrap gap-1">
                {reason.missing_fields.map((field) => (
                  <Badge key={field} variant="amber">
                    {field}
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}
          {transitionedAt ? (
            <div>
              <div className="ss-label mb-[5px]">Transitioned at</div>
              <p className="font-mono text-xs text-content-muted">{transitionedAt}</p>
            </div>
          ) : null}
          {brokerReplyExcerpt ? (
            <div className="lg:col-span-2">
              <div className="ss-label mb-[5px]">Broker reply excerpt</div>
              <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-border bg-surface px-[11px] py-[9px] font-mono text-xs leading-relaxed text-content-body">
                {brokerReplyExcerpt}
              </pre>
            </div>
          ) : null}
          {showSavedReply ? (
            <div className="lg:col-span-2">
              <div className="ss-label mb-[5px]">Saved broker reply</div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-border bg-surface px-[11px] py-[9px] font-mono text-xs leading-relaxed text-content-body">
                {savedReply}
              </pre>
            </div>
          ) : null}
          {showMissingReplyFallback ? (
            <div className="lg:col-span-2">
              <div className="ss-label mb-[5px]">Saved broker reply</div>
              <p className="text-sm leading-relaxed text-content-body">{getBrokerReplyText(record)}</p>
            </div>
          ) : null}
          {classifierOutputText ? (
            <div className="lg:col-span-2">
              <div className="ss-label mb-[5px]">Classifier output</div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-border bg-surface px-[11px] py-[9px] font-mono text-xs leading-relaxed text-content-body">
                {classifierOutputText}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

function formatTransitionAge(value: string): string | null {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  const elapsedMs = Date.now() - timestamp;
  if (elapsedMs < 0) {
    return null;
  }

  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (elapsedMs < minute) {
    return "just now";
  }
  if (elapsedMs < hour) {
    return `${Math.floor(elapsedMs / minute)}m ago`;
  }
  if (elapsedMs < day) {
    return `${Math.floor(elapsedMs / hour)}h ago`;
  }
  return `${Math.floor(elapsedMs / day)}d ago`;
}

function formatFriendlyTimestamp(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatClassifierOutput(output: Record<string, unknown>): string {
  if (!Object.keys(output).length) {
    return "";
  }
  return JSON.stringify(output, null, 2);
}

function EmptyAttentionState() {
  return (
    <Card className="mx-auto w-full max-w-xl">
      <EmptyState
        description="Every broker reply has been handled."
        title="Queue clear"
      />
    </Card>
  );
}

export function ApiError({ message }: { message: string }) {
  return (
    <ErrorState
      description={message ? "Smokescreen could not complete that request. Refresh the view and try again." : "Smokescreen could not complete that request."}
      title="Request unavailable"
    />
  );
}
