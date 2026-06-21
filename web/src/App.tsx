import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Database,
  ExternalLink,
  Inbox,
  KeyRound,
  Mail,
  MessageSquareWarning,
  RefreshCcw,
  RotateCcw,
  Save,
  Settings,
  UserRound,
} from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";

import { api, type AdvancedSettings, type BrokerStatus, type FriendlySettings, type OptOutRecord } from "./lib/api";
import { useAdvancedSettings, useExtendedStats, useOptOuts, useSettings } from "./lib/queries";
import { cn } from "./lib/utils";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";

function formatStatus(status: string): string {
  return status
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function statusVariant(status: BrokerStatus): "default" | "secondary" | "destructive" | "outline" {
  if (status === "COMPLETED") {
    return "default";
  }
  if (status === "FAILED" || status === "NEEDS_MANUAL") {
    return "destructive";
  }
  if (status === "PENDING") {
    return "outline";
  }
  return "secondary";
}

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
              <h1 className="mt-1 text-3xl font-semibold tracking-normal">Privacy opt-out control center</h1>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <nav className="flex items-center gap-1 rounded-md border bg-background p-1">
                <AppNavLink to="/">Overview</AppNavLink>
                <AppNavLink to="/needs-attention">Needs Attention</AppNavLink>
                <AppNavLink to="/brokers">Brokers</AppNavLink>
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

  return (
    <section className="mx-auto grid max-w-6xl gap-5 px-5 py-6 sm:px-6 lg:px-8">
      {error ? <ApiError message={error.message} /> : null}

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle>Total brokers</CardTitle>
            <Database className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{loading ? "--" : stats?.total ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Completed</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{loading ? "--" : stats?.completed_count ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Success rate</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{loading ? "--" : `${stats?.success_rate ?? 0}%`}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Needs attention</CardTitle>
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{loading ? "--" : stats?.needs_attention ?? 0}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="items-start sm:items-center">
          <div>
            <CardTitle>Broker status</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">Live data from the existing FastAPI JSON endpoints.</p>
          </div>
          <Button
            variant="outline"
            size="icon"
            aria-label="Refresh broker data"
            onClick={() => {
              void statsQuery.refetch();
              void optOutsQuery.refetch();
            }}
          >
            <RefreshCcw className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden rounded-md border">
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <thead className="bg-muted/70 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Broker</th>
                  <th className="px-4 py-3 font-medium">Domain</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Retries</th>
                  <th className="px-4 py-3 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody>
                {optOuts.map((record) => (
                  <tr key={record.broker_id} className="border-t">
                    <td className="px-4 py-3 font-medium">{record.broker_name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{record.broker_domain || "Unknown"}</td>
                    <td className="px-4 py-3">
                      <Badge variant={statusVariant(record.status)}>{formatStatus(record.status)}</Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{record.retries}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatUpdatedAt(record.updated_at)}</td>
                  </tr>
                ))}
                {!loading && optOuts.length === 0 ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-muted-foreground" colSpan={5}>
                      No opt-out records yet.
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
      {error ? <ApiError message={error.message} /> : null}
      {updateMutation.error ? <ApiError message={updateMutation.error.message} /> : null}
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
            void settingsQuery.refetch();
            void advancedQuery.refetch();
          }}
        >
          <RefreshCcw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
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
      </div>
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

  function resetRecord(record: OptOutRecord) {
    const confirmed = window.confirm(`Reset ${record.broker_name} to pending so Smokescreen can try again?`);
    if (confirmed) {
      resetMutation.mutate(record.broker_id);
    }
  }

  return (
    <section className="mx-auto grid max-w-6xl gap-5 px-5 py-6 sm:px-6 lg:px-8">
      {manualQuery.error ? <ApiError message={manualQuery.error.message} /> : null}
      {resetMutation.error ? <ApiError message={resetMutation.error.message} /> : null}

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
            void manualQuery.refetch();
          }}
        >
          <RefreshCcw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

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
            <Badge variant="destructive">{formatStatus(record.status)}</Badge>
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
        <div className="grid gap-3 sm:grid-cols-3">
          <AttentionFact icon={<Clock3 className="h-4 w-4" />} label="Last updated" value={formatUpdatedAt(record.updated_at)} />
          <AttentionFact icon={<RefreshCcw className="h-4 w-4" />} label="Retries" value={String(record.retries)} />
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
    <div className="rounded-md border bg-card px-6 py-12 text-center">
      <CheckCircle2 className="mx-auto h-10 w-10 text-primary" />
      <h2 className="mt-4 text-xl font-semibold tracking-normal">Nothing needs your attention</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        Smokescreen is handling replies on its own. If a broker sends something confusing or asks you to step in, it will
        show up here.
      </p>
    </div>
  );
}

export function ApiError({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <AlertTriangle className="h-4 w-4" />
      API unavailable: {message}
    </div>
  );
}
