import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  ExternalLink,
  Inbox,
  KeyRound,
  Mail,
  MessageSquareWarning,
  RefreshCcw,
  RotateCcw,
  Save,
  Settings,
  ShieldCheck,
  ShieldPlus,
  Trash2,
  UserCheck,
  UserPlus,
  UserRound,
  XCircle,
} from "lucide-react";
import { Link, NavLink, Outlet } from "react-router-dom";

import {
  api,
  type AdvancedSettings,
  type BrokerStatus,
  type FriendlySettings,
  type OptOutRecord,
  type PendingWhitelistEntry,
  type WhitelistEntry,
} from "./lib/api";
import {
  useAdvancedSettings,
  useExtendedStats,
  useOptOuts,
  usePendingWhitelist,
  useSettings,
  useWhitelist,
} from "./lib/queries";
import { cn } from "./lib/utils";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { EmptyState, ErrorState, LoadingState } from "./components/status-state";

type BrokerStatusGroup = "working" | "done" | "needs-attention";

interface BrokerStatusCopy {
  group: BrokerStatusGroup;
  label: string;
  description: string;
}

const brokerStatusCopy: Record<BrokerStatus, BrokerStatusCopy> = {
  PENDING: {
    group: "working",
    label: "Queued",
    description: "Smokescreen is preparing the removal request.",
  },
  INITIAL_SENT: {
    group: "working",
    label: "Request sent",
    description: "The broker has the opt-out request.",
  },
  AWAITING_RESPONSE: {
    group: "working",
    label: "Waiting on broker",
    description: "Smokescreen is watching for the broker's reply.",
  },
  IDENTITY_REQUESTED: {
    group: "working",
    label: "Identity requested",
    description: "The broker asked for identity details before continuing.",
  },
  IDENTITY_SENT: {
    group: "working",
    label: "Identity sent",
    description: "Smokescreen sent the requested identity details.",
  },
  COMPLETED: {
    group: "done",
    label: "Removed",
    description: "The broker marked the opt-out request complete.",
  },
  REJECTED: {
    group: "needs-attention",
    label: "Blocked by broker",
    description: "The broker declined the request and needs review.",
  },
  NEEDS_MANUAL: {
    group: "needs-attention",
    label: "Needs review",
    description: "Smokescreen needs you to review the broker's reply.",
  },
  FAILED: {
    group: "needs-attention",
    label: "Could not finish",
    description: "Smokescreen could not complete this request automatically.",
  },
};

const statusGroupLabels: Record<BrokerStatusGroup, { title: string; description: string }> = {
  working: {
    title: "Working",
    description: "Requests Smokescreen is sending, tracking, or following up on.",
  },
  done: {
    title: "Done",
    description: "Brokers that have confirmed removal or completion.",
  },
  "needs-attention": {
    title: "Needs attention",
    description: "Items that need a human review before Smokescreen can continue.",
  },
};

function formatUpdatedAt(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function AppNavLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      className={({ isActive }) =>
        cn(
          "inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
          isActive && "bg-muted text-foreground",
        )
      }
    >
      {children}
    </NavLink>
  );
}

export function App() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="border-b bg-card">
        <div className="mx-auto flex max-w-6xl flex-col gap-5 px-5 py-8 sm:px-6 lg:px-8">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <div>
              <p className="text-sm font-medium text-muted-foreground">Smokescreen</p>
              <h1 className="mt-1 text-3xl font-semibold tracking-normal">Smokescreen</h1>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                Track privacy opt-out requests without managing the underlying workflow.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <nav className="flex items-center gap-1 rounded-md border bg-background p-1">
                <AppNavLink to="/">Status</AppNavLink>
                <AppNavLink to="/onboarding">Setup</AppNavLink>
                <AppNavLink to="/needs-attention">Needs Attention</AppNavLink>
                <AppNavLink to="/brokers">Brokers</AppNavLink>
                <AppNavLink to="/trusted-senders">Trusted Senders</AppNavLink>
                <AppNavLink to="/settings">Settings</AppNavLink>
              </nav>
              <Button asChild variant="outline" size="sm">
                <a href="/old-dashboard">
                  <ExternalLink className="h-4 w-4" />
                  Old dashboard
                </a>
              </Button>
            </div>
          </div>
        </div>
      </section>
      <Outlet />
    </main>
  );
}

