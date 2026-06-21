import { Activity, AlertTriangle, CheckCircle2, Database, ExternalLink, RefreshCcw } from "lucide-react";

import { useExtendedStats, useOptOuts } from "./lib/queries";
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

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
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

export function App() {
  const statsQuery = useExtendedStats();
  const optOutsQuery = useOptOuts();
  const stats = statsQuery.data;
  const optOuts = optOutsQuery.data ?? [];
  const loading = statsQuery.isLoading || optOutsQuery.isLoading;
  const error = statsQuery.error ?? optOutsQuery.error;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="border-b bg-card">
        <div className="mx-auto flex max-w-6xl flex-col gap-5 px-5 py-8 sm:px-6 lg:px-8">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <div>
              <p className="text-sm font-medium text-muted-foreground">Smokescreen</p>
              <h1 className="mt-1 text-3xl font-semibold tracking-normal">Privacy opt-out control center</h1>
            </div>
            <Button asChild variant="outline" size="sm">
              <a href="/old-dashboard">
                <ExternalLink className="h-4 w-4" />
                Old dashboard
              </a>
            </Button>
          </div>
          {error ? (
            <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4" />
              API unavailable: {error.message}
            </div>
          ) : null}
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-5 px-5 py-6 sm:px-6 lg:px-8">
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
                      <td className="px-4 py-3 text-muted-foreground">
                        {new Date(record.updated_at).toLocaleString()}
                      </td>
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
    </main>
  );
}
