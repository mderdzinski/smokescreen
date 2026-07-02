import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { FormEvent, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { useEffect, useMemo, useState } from "react";
import { Plus, Search, Trash2 } from "lucide-react";

import { api, type Broker, type BrokerInput } from "../lib/api";
import { useBrokers } from "../lib/queries";
import { cn } from "../lib/utils";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { TextField } from "../components/ui/text-field";
import { ErrorState, LoadingState } from "../components/status-state";

interface BrokerFormState {
  name: string;
  domain: string;
}

const emptyBrokerForm: BrokerFormState = {
  name: "",
  domain: "",
};

function brokerMatchesSearch(broker: Broker, query: string): boolean {
  const text = [broker.name, broker.domain, broker.privacy_email].join(" ").toLowerCase();
  return text.includes(query.toLowerCase());
}

function privacyEmailForDomain(domain: string): string {
  return `privacy@${domain}`;
}

function formToBrokerInput(form: BrokerFormState): BrokerInput {
  const domain = form.domain.trim().toLowerCase();

  return {
    name: form.name.trim(),
    domain,
    privacy_email: privacyEmailForDomain(domain),
    aliases: [],
    notes: "",
  };
}

function prependBroker(current: Broker[] | undefined, broker: Broker): Broker[] {
  const rows = current ?? [];
  return [broker, ...rows.filter((row) => row.id !== broker.id)];
}

function removeBroker(current: Broker[] | undefined, brokerId: string): Broker[] {
  return (current ?? []).filter((broker) => broker.id !== brokerId);
}

export function BrokerRegistryPage() {
  const queryClient = useQueryClient();
  const brokersQuery = useBrokers();
  const brokers = brokersQuery.data ?? [];
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<BrokerFormState>(emptyBrokerForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [justAddedId, setJustAddedId] = useState<string | null>(null);
  const [recentlyAddedIds, setRecentlyAddedIds] = useState<string[]>([]);

  useEffect(() => {
    if (!justAddedId) {
      return undefined;
    }

    const timer = window.setTimeout(() => setJustAddedId(null), 260);
    return () => window.clearTimeout(timer);
  }, [justAddedId]);

  const orderedBrokers = useMemo(() => {
    if (recentlyAddedIds.length === 0) {
      return brokers;
    }

    const byId = new Map(brokers.map((broker) => [broker.id, broker]));
    const pinned = recentlyAddedIds
      .map((brokerId) => byId.get(brokerId))
      .filter((broker): broker is Broker => Boolean(broker));
    const pinnedIds = new Set(pinned.map((broker) => broker.id));
    return [...pinned, ...brokers.filter((broker) => !pinnedIds.has(broker.id))];
  }, [brokers, recentlyAddedIds]);

  const filteredBrokers = useMemo(
    () => orderedBrokers.filter((broker) => brokerMatchesSearch(broker, search)),
    [orderedBrokers, search],
  );

  const invalidateRelatedData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["opt-outs"] }),
      queryClient.invalidateQueries({ queryKey: ["extended-stats"] }),
    ]);
  };

  const createMutation = useMutation({
    mutationFn: api.createBroker,
    onSuccess: async (createdBroker) => {
      queryClient.setQueryData<Broker[]>(["brokers"], (current) => prependBroker(current, createdBroker));
      setRecentlyAddedIds((current) => [createdBroker.id, ...current.filter((id) => id !== createdBroker.id)]);
      setJustAddedId(createdBroker.id);
      setForm(emptyBrokerForm);
      setFormError(null);
      await invalidateRelatedData();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteBroker,
    onSuccess: async (_result, brokerId) => {
      queryClient.setQueryData<Broker[]>(["brokers"], (current) => removeBroker(current, brokerId));
      setRecentlyAddedIds((current) => current.filter((id) => id !== brokerId));
      await invalidateRelatedData();
    },
  });

  const activeError = brokersQuery.error?.message ?? createMutation.error?.message ?? deleteMutation.error?.message;
  const brokerNameError = formError && !form.name.trim();
  const domainError = formError && !form.domain.trim();

  function updateFormField(field: keyof BrokerFormState, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
    setFormError(null);
  }

  function submitBroker(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = formToBrokerInput(form);

    if (!input.name || !input.domain) {
      setFormError("Broker name and domain are required.");
      return;
    }

    createMutation.mutate(input);
  }

  function deleteBroker(brokerId: string) {
    deleteMutation.mutate(brokerId);
  }

  return (
    <section className="mx-auto grid max-w-container gap-[18px] px-5 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-content-strong">
            Broker Registry
          </h1>
          <p className="mt-1 max-w-[52ch] text-sm text-content-muted">
            The data brokers Smokescreen contacts. Add the companies holding your records.
          </p>
        </div>
        <Badge variant="olive">{brokers.length} brokers</Badge>
      </div>

      {activeError ? (
        <ErrorState
          description={
            "Smokescreen could not load or update the broker registry. Refresh the list before trying again."
          }
          onAction={() => void brokersQuery.refetch()}
          title="Broker registry is unavailable"
        />
      ) : null}

      <Card pad>
        <form className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end" onSubmit={submitBroker}>
          <TextField
            error={Boolean(brokerNameError)}
            hint={brokerNameError ? formError : undefined}
            label="Broker name"
            onChange={(event) => updateFormField("name", event.currentTarget.value)}
            placeholder="Acme Data Co"
            value={form.name}
          />
          <TextField
            error={Boolean(domainError)}
            hint={domainError ? formError : undefined}
            label="Domain"
            onChange={(event) => updateFormField("domain", event.currentTarget.value)}
            placeholder="acmedata.com"
            value={form.domain}
          />
          <Button className="md:self-end" disabled={createMutation.isPending} type="submit">
            <Plus />
            {createMutation.isPending ? "Adding" : "Add broker"}
          </Button>
        </form>
      </Card>

      <Card className="overflow-hidden" variant="flat">
        <div className="flex items-center gap-2 border-b border-border px-[14px] py-3">
          <Search className="h-[15px] w-[15px] text-content-faint" />
          <input
            aria-label="Search brokers"
            className="min-w-0 flex-1 bg-transparent font-body text-sm text-content-strong outline-none placeholder:text-content-faint"
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder="Search brokers"
            type="search"
            value={search}
          />
        </div>

        {brokersQuery.isLoading ? (
          <LoadingState
            className="m-5 shadow-none"
            description="Loading brokers and privacy contact details."
            title="Loading brokers"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse" aria-label="Broker registry">
              <thead className="bg-surface-sunken">
                <tr>
                  <TableHeader>Broker</TableHeader>
                  <TableHeader>Privacy contact</TableHeader>
                  <TableHeader>Aliases</TableHeader>
                  <TableHeader className="text-right">Actions</TableHeader>
                </tr>
              </thead>
              <tbody>
                {filteredBrokers.map((broker) => (
                  <tr key={broker.id} className={cn(broker.id === justAddedId && "ss-rowin")}>
                    <TableCell>
                      <div className="font-semibold text-content-strong">{broker.name}</div>
                      <div className="break-all font-mono text-xs text-content-muted">{broker.domain}</div>
                    </TableCell>
                    <TableCell className="break-all font-mono text-xs text-content-muted">
                      {broker.privacy_email}
                    </TableCell>
                    <TableCell>
                      {broker.aliases.length > 0 ? (
                        <span className="inline-flex flex-wrap gap-[5px]">
                          {broker.aliases.map((alias) => (
                            <Badge key={alias} variant="outline">
                              {alias}
                            </Badge>
                          ))}
                        </span>
                      ) : (
                        <span className="text-content-faint">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        aria-label={`Delete ${broker.name}`}
                        disabled={deleteMutation.isPending && deleteMutation.variables === broker.id}
                        iconOnly
                        onClick={() => deleteBroker(broker.id)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        <Trash2 />
                      </Button>
                    </TableCell>
                  </tr>
                ))}
                {filteredBrokers.length === 0 ? (
                  <tr>
                    <TableCell className="text-center text-content-muted" colSpan={4}>
                      No brokers found.
                    </TableCell>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </section>
  );
}

function TableHeader({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        "px-[14px] py-[10px] text-left font-mono text-2xs font-semibold uppercase tracking-label text-content-muted",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      className={cn("border-t border-border px-[14px] py-[11px] text-sm text-content-body", className)}
      {...props}
    />
  );
}
