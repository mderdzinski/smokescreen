import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { FormEvent, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Ban, CheckCheck, Plus, RotateCcw, Search, Send, Trash2 } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { api, type Broker, type BrokerInput } from "../lib/api";
import { useBrokerSelections, useBrokers, useOptOuts } from "../lib/queries";
import { cn } from "../lib/utils";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ThrowOverlay } from "../components/ui/motion";
import { StatusPill } from "../components/ui/status-pill";
import { Switch } from "../components/ui/switch";
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
const RESET_CONFIRMATION_WINDOW_MS = 3000;
const SEARCH_DEBOUNCE_MS = 200;

function brokerMatchesSearch(broker: Broker, query: string): boolean {
  const text = [broker.name, broker.id, broker.domain, broker.privacy_email].join(" ").toLowerCase();
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

function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

export function BrokerRegistryPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const brokersQuery = useBrokers();
  const selectionsQuery = useBrokerSelections();
  const optOutsQuery = useOptOuts();
  const brokers = brokersQuery.data ?? [];
  const optOutRecordsByBrokerId = useMemo(
    () => new Map((optOutsQuery.data ?? []).map((record) => [record.broker_id, record])),
    [optOutsQuery.data],
  );
  const enabledBrokerIdList = selectionsQuery.data?.enabled_broker_ids ?? [];
  const enabledBrokerIds = useMemo(() => new Set(enabledBrokerIdList), [enabledBrokerIdList]);
  const enabledBrokers = useMemo(
    () => brokers.filter((broker) => enabledBrokerIds.has(broker.id)),
    [brokers, enabledBrokerIds],
  );
  const enabledBrokerCount = enabledBrokers.length;
  const showNoBrokersEnabled = brokersQuery.isSuccess && selectionsQuery.isSuccess && enabledBrokerCount === 0;
  const [throwOverlayOpen, setThrowOverlayOpen] = useState(false);
  const [throwOverlayCount, setThrowOverlayCount] = useState(0);
  const [throwOverlayResolved, setThrowOverlayResolved] = useState(false);
  const [confirmingResetBrokerId, setConfirmingResetBrokerId] = useState<string | null>(null);
  const [resetAllDialogOpen, setResetAllDialogOpen] = useState(false);

  useEffect(() => {
    if (!confirmingResetBrokerId) {
      return undefined;
    }

    const timer = window.setTimeout(() => setConfirmingResetBrokerId(null), RESET_CONFIRMATION_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, [confirmingResetBrokerId]);

  const putSelectionsMutation = useMutation({
    mutationFn: api.putBrokerSelections,
    onSuccess: (result) => {
      queryClient.setQueryData(["broker-selections"], result);
    },
  });

  function toggleEnabled(brokerId: string) {
    const current = selectionsQuery.data?.enabled_broker_ids ?? [];
    const next = current.includes(brokerId)
      ? current.filter((id) => id !== brokerId)
      : [...current, brokerId];
    putSelectionsMutation.mutate(next);
  }

  function enableVisibleBrokers() {
    const next = Array.from(new Set([...enabledBrokerIdList, ...visibleBrokerIds]));
    putSelectionsMutation.mutate(next);
  }

  function disableVisibleBrokers() {
    const visibleIds = new Set(visibleBrokerIds);
    const next = enabledBrokerIdList.filter((brokerId) => !visibleIds.has(brokerId));
    putSelectionsMutation.mutate(next);
  }

  const runOutreachMutation = useMutation({
    mutationFn: api.runOutreach,
    onSuccess: async () => {
      setThrowOverlayResolved(true);
      await invalidateRelatedData();
    },
    onError: () => {
      setThrowOverlayOpen(false);
      setThrowOverlayResolved(false);
    },
  });

  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const activeSearch = debouncedSearch.trim();
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
    () => orderedBrokers.filter((broker) => brokerMatchesSearch(broker, activeSearch)),
    [orderedBrokers, activeSearch],
  );
  const visibleBrokerIds = useMemo(() => filteredBrokers.map((broker) => broker.id), [filteredBrokers]);
  const visibleResettableBrokerIds = useMemo(
    () =>
      filteredBrokers
        .filter((broker) => enabledBrokerIds.has(broker.id) && optOutRecordsByBrokerId.has(broker.id))
        .map((broker) => broker.id),
    [enabledBrokerIds, filteredBrokers, optOutRecordsByBrokerId],
  );
  const visibleBrokerCount = filteredBrokers.length;
  const searchActive = activeSearch.length > 0;
  const filterSummary = searchActive ? `${visibleBrokerCount} of ${brokers.length} matches` : null;

  const invalidateRelatedData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["opt-outs"] }),
      queryClient.invalidateQueries({ queryKey: ["extended-stats"] }),
    ]);
  };

  const refreshAfterReset = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["brokers"] }),
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

  const resetMutation = useMutation({
    mutationFn: api.resetOptOut,
    onSuccess: refreshAfterReset,
  });

  const resetAllMutation = useMutation({
    mutationFn: async (brokerIds: string[]) => {
      await Promise.all(brokerIds.map((brokerId) => api.resetOptOut(brokerId)));
    },
    onSuccess: async () => {
      setResetAllDialogOpen(false);
      await refreshAfterReset();
    },
  });

  const activeError =
    brokersQuery.error?.message ??
    selectionsQuery.error?.message ??
    optOutsQuery.error?.message ??
    putSelectionsMutation.error?.message ??
    createMutation.error?.message ??
    deleteMutation.error?.message ??
    resetAllMutation.error?.message;
  const selectionSizeWarning = selectionsQuery.data?.selection_size_warning;
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

  function resetBroker(brokerId: string) {
    if (resetMutation.isPending || resetAllMutation.isPending) {
      return;
    }
    if (!enabledBrokerIds.has(brokerId)) {
      return;
    }

    if (confirmingResetBrokerId === brokerId) {
      setConfirmingResetBrokerId(null);
      resetMutation.mutate(brokerId);
      return;
    }

    resetMutation.reset();
    setConfirmingResetBrokerId(brokerId);
  }

  function openResetAllDialog() {
    if (visibleResettableBrokerIds.length === 0 || resetAllMutation.isPending) {
      return;
    }
    resetAllMutation.reset();
    setResetAllDialogOpen(true);
  }

  function confirmResetAll() {
    if (visibleResettableBrokerIds.length === 0 || resetAllMutation.isPending) {
      return;
    }
    resetAllMutation.mutate(visibleResettableBrokerIds);
  }

  function closeThrowOverlay() {
    setThrowOverlayOpen(false);
  }

  function viewStatusFromOverlay() {
    closeThrowOverlay();
    navigate("/");
  }

  function runOutreach() {
    const brokerIds = enabledBrokers.map((broker) => broker.id);

    if (brokerIds.length === 0 || runOutreachMutation.isPending) {
      return;
    }

    setThrowOverlayCount(brokerIds.length);
    setThrowOverlayResolved(false);
    setThrowOverlayOpen(true);
    runOutreachMutation.mutate(brokerIds);
  }

  return (
    <section className="mx-auto grid max-w-container gap-[18px] px-5 py-6 sm:px-6 lg:px-8">
      {throwOverlayOpen ? (
        <ThrowOverlay
          count={throwOverlayCount}
          resolveWhen={throwOverlayResolved}
          onClose={closeThrowOverlay}
          onViewStatus={viewStatusFromOverlay}
        />
      ) : null}
      {resetAllDialogOpen ? (
        <div
          aria-labelledby="reset-all-title"
          aria-modal="true"
          className="fixed inset-0 z-50 grid place-items-center bg-black/45 px-4 py-6"
          role="dialog"
        >
          <div className="w-full max-w-[480px] rounded-md border border-border bg-surface-card p-5 shadow-xl">
            <h2 className="font-display text-lg font-semibold text-content-strong" id="reset-all-title">
              Reset {visibleResettableBrokerIds.length} brokers?
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-content-body">
              This will reset opt-out records for {visibleResettableBrokerIds.length} brokers back to PENDING.
              Active outreach and completion state will be lost. Continue?
            </p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button
                disabled={resetAllMutation.isPending}
                onClick={() => setResetAllDialogOpen(false)}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
              <Button
                disabled={resetAllMutation.isPending}
                onClick={confirmResetAll}
                type="button"
                variant="danger"
              >
                <RotateCcw />
                {resetAllMutation.isPending ? "Resetting" : "Confirm reset"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-content-strong">
            Broker Registry
          </h1>
          <p className="mt-1 max-w-[52ch] text-sm text-content-muted">
            The data brokers Smokescreen contacts. Add the companies holding your records.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-[10px]">
          <Badge dot variant={enabledBrokerCount > 0 ? "olive" : "neutral"}>
            {enabledBrokerCount} of {brokers.length} enabled
          </Badge>
          <Button
            disabled={enabledBrokerCount === 0 || runOutreachMutation.isPending}
            onClick={runOutreach}
            type="button"
            variant="accent"
          >
            <Send />
            {runOutreachMutation.isPending ? "Running" : "Run outreach"}
          </Button>
        </div>
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
      {runOutreachMutation.error ? (
        <ErrorState
          description={
            runOutreachMutation.error.message ||
            "Smokescreen could not start outreach. Check Gmail or dry-run settings before trying again."
          }
          onAction={() => runOutreachMutation.reset()}
          title="Outreach did not start"
        />
      ) : null}
      {resetMutation.error ? (
        <ErrorState
          description={resetMutation.error.message || "Smokescreen could not reset that broker."}
          onAction={() => resetMutation.reset()}
          title="Request was not reset"
        />
      ) : null}
      {selectionSizeWarning ? (
        <div
          className="flex items-start gap-3 rounded-sm border border-bd-amber border-l-2 border-l-accent bg-fill-amber px-4 py-[14px]"
          data-testid="broker-selection-size-warning"
        >
          <AlertTriangle
            aria-hidden="true"
            className="mt-px h-[18px] w-[18px] flex-none text-soft-amber"
          />
          <div>
            <div className="font-display text-sm font-semibold text-content-strong">
              Broker selection storage is getting large
            </div>
            <p className="mt-[3px] max-w-[64ch] text-sm leading-normal text-content-body">
              {selectionSizeWarning}
            </p>
          </div>
        </div>
      ) : null}
      {showNoBrokersEnabled ? (
        <div
          className="flex items-start gap-3 rounded-sm border border-bd-rust border-l-2 border-l-rust-500 bg-fill-rust px-4 py-[14px]"
          data-testid="brokers-no-enabled-warning"
        >
          <AlertTriangle
            aria-hidden="true"
            className="mt-px h-[18px] w-[18px] flex-none text-soft-rust"
          />
          <div>
            <div className="font-display text-sm font-semibold text-content-strong">
              No brokers enabled — outreach won't run
            </div>
            <p className="mt-[3px] max-w-[64ch] text-sm leading-normal text-content-body">
              Scheduled outreach only contacts brokers you've switched on below. Enable at least one to let
              Smokescreen send opt-out requests.
            </p>
          </div>
        </div>
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
        <div className="grid gap-3 border-b border-border px-[14px] py-3">
          <div className="flex items-center gap-2">
            <Search className="h-[15px] w-[15px] text-content-faint" />
            <input
              aria-label="Search brokers"
              className="min-w-0 flex-1 bg-transparent font-body text-sm text-content-strong outline-none placeholder:text-content-faint"
              onChange={(event) => setSearch(event.currentTarget.value)}
              placeholder="Search by broker, id, email, or domain"
              type="search"
              value={search}
            />
            {filterSummary ? (
              <span className="shrink-0 font-mono text-2xs font-semibold uppercase tracking-label text-content-muted">
                {filterSummary}
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono text-2xs font-semibold uppercase tracking-label text-content-faint">
              {searchActive ? "Bulk actions apply to visible matches" : "Bulk actions apply to all brokers"}
            </span>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={visibleBrokerCount === 0 || putSelectionsMutation.isPending}
                onClick={enableVisibleBrokers}
                size="sm"
                type="button"
                variant="outline"
              >
                <CheckCheck />
                Enable all
              </Button>
              <Button
                disabled={visibleBrokerCount === 0 || putSelectionsMutation.isPending}
                onClick={disableVisibleBrokers}
                size="sm"
                type="button"
                variant="outline"
              >
                <Ban />
                Disable all
              </Button>
              <Button
                disabled={visibleResettableBrokerIds.length === 0 || resetAllMutation.isPending}
                onClick={openResetAllDialog}
                size="sm"
                type="button"
                variant="danger"
              >
                <RotateCcw />
                Reset all
              </Button>
            </div>
          </div>
        </div>

        {brokersQuery.isLoading ? (
          <LoadingState
            className="m-5 shadow-none"
            description="Loading brokers and privacy contact details."
            title="Loading brokers"
          />
        ) : (
          <div className="max-h-[640px] overflow-auto">
            <table className="w-full min-w-[860px] border-collapse" aria-label="Broker registry">
              <thead className="sticky top-0 z-10 bg-surface-sunken">
                <tr>
                  <TableHeader>Broker</TableHeader>
                  <TableHeader>Privacy contact</TableHeader>
                  <TableHeader>Aliases</TableHeader>
                  <TableHeader>Outreach</TableHeader>
                  <TableHeader>Status</TableHeader>
                  <TableHeader className="text-right">Actions</TableHeader>
                </tr>
              </thead>
              <tbody>
                {filteredBrokers.map((broker) => {
                  const enabled = enabledBrokerIds.has(broker.id);
                  const optOutRecord = optOutRecordsByBrokerId.get(broker.id);
                  const pending =
                    putSelectionsMutation.isPending &&
                    putSelectionsMutation.variables?.includes(broker.id) !== enabled;
                  const resetPending = resetMutation.isPending && resetMutation.variables === broker.id;
                  const bulkResetPending =
                    resetAllMutation.isPending && resetAllMutation.variables?.includes(broker.id);
                  const resetConfirming = confirmingResetBrokerId === broker.id;
                  return (
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
                      <TableCell>
                        <span className="inline-flex items-center gap-[9px]">
                          <Switch
                            aria-label={
                              enabled
                                ? `Disable outreach for ${broker.name}`
                                : `Enable outreach for ${broker.name}`
                            }
                            checked={enabled}
                            data-testid={`broker-enabled-toggle-${broker.id}`}
                            disabled={pending}
                            onChange={() => toggleEnabled(broker.id)}
                          />
                          <span
                            className={cn(
                              "font-mono text-2xs font-semibold uppercase tracking-label",
                              enabled ? "text-brand-strong" : "text-content-faint",
                            )}
                          >
                            {enabled ? "On" : "Off"}
                          </span>
                        </span>
                      </TableCell>
                      <TableCell>
                        {optOutRecord ? (
                          <StatusPill status={optOutRecord.status} />
                        ) : (
                          <span className="text-content-faint">No record</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          {optOutRecord && enabled ? (
                            <Button
                              aria-label={
                                resetPending || bulkResetPending
                                  ? `Resetting opt-out for ${broker.name}`
                                  : resetConfirming
                                    ? `Confirm reset for ${broker.name}`
                                    : `Reset opt-out for ${broker.name}`
                              }
                              className="min-w-[128px]"
                              disabled={resetMutation.isPending || resetAllMutation.isPending}
                              onClick={() => resetBroker(broker.id)}
                              size="sm"
                              type="button"
                              variant={resetConfirming ? "danger" : "outline"}
                            >
                              <RotateCcw />
                              {resetPending || bulkResetPending
                                ? "Resetting"
                                : resetConfirming
                                  ? "Confirm reset?"
                                  : "Reset"}
                            </Button>
                          ) : null}
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
                        </div>
                      </TableCell>
                    </tr>
                  );
                })}
                {filteredBrokers.length === 0 ? (
                  <tr>
                    <TableCell className="text-center text-content-muted" colSpan={6}>
                      {searchActive ? "No brokers match that search." : "No brokers found."}
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