export function OverviewPage() {
  const statsQuery = useExtendedStats();
  const optOutsQuery = useOptOuts();
  const stats = statsQuery.data;
  const optOuts = optOutsQuery.data ?? [];
  const loading = statsQuery.isLoading || optOutsQuery.isLoading;
  const error = statsQuery.error ?? optOutsQuery.error;
  const groupedOptOuts = useMemo(() => groupOptOuts(optOuts), [optOuts]);
  const totalCount = stats?.total ?? optOuts.length;
  const workingCount = groupedOptOuts.working.length;
  const doneCount = groupedOptOuts.done.length;
  const attentionCount = groupedOptOuts["needs-attention"].length;
  const cta = primaryStatusCta({ attentionCount, totalCount, workingCount });
  const retryOverview = () => {
    void statsQuery.refetch();
    void optOutsQuery.refetch();
  };

  return (
    <section className="mx-auto grid max-w-6xl gap-6 px-5 py-6 sm:px-6 lg:px-8">
      {error ? (
        <ErrorState
          description="Smokescreen could not refresh broker status from the local API. Check that the service is running, then try again."
          onAction={retryOverview}
          title="Broker status is unavailable"
        />
      ) : null}

      <div className="rounded-md border bg-card p-5 shadow-sm sm:p-6">
        <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-center">
          <div className="max-w-3xl">
            <p className="text-sm font-medium text-primary">Privacy removal status</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-normal sm:text-4xl">
              {statusHeadline({ attentionCount, loading, totalCount, workingCount })}
            </h2>
            <p className="mt-3 max-w-2xl text-base leading-7 text-muted-foreground">
              {statusSummary({ attentionCount, doneCount, loading, totalCount, workingCount })}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              {cta.kind === "link" ? (
                <Link to={cta.to}>
                  {cta.label}
                  <ArrowRight className="h-4 w-4" />
                </Link>
              ) : (
                <a href={cta.href}>
                  {cta.label}
                  <ArrowRight className="h-4 w-4" />
                </a>
              )}
            </Button>
            <Button
              variant="outline"
              onClick={retryOverview}
            >
              <RefreshCcw className="h-4 w-4" />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatusMetric
          icon={<Mail className="h-4 w-4" />}
          label="Working"
          value={loading ? "--" : workingCount}
          tone="working"
        />
        <StatusMetric
          icon={<CheckCircle2 className="h-4 w-4" />}
          label="Done"
          value={loading ? "--" : stats?.completed_count ?? doneCount}
          tone="done"
        />
        <StatusMetric
          icon={<AlertTriangle className="h-4 w-4" />}
          label="Needs attention"
          value={loading ? "--" : attentionCount}
          tone="needs-attention"
        />
      </div>

      <div id="broker-status" className="grid scroll-mt-6 gap-6 lg:grid-cols-3">
        <StatusGroup group="working" records={groupedOptOuts.working} loading={loading} />
        <StatusGroup group="done" records={groupedOptOuts.done} loading={loading} />
        <StatusGroup group="needs-attention" records={groupedOptOuts["needs-attention"]} loading={loading} />
      </div>
    </section>
  );
}

function groupOptOuts(records: OptOutRecord[]): Record<BrokerStatusGroup, OptOutRecord[]> {
  return records.reduce<Record<BrokerStatusGroup, OptOutRecord[]>>(
    (groups, record) => {
      groups[brokerStatusCopy[record.status].group].push(record);
      return groups;
    },
    {
      working: [],
      done: [],
      "needs-attention": [],
    },
  );
}

function statusHeadline({
  attentionCount,
  loading,
  totalCount,
  workingCount,
}: {
  attentionCount: number;
  loading: boolean;
  totalCount: number;
  workingCount: number;
}): string {
  if (loading) {
    return "Checking broker removals";
  }
  if (totalCount === 0) {
    return "Smokescreen is ready for broker requests";
  }
  if (workingCount > 0) {
    return `${workingCount} ${pluralize("broker", workingCount)} requesting removal of your data`;
  }
  if (attentionCount > 0) {
    return `${attentionCount} ${pluralize("broker", attentionCount)} ${attentionCount === 1 ? "needs" : "need"} your review`;
  }
  return "All tracked brokers are clear";
}

