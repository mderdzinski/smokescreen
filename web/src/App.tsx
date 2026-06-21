import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Database,
  ExternalLink,
  Inbox,
  MessageSquareWarning,
  RefreshCcw,
  RotateCcw,
} from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";

import { api, type BrokerStatus, type OptOutRecord } from "./lib/api";
import { useExtendedStats, useOptOuts } from "./lib/queries";
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

function ApiError({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <AlertTriangle className="h-4 w-4" />
      API unavailable: {message}
    </div>
  );
}
