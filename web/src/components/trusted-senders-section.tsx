import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { AlertTriangle, CheckCircle2, Mail, ShieldCheck, ShieldPlus, Trash2, UserCheck, XCircle } from "lucide-react";

import { api, type Broker, type PendingWhitelistEntry, type WhitelistEntry } from "../lib/api";
import { useBrokers, usePendingWhitelist, useWhitelist } from "../lib/queries";
import { cn } from "../lib/utils";
import { EmptyState, ErrorState, LoadingState } from "./status-state";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { TextField } from "./ui/text-field";

interface TrustedSendersSectionProps {
  onPendingChange?: (count: number) => void;
}

export function TrustedSendersSection({ onPendingChange }: TrustedSendersSectionProps) {
  const queryClient = useQueryClient();
  const whitelistQuery = useWhitelist();
  const pendingQuery = usePendingWhitelist();
  const brokersQuery = useBrokers();
  const brokers = brokersQuery.data ?? [];
  const brokerById = useMemo(() => new Map(brokers.map((broker) => [broker.id, broker])), [brokers]);
  const [selectedBrokerId, setSelectedBrokerId] = useState("");
  const [email, setEmail] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [confirmingRemovalId, setConfirmingRemovalId] = useState<number | null>(null);
  const trustedSenders = useMemo(
    () => [...(whitelistQuery.data ?? [])].sort((a, b) => a.email.localeCompare(b.email)),
    [whitelistQuery.data],
  );
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search);
    }, 200);

    return () => window.clearTimeout(timer);
  }, [search]);
  const manualCount = trustedSenders.filter((entry) => entry.source === "manual").length;
  const registryCount = trustedSenders.length - manualCount;
  const pendingSenders = pendingQuery.data ?? [];
  const trustedSendersQuery = debouncedSearch.trim().toLowerCase();
  const filteredTrustedSenders = useMemo(() => {
    if (!trustedSendersQuery) {
      return trustedSenders;
    }

    return trustedSenders.filter((entry) => {
      const broker = brokerById.get(entry.broker_id ?? "") ?? null;
      const haystack = [entry.email, entry.broker_id ?? "", broker?.name ?? ""].join(" ").toLowerCase();
      return haystack.includes(trustedSendersQuery);
    });
  }, [brokerById, trustedSenders, trustedSendersQuery]);
  const searchActive = trustedSendersQuery.length > 0;

  useEffect(() => {
    onPendingChange?.(pendingSenders.length);
  }, [onPendingChange, pendingSenders.length]);

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
      setConfirmingRemovalId(null);
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

  function requestRemoveTrustedSender(entry: WhitelistEntry) {
    if (entry.source === "registry") {
      return;
    }
    setConfirmingRemovalId(entry.id);
  }

  function confirmRemoveTrustedSender(entry: WhitelistEntry) {
    if (entry.source === "registry" || entry.id == null) {
      return;
    }
    deleteMutation.mutate(entry.id);
  }

  const retryTrustedSenders = () => {
    void whitelistQuery.refetch();
    void pendingQuery.refetch();
    void brokersQuery.refetch();
  };
  const loadError = whitelistQuery.error ?? pendingQuery.error ?? brokersQuery.error;
  const mutationError = addMutation.error ?? deleteMutation.error ?? approveMutation.error ?? rejectMutation.error;
  const loading = whitelistQuery.isLoading || pendingQuery.isLoading || brokersQuery.isLoading;

  return (
    <div className="grid gap-[18px]" data-testid="trusted-senders-section">
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

      <div className="grid gap-[10px] sm:grid-cols-2 xl:grid-cols-4">
        <TrustMetric label="Trusted" value={loading ? "--" : trustedSenders.length} />
        <TrustMetric
          label="Need review"
          tone={pendingSenders.length > 0 ? "attention" : undefined}
          value={loading ? "--" : pendingSenders.length}
        />
        <TrustMetric label="From registry" value={loading ? "--" : registryCount} />
        <TrustMetric label="Added by you" value={loading ? "--" : manualCount} />
      </div>

      {pendingQuery.isLoading ? (
        <LoadingState
          className="bg-muted/40 py-8 shadow-none"
          description="Checking for newly detected reply addresses."
          title="Loading pending senders"
        />
      ) : null}

      {!pendingQuery.isLoading && pendingSenders.length > 0 ? (
        <div className="rounded-sm border border-bd-rust border-l-2 border-l-rust-500 bg-fill-rust px-4 py-[14px]">
          <div className="mb-[10px] flex items-center gap-2">
            <AlertTriangle aria-hidden="true" className="h-[15px] w-[15px] text-soft-rust" />
            <h3 className="font-display text-base font-semibold text-content-strong">
              {pendingSenders.length} sender{pendingSenders.length === 1 ? "" : "s"} need review
            </h3>
          </div>
          <p className="mb-3 text-sm leading-relaxed text-content-body">
            Smokescreen saw replies from these addresses but will not act on them until you approve.
          </p>
          <div className="grid gap-2">
            {pendingSenders.map((entry) => (
              <PendingApprovalItem
                key={entry.id}
                brokerName={brokerDisplayName(entry.broker_id, brokerById)}
                entry={entry}
                isApproving={approveMutation.isPending && approveMutation.variables === entry.id}
                isRejecting={rejectMutation.isPending && rejectMutation.variables === entry.id}
                onApprove={() => approveMutation.mutate(entry.id)}
                onReject={() => rejectMutation.mutate(entry.id)}
              />
            ))}
          </div>
        </div>
      ) : null}

      {!pendingQuery.isLoading && pendingSenders.length === 0 ? (
        <div className="rounded-sm border border-border bg-surface-sunken px-4 py-3">
          <div className="flex items-center gap-2 text-sm text-content-body">
            <CheckCircle2 aria-hidden="true" className="h-4 w-4 text-soft-green" />
            All detected senders are reviewed.
          </div>
        </div>
      ) : null}

      <form className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end" onSubmit={addTrustedSender}>
        <label className="grid gap-2">
          <span className="ss-label">Broker</span>
          <select
            className="h-[38px] rounded-sm border border-input bg-surface-field px-[10px] text-sm text-content-strong outline-none transition-colors focus-visible:shadow-focus"
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
        <label className="grid gap-2">
          <span className="ss-label">Email address</span>
          <input
            className="h-[38px] rounded-sm border border-input bg-surface-field px-[10px] text-sm text-content-strong outline-none transition-colors placeholder:text-content-muted focus-visible:shadow-focus"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="privacy@example.com"
            type="email"
            autoComplete="email"
          />
        </label>
        <Button disabled={addMutation.isPending || !selectedBrokerId.trim() || !email.trim()} type="submit">
          <ShieldPlus className="h-4 w-4" />
          {addMutation.isPending ? "Adding" : "Add sender"}
        </Button>
      </form>

      <div className="grid gap-3">
        <TextField
          aria-label="Search trusted senders"
          hint="Filter by sender email, broker name, or broker id."
          label="Search trusted senders"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search approved senders"
        />
        {searchActive ? (
          <p aria-live="polite" className="text-xs text-content-muted">
            {filteredTrustedSenders.length} of {trustedSenders.length} matches
          </p>
        ) : null}
        <div className="max-h-[360px] overflow-y-auto rounded-sm border border-border" data-testid="trusted-senders-scroll">
          <div className="flex items-center justify-between gap-3 border-b border-border bg-surface-sunken px-[14px] py-[10px]">
            <span className="ss-label">Approved addresses</span>
            <Badge variant="neutral">{loading ? "--" : trustedSenders.length}</Badge>
          </div>
          <div>
            {whitelistQuery.isLoading ? (
              <LoadingState
                className="border-0 bg-transparent py-8 shadow-none"
                description="Loading trusted addresses."
                title="Loading senders"
              />
            ) : null}
            {!whitelistQuery.isLoading && !searchActive && trustedSenders.length === 0 ? (
              <EmptyState
                className="border-0 bg-transparent py-8 shadow-none"
                description="Trusted reply addresses will appear here after you add them or approve detected senders."
                title="No trusted senders yet"
              />
            ) : null}
            {!whitelistQuery.isLoading && searchActive && filteredTrustedSenders.length === 0 ? (
              <div aria-live="polite">
                <EmptyState
                  className="border-0 bg-transparent py-8 shadow-none"
                  description="No approved senders match your search."
                  title="No matches"
                />
              </div>
            ) : null}
            {filteredTrustedSenders.map((entry, index) => (
              <TrustedSenderRow
                key={entry.id}
                brokerName={brokerDisplayName(entry.broker_id, brokerById)}
                entry={entry}
                hasDivider={index > 0}
                isConfirming={confirmingRemovalId === entry.id}
                isRemoving={deleteMutation.isPending && deleteMutation.variables === entry.id}
                onCancelRemove={() => setConfirmingRemovalId(null)}
                onConfirmRemove={() => confirmRemoveTrustedSender(entry)}
                onRequestRemove={() => requestRemoveTrustedSender(entry)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function TrustMetric({
  label,
  tone,
  value,
}: {
  label: string;
  tone?: "attention";
  value: number | string;
}) {
  return (
    <div className="rounded-sm border border-border bg-surface-sunken px-3 py-[10px]">
      <div
        className={cn(
          "font-pixel text-xl leading-none text-content-strong",
          tone === "attention" && "text-soft-rust",
        )}
      >
        {value}
      </div>
      <div className="ss-label mt-[6px]">{label}</div>
    </div>
  );
}

function PendingApprovalItem({
  brokerName,
  entry,
  isApproving,
  isRejecting,
  onApprove,
  onReject,
}: {
  brokerName: string;
  entry: PendingWhitelistEntry;
  isApproving: boolean;
  isRejecting: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-sm border border-border bg-surface-card px-3 py-[10px] sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="break-words font-mono text-sm text-content-strong">{entry.email}</div>
        <div className="mt-0.5 text-xs text-content-muted">
          {brokerName} · first seen {formatUpdatedAt(entry.detected_at)}
        </div>
        {entry.message_subject || entry.message_snippet ? (
          <div className="mt-2 grid gap-2 text-xs text-content-muted sm:grid-cols-2">
            <span className="truncate rounded-sm border border-border bg-surface-sunken px-2 py-1">
              {entry.message_subject || "No subject saved"}
            </span>
            <span className="truncate rounded-sm border border-border bg-surface-sunken px-2 py-1">
              {entry.message_snippet || "No preview saved"}
            </span>
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onReject} disabled={isApproving || isRejecting}>
          <XCircle className="h-4 w-4" />
          {isRejecting ? "Rejecting" : "Reject"}
        </Button>
        <Button size="sm" onClick={onApprove} disabled={isApproving || isRejecting}>
          <UserCheck className="h-4 w-4" />
          {isApproving ? "Approving" : "Approve"}
        </Button>
      </div>
    </div>
  );
}

function TrustedSenderRow({
  brokerName,
  entry,
  hasDivider,
  isConfirming,
  isRemoving,
  onCancelRemove,
  onConfirmRemove,
  onRequestRemove,
}: {
  brokerName: string;
  entry: WhitelistEntry;
  hasDivider: boolean;
  isConfirming: boolean;
  isRemoving: boolean;
  onCancelRemove: () => void;
  onConfirmRemove: () => void;
  onRequestRemove: () => void;
}) {
  return (
    <div
      className={cn(
        "ss-rowin flex flex-col gap-3 px-[14px] py-[11px] sm:flex-row sm:items-center",
        hasDivider && "border-t border-border",
      )}
    >
      <span className="inline-grid h-[30px] w-[30px] shrink-0 place-items-center rounded-sm bg-surface-sunken text-content-muted">
        <Mail aria-hidden="true" className="h-[15px] w-[15px]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-sm text-content-strong">{entry.email}</div>
        <div className="mt-0.5 text-xs text-content-muted">
          {brokerName} · added {formatUpdatedAt(entry.added_at)}
        </div>
      </div>
      <Badge variant={entry.source === "registry" ? "olive" : "outline"}>{sourceLabel(entry.source)}</Badge>
      {entry.source === "manual" ? (
        isConfirming ? (
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onCancelRemove} disabled={isRemoving}>
              Cancel
            </Button>
            <Button
              aria-label={`Confirm remove trusted sender ${entry.email}`}
              variant="danger"
              size="sm"
              onClick={onConfirmRemove}
              disabled={isRemoving}
            >
              {isRemoving ? "Removing" : "Confirm"}
            </Button>
          </div>
        ) : (
          <Button
            iconOnly
            aria-label={`Remove trusted sender ${entry.email}`}
            variant="ghost"
            size="sm"
            onClick={onRequestRemove}
            disabled={isRemoving}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        )
      ) : (
        <span
          className="inline-grid h-[30px] w-[30px] shrink-0 place-items-center text-content-faint"
          title="From the broker registry and cannot be removed here"
        >
          <ShieldCheck aria-hidden="true" className="h-[14px] w-[14px]" />
        </span>
      )}
    </div>
  );
}

function sourceLabel(source: WhitelistEntry["source"]): string {
  return source === "registry" ? "Registry" : "Manual";
}

function brokerDisplayName(brokerId: string | null | undefined, brokerById: Map<string, Broker>): string {
  if (!brokerId) {
    return "Unknown broker";
  }
  return brokerById.get(brokerId)?.name ?? "Unlisted broker";
}

function formatUpdatedAt(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