function statusSummary({
  attentionCount,
  doneCount,
  loading,
  totalCount,
  workingCount,
}: {
  attentionCount: number;
  doneCount: number;
  loading: boolean;
  totalCount: number;
  workingCount: number;
}): string {
  if (loading) {
    return "Smokescreen is loading the latest broker status from your local API.";
  }
  if (totalCount === 0) {
    return "Add brokers when you are ready, then Smokescreen will send requests and watch for replies.";
  }
  if (attentionCount > 0) {
    return "Most of the workflow stays automatic, but these broker replies need a quick review before the next step.";
  }
  if (workingCount > 0) {
    if (doneCount === 0) {
      return "Smokescreen is sending requests and watching broker replies until each removal is confirmed.";
    }
    return `${doneCount} ${pluralize("broker", doneCount)} already finished. Smokescreen is still watching the rest for replies and completion notices.`;
  }
  return "No broker needs a follow-up right now. Smokescreen will keep the completed records here for reference.";
}

function primaryStatusCta({
  attentionCount,
  totalCount,
  workingCount,
}: {
  attentionCount: number;
  totalCount: number;
  workingCount: number;
}): { kind: "anchor"; href: string; label: string } | { kind: "link"; to: string; label: string } {
  if (attentionCount > 0) {
    return { kind: "link", to: "/needs-attention", label: "Review requests" };
  }
  if (workingCount > 0) {
    return { kind: "anchor", href: "#broker-status", label: "See status" };
  }
  if (totalCount === 0) {
    return { kind: "link", to: "/brokers", label: "Add brokers" };
  }
  return { kind: "link", to: "/brokers", label: "View brokers" };
}

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}

function StatusMetric({
  icon,
  label,
  value,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: number | string;
  tone: BrokerStatusGroup;
}) {
  const toneClass = {
    working: "bg-accent/20 text-accent-foreground",
    done: "bg-primary/10 text-primary",
    "needs-attention": "bg-destructive/10 text-destructive",
  }[tone];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{label}</CardTitle>
        <div className={cn("flex h-8 w-8 items-center justify-center rounded-md", toneClass)}>{icon}</div>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold">{value}</p>
      </CardContent>
    </Card>
  );
}

function StatusGroup({
  group,
  records,
  loading,
}: {
  group: BrokerStatusGroup;
  records: OptOutRecord[];
  loading: boolean;
}) {
  const copy = statusGroupLabels[group];

  return (
    <section className="grid content-start gap-3">
      <div>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold tracking-normal">{copy.title}</h2>
          <Badge variant={group === "needs-attention" && records.length > 0 ? "destructive" : "secondary"}>
            {loading ? "--" : records.length}
          </Badge>
        </div>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">{copy.description}</p>
      </div>

      {loading ? (
        <LoadingState
          className="bg-muted/30 py-8 shadow-none"
          description={`Loading ${copy.title.toLowerCase()} broker requests.`}
          title="Loading requests"
        />
      ) : null}
      {!loading && records.length === 0 ? <EmptyStatusGroup group={group} /> : null}
      {records.map((record) => (
        <BrokerStatusCard key={record.broker_id} record={record} />
      ))}
    </section>
  );
}

function BrokerStatusCard({ record }: { record: OptOutRecord }) {
  const copy = brokerStatusCopy[record.status];
  const badgeVariant =
    copy.group === "needs-attention" ? "destructive" : copy.group === "done" ? "default" : "secondary";

  return (
    <Card>
      <CardHeader className="items-start pb-3">
        <div className="min-w-0">
          <CardTitle className="break-words text-base font-semibold text-foreground">{record.broker_name}</CardTitle>
          <p className="mt-1 break-words text-sm text-muted-foreground">
            {record.broker_domain || "Domain not listed"}
          </p>
        </div>
        <Badge variant={badgeVariant}>{copy.label}</Badge>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-sm leading-6 text-muted-foreground">{copy.description}</p>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Clock3 className="h-4 w-4" />
          Updated {formatUpdatedAt(record.updated_at)}
        </div>
        {copy.group === "needs-attention" && record.notes.trim() ? (
          <div className="rounded-md border bg-muted/40 p-3">
            <p className="text-xs font-medium uppercase text-muted-foreground">Broker note</p>
            <p className="mt-1 break-words text-sm leading-6">{record.notes}</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function EmptyStatusGroup({ group }: { group: BrokerStatusGroup }) {
  const emptyCopy = {
    working: "No brokers are in progress.",
    done: "Completed requests will appear here.",
    "needs-attention": "Nothing needs your attention.",
  }[group];

  return (
    <EmptyState
      className="border-dashed bg-muted/30 px-4 py-8 shadow-none"
      description={emptyCopy}
      title="No items here"
    />
  );
}

type IdentityForm = Pick<FriendlySettings, "sender_name" | "sender_email" | "identity_docs_dir">;

type AdvancedForm = {
  poll_label: string;
  max_retries: string;
  rerequest_interval_days: string;
  dry_run: boolean;
  anthropic_model: string;
};

const emptyIdentityForm: IdentityForm = {
  sender_name: "",
  sender_email: "",
  identity_docs_dir: "",
};

const emptyAdvancedForm: AdvancedForm = {
  poll_label: "",
  max_retries: "5",
  rerequest_interval_days: "60",
  dry_run: false,
  anthropic_model: "",
};

export function SettingsPage() {
  const queryClient = useQueryClient();
  const settingsQuery = useSettings();
  const advancedQuery = useAdvancedSettings();
  const settings = settingsQuery.data;
  const advancedSettings = advancedQuery.data;
  const [identityForm, setIdentityForm] = useState<IdentityForm>(emptyIdentityForm);
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [advancedForm, setAdvancedForm] = useState<AdvancedForm>(emptyAdvancedForm);
  const [message, setMessage] = useState("");
  const error = settingsQuery.error ?? advancedQuery.error;
  const settingsLoading = (settingsQuery.isLoading && !settings) || (advancedQuery.isLoading && !advancedSettings);
  const retrySettings = () => {
    void settingsQuery.refetch();
    void advancedQuery.refetch();
  };

  const updateMutation = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: async (result) => {
      setMessage(result.restart_required ? "Saved. Restart Smokescreen to apply every change." : "Saved.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
        queryClient.invalidateQueries({ queryKey: ["settings", "advanced"] }),
      ]);
    },
  });

  useEffect(() => {
    if (settings) {
      setIdentityForm({
        sender_name: settings.sender_name,
        sender_email: settings.sender_email,
        identity_docs_dir: settings.identity_docs_dir,
      });
    }
  }, [settings]);

  useEffect(() => {
    if (advancedSettings) {
      setAdvancedForm({
        poll_label: advancedSettings.poll_label,
        max_retries: String(advancedSettings.max_retries),
        rerequest_interval_days: String(advancedSettings.rerequest_interval_days),
        dry_run: advancedSettings.dry_run,
        anthropic_model: advancedSettings.anthropic_model,
      });
    }
  }, [advancedSettings]);

  function saveIdentity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    updateMutation.mutate({
      sender_name: identityForm.sender_name.trim(),
      sender_email: identityForm.sender_email.trim(),
      identity_docs_dir: identityForm.identity_docs_dir.trim(),
    });
  }

  function saveClaude(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = anthropicApiKey.trim();
    if (!value) {
      return;
    }
    updateMutation.mutate({ anthropic_api_key: value });
    setAnthropicApiKey("");
  }

  function disconnectGmail() {
    const confirmed = window.confirm("Disconnect Gmail from Smokescreen?");
    if (!confirmed) {
      return;
    }
    updateMutation.mutate({
      sender_email: "",
      gmail_token_json: "",
      gmail_credentials_json: "",
    });
  }

  function saveAdvanced(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    updateMutation.mutate({
      poll_label: advancedForm.poll_label.trim(),
      max_retries: Number(advancedForm.max_retries),
      rerequest_interval_days: Number(advancedForm.rerequest_interval_days),
      dry_run: advancedForm.dry_run,
      anthropic_model: advancedForm.anthropic_model.trim(),
    });
  }

  return (
    <section className="mx-auto grid max-w-6xl gap-5 px-5 py-6 sm:px-6 lg:px-8">
      {error ? (
        <ErrorState
          description="Smokescreen could not load your settings from the local API. Try refreshing before making changes."
          onAction={retrySettings}
          title="Settings are unavailable"
        />
      ) : null}
      {updateMutation.error ? (
        <ErrorState
          description="Smokescreen could not save those settings. Review the fields and try again."
          onAction={() => updateMutation.reset()}
          title="Settings were not saved"
        />
      ) : null}
      {message ? <SuccessMessage message={message} /> : null}

      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h2 className="text-2xl font-semibold tracking-normal">Settings</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Set up the identity, inbox, and Claude connection Smokescreen uses for opt-out requests.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
              retrySettings();
            }}
        >
          <RefreshCcw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      {settingsLoading ? (
        <LoadingState description="Loading your identity, Gmail, Claude, and advanced settings." title="Loading settings" />
      ) : null}

      {!settingsLoading ? <div className="grid gap-4 lg:grid-cols-2">
        <SettingsCard
          icon={<UserRound className="h-5 w-5" />}
          title="Identity"
          description="The name, email, and document folder used in broker requests."
        >
          <form className="grid gap-4" onSubmit={saveIdentity}>
            <SettingsInput
              label="Sender name"
              value={identityForm.sender_name}
              onChange={(value) => setIdentityForm((current) => ({ ...current, sender_name: value }))}
              placeholder="Jane Doe"
            />
            <SettingsInput
              label="Sender email"
              type="email"
              value={identityForm.sender_email}
              onChange={(value) => setIdentityForm((current) => ({ ...current, sender_email: value }))}
              placeholder="jane@example.com"
            />
            <SettingsInput
              label="Identity documents folder"
              value={identityForm.identity_docs_dir}
              onChange={(value) => setIdentityForm((current) => ({ ...current, identity_docs_dir: value }))}
              placeholder="identity/"
            />
            <Button type="submit" disabled={updateMutation.isPending}>
              <Save className="h-4 w-4" />
              Save identity
            </Button>
          </form>
        </SettingsCard>

        <SettingsCard
          icon={<Mail className="h-5 w-5" />}
          title="Connect Gmail"
          description="Gmail is used to send requests and watch broker replies."
        >
          <div className="grid gap-4">
            <div className="rounded-md border bg-muted/40 p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                {settings?.gmail_connected ? (
                  <CheckCircle2 className="h-4 w-4 text-primary" />
                ) : (
                  <AlertTriangle className="h-4 w-4 text-accent-foreground" />
                )}
                {settings?.gmail_connected ? "Connected" : "Not connected"}
              </div>
              <p className="mt-2 break-words text-sm text-muted-foreground">
                {settings?.gmail_connected
                  ? `Connected as ${settings.gmail_connected_email}`
                  : "Add a sender email to prepare Gmail for Smokescreen."}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" disabled={Boolean(settings?.gmail_connected) || updateMutation.isPending}>
                <Mail className="h-4 w-4" />
                Connect Gmail
              </Button>
              <Button
                variant="outline"
                onClick={disconnectGmail}
                disabled={!settings?.gmail_connected || updateMutation.isPending}
              >
                <RotateCcw className="h-4 w-4" />
                Disconnect
              </Button>
            </div>
          </div>
        </SettingsCard>

        <SettingsCard
          icon={<Brain className="h-5 w-5" />}
          title="Connect Claude"
          description="Claude classifies broker replies and drafts the next response."
        >
          <form className="grid gap-4" onSubmit={saveClaude}>
            <SettingsInput
              label="Anthropic API key"
              type="password"
              value={anthropicApiKey}
              onChange={setAnthropicApiKey}
              placeholder={settings?.anthropic_api_key || "sk-ant-..."}
            />
            <Button type="submit" disabled={!anthropicApiKey.trim() || updateMutation.isPending}>
              <KeyRound className="h-4 w-4" />
              Save Claude key
            </Button>
          </form>
        </SettingsCard>

        <Card className="lg:row-span-2">
          <details>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-5">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
                  <Settings className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <CardTitle className="text-base font-semibold text-foreground">Advanced</CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">Retries, polling, dry run, and Claude model.</p>
                </div>
              </div>
              <ChevronDown className="h-5 w-5 shrink-0 text-muted-foreground" />
            </summary>
            <CardContent className="pt-0">
              <form className="grid gap-4" onSubmit={saveAdvanced}>
                <SettingsInput
                  label="Gmail poll label"
                  value={advancedForm.poll_label}
                  onChange={(value) => setAdvancedForm((current) => ({ ...current, poll_label: value }))}
                  placeholder="smokescreen"
                />
                <div className="grid gap-4 sm:grid-cols-2">
                  <SettingsInput
                    label="Max retries"
                    type="number"
                    min={0}
                    value={advancedForm.max_retries}
                    onChange={(value) => setAdvancedForm((current) => ({ ...current, max_retries: value }))}
                  />
                  <SettingsInput
                    label="Re-request interval"
                    type="number"
                    min={1}
                    value={advancedForm.rerequest_interval_days}
                    onChange={(value) =>
                      setAdvancedForm((current) => ({ ...current, rerequest_interval_days: value }))
                    }
                  />
                </div>
                <SettingsInput
                  label="Anthropic model"
                  value={advancedForm.anthropic_model}
                  onChange={(value) => setAdvancedForm((current) => ({ ...current, anthropic_model: value }))}
                  placeholder="claude-sonnet-4-20250514"
                />
                <label className="flex items-center justify-between gap-4 rounded-md border bg-background p-3 text-sm">
                  <span>
                    <span className="block font-medium">Dry run</span>
                    <span className="block text-muted-foreground">Prepare work without sending email.</span>
                  </span>
                  <input
                    type="checkbox"
                    className="h-5 w-5 rounded border-input accent-primary"
                    checked={advancedForm.dry_run}
                    onChange={(event) =>
                      setAdvancedForm((current) => ({ ...current, dry_run: event.currentTarget.checked }))
                    }
                  />
                </label>
                <Button type="submit" disabled={updateMutation.isPending}>
                  <Save className="h-4 w-4" />
                  Save advanced
                </Button>
              </form>
            </CardContent>
          </details>
        </Card>
      </div> : null}
    </section>
  );
}

function SettingsCard({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="items-start pb-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
            {icon}
          </div>
          <div className="min-w-0">
            <CardTitle className="text-base font-semibold text-foreground">{title}</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          </div>
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function SettingsInput({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  min,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "email" | "number" | "password" | "text";
  placeholder?: string;
  min?: number;
}) {
  const id = useId();

  return (
    <label className="grid gap-2 text-sm font-medium" htmlFor={id}>
      {label}
      <input
        id={id}
        className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        min={min}
        placeholder={placeholder}
        type={type}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );
}

function SuccessMessage({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary">
      <Check className="h-4 w-4" />
      {message}
    </div>
  );
}

export function TrustedSendersPage() {
  const queryClient = useQueryClient();
  const whitelistQuery = useWhitelist();
  const pendingQuery = usePendingWhitelist();
  const [brokerId, setBrokerId] = useState("");
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
      setBrokerId("");
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
    const trimmedBrokerId = brokerId.trim();
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
  }

  const loadError = whitelistQuery.error ?? pendingQuery.error;
  const mutationError = addMutation.error ?? deleteMutation.error ?? approveMutation.error ?? rejectMutation.error;
  const loading = whitelistQuery.isLoading || pendingQuery.isLoading;
  const retryTrustedSenders = () => {
    void whitelistQuery.refetch();
    void pendingQuery.refetch();
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
              Broker ID
              <input
                className="h-10 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={brokerId}
                onChange={(event) => setBrokerId(event.target.value)}
                placeholder="spokeo"
                autoComplete="off"
              />
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
              disabled={addMutation.isPending || !brokerId.trim() || !email.trim()}
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
                    <td className="px-4 py-3 text-muted-foreground">{entry.broker_id}</td>
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
}: {
  entry: PendingWhitelistEntry;
  isApproving: boolean;
  isRejecting: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className="rounded-md border bg-background p-4">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="break-words text-sm font-semibold">{entry.email}</p>
            <Badge variant="outline">{entry.broker_id ?? "Unknown broker"}</Badge>
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
  const manualQuery = useOptOuts("NEEDS_MANUAL");
  const records = manualQuery.data ?? [];
  const resetMutation = useMutation({
    mutationFn: api.resetOptOut,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["opt-outs"] }),
        queryClient.invalidateQueries({ queryKey: ["extended-stats"] }),
      ]);
    },
  });
  const retryManual = () => {
    void manualQuery.refetch();
  };

  function resetRecord(record: OptOutRecord) {
    const confirmed = window.confirm(`Reset ${record.broker_name} to pending so Smokescreen can try again?`);
    if (confirmed) {
      resetMutation.mutate(record.broker_id);
    }
  }

  return (
    <section className="mx-auto grid max-w-6xl gap-5 px-5 py-6 sm:px-6 lg:px-8">
      {manualQuery.error ? (
        <ErrorState
          description="Smokescreen could not load broker replies that need review. Refresh after checking the local API."
          onAction={retryManual}
          title="Needs-attention items are unavailable"
        />
      ) : null}
      {resetMutation.error ? (
        <ErrorState
          description="Smokescreen could not reset that broker. Refresh the page before trying again."
          onAction={retryManual}
          title="Broker was not reset"
        />
      ) : null}

      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h2 className="text-2xl font-semibold tracking-normal">Needs Attention</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Broker replies appear here only when Smokescreen needs you to review the message or take the next step.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            retryManual();
          }}
        >
          <RefreshCcw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      {manualQuery.isLoading ? (
        <LoadingState description="Checking for broker replies that need your review." title="Loading review queue" />
      ) : null}
      {!manualQuery.isLoading && records.length === 0 ? <EmptyAttentionState /> : null}

      <div className="grid gap-4">
        {records.map((record) => (
          <AttentionItem
            key={record.broker_id}
            record={record}
            isResetting={resetMutation.isPending && resetMutation.variables === record.broker_id}
            onReset={() => resetRecord(record)}
          />
        ))}
      </div>
    </section>
  );
}

function AttentionItem({
  record,
  isResetting,
  onReset,
}: {
  record: OptOutRecord;
  isResetting: boolean;
  onReset: () => void;
}) {
  return (
    <Card>
      <CardHeader className="items-start pb-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base font-semibold text-foreground">{record.broker_name}</CardTitle>
            <Badge variant="destructive">{brokerStatusCopy[record.status].label}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {record.broker_domain || "Unknown domain"} - {record.broker_privacy_email || "No privacy email listed"}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onReset} disabled={isResetting}>
          <RotateCcw className="h-4 w-4" />
          {isResetting ? "Resetting" : "Reset to pending"}
        </Button>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <AttentionFact icon={<Clock3 className="h-4 w-4" />} label="Last updated" value={formatUpdatedAt(record.updated_at)} />
          <AttentionFact icon={<Inbox className="h-4 w-4" />} label="Thread" value={record.thread_id ?? "Not linked"} />
        </div>

        <div className="rounded-md border bg-muted/40 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <MessageSquareWarning className="h-4 w-4 text-destructive" />
            Broker reply
          </div>
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6 text-foreground">
            {record.notes.trim() || "Smokescreen marked this broker for manual review, but no reply details were saved."}
          </pre>
        </div>
      </CardContent>
    </Card>
  );
}

function AttentionFact({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background p-3">
      <div className="flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
        {icon}
        {label}
      </div>
      <p className="mt-2 break-words text-sm font-medium">{value}</p>
    </div>
  );
}

function EmptyAttentionState() {
  return (
    <EmptyState
      description="Smokescreen is handling replies on its own. If a broker sends something confusing or asks you to step in, it will show up here."
      icon={<CheckCircle2 className="h-5 w-5" />}
      title="Nothing needs your attention"
    />
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
