import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  Brain,
  CheckCircle2,
  Circle,
  KeyRound,
  Mail,
  Rocket,
  Send,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

import { api, type Broker } from "../lib/api";
import { useAdvancedSettings, useBrokers, useSettings } from "../lib/queries";
import { cn } from "../lib/utils";
import { Avatar } from "../components/ui/avatar";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ThrowOverlay } from "../components/ui/motion";
import { TextField } from "../components/ui/text-field";
import { EmptyState, ErrorState, LoadingState } from "../components/status-state";

const ONBOARDING_STEP_KEY = "smokescreen:onboarding-step";
const ONBOARDING_COMPLETE_KEY = "smokescreen:onboarding-complete";
const ONBOARDING_BROKERS_KEY = "smokescreen:onboarding-brokers";

const steps = [
  { id: 0, label: "Identity", icon: Mail },
  { id: 1, label: "Claude", icon: Brain },
  { id: 2, label: "Brokers", icon: ShieldCheck },
  { id: 3, label: "Launch", icon: Rocket },
] as const;

type GmailForm = {
  senderName: string;
  senderEmail: string;
};

function loadStep(): number {
  const value = Number(window.localStorage.getItem(ONBOARDING_STEP_KEY) ?? "0");
  return Number.isInteger(value) && value >= 0 && value < steps.length ? value : 0;
}

function loadComplete(): boolean {
  return window.localStorage.getItem(ONBOARDING_COMPLETE_KEY) === "true";
}

function loadSelectedBrokerIds(): string[] {
  const raw = window.localStorage.getItem(ONBOARDING_BROKERS_KEY);
  if (!raw) {
    return [];
  }
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function brokerDomain(broker: Broker): string {
  return broker.domain || broker.privacy_email;
}

export function OnboardingPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const settingsQuery = useSettings();
  const advancedSettingsQuery = useAdvancedSettings();
  const brokersQuery = useBrokers();
  const settings = settingsQuery.data;
  const advancedSettings = advancedSettingsQuery.data;
  const brokers = brokersQuery.data ?? [];
  const [activeStep, setActiveStep] = useState(loadStep);
  const [gmailForm, setGmailForm] = useState<GmailForm>({ senderName: "", senderEmail: "" });
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [selectedBrokerIds, setSelectedBrokerIds] = useState<string[]>(loadSelectedBrokerIds);
  const [identitySavedThisSession, setIdentitySavedThisSession] = useState(false);
  const [claudeSavedThisSession, setClaudeSavedThisSession] = useState(false);
  const [firstBatchSent, setFirstBatchSent] = useState(loadComplete);
  const [sentBrokerCount, setSentBrokerCount] = useState(0);
  const [throwOverlayOpen, setThrowOverlayOpen] = useState(false);
  const [throwOverlayCount, setThrowOverlayCount] = useState(0);

  const selectedBrokers = useMemo(
    () => brokers.filter((broker) => selectedBrokerIds.includes(broker.id)),
    [brokers, selectedBrokerIds],
  );

  const identityComplete = identitySavedThisSession || Boolean(settings?.identity_configured);
  const gmailReady = Boolean(settings?.gmail_connected);
  const claudeConfigured = claudeSavedThisSession || Boolean(settings?.anthropic_api_key);
  const brokersComplete = selectedBrokerIds.length > 0;
  const canSend = identityComplete && claudeConfigured && brokersComplete;
  const activeError =
    settingsQuery.error?.message ??
    advancedSettingsQuery.error?.message ??
    brokersQuery.error?.message;
  const retryOnboarding = () => {
    void settingsQuery.refetch();
    void advancedSettingsQuery.refetch();
    void brokersQuery.refetch();
  };

  const updateSettingsMutation = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
        queryClient.invalidateQueries({ queryKey: ["settings", "advanced"] }),
      ]);
    },
  });

  const outreachMutation = useMutation({
    mutationFn: api.runOutreach,
    onSuccess: async (result) => {
      window.localStorage.setItem(ONBOARDING_COMPLETE_KEY, "true");
      setFirstBatchSent(true);
      setSentBrokerCount(result.processed_count || selectedBrokerIds.length);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["opt-outs"] }),
        queryClient.invalidateQueries({ queryKey: ["extended-stats"] }),
      ]);
    },
    onError: () => {
      setThrowOverlayOpen(false);
    },
  });

  useEffect(() => {
    if (settings) {
      setGmailForm({
        senderName: settings.sender_name,
        senderEmail: settings.sender_email,
      });
    }
  }, [settings]);

  useEffect(() => {
    window.localStorage.setItem(ONBOARDING_STEP_KEY, String(activeStep));
  }, [activeStep]);

  useEffect(() => {
    window.localStorage.setItem(ONBOARDING_BROKERS_KEY, JSON.stringify(selectedBrokerIds));
  }, [selectedBrokerIds]);

  function goToStep(step: number) {
    setActiveStep(step);
  }

  function saveIdentity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    updateSettingsMutation.mutate(
      {
        sender_name: gmailForm.senderName.trim(),
        sender_email: gmailForm.senderEmail.trim(),
      },
      {
        onSuccess: () => {
          setIdentitySavedThisSession(true);
          goToStep(1);
        },
      },
    );
  }

  function saveClaude(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const key = anthropicApiKey.trim();
    if (!key) {
      return;
    }
    updateSettingsMutation.mutate(
      { anthropic_api_key: key },
      {
        onSuccess: () => {
          setClaudeSavedThisSession(true);
          setAnthropicApiKey("");
          goToStep(2);
        },
      },
    );
  }

  function toggleBroker(brokerId: string) {
    setSelectedBrokerIds((current) =>
      current.includes(brokerId) ? current.filter((id) => id !== brokerId) : [...current, brokerId],
    );
    window.localStorage.removeItem(ONBOARDING_COMPLETE_KEY);
    setFirstBatchSent(false);
  }

  function clearSelection() {
    setSelectedBrokerIds([]);
    window.localStorage.removeItem(ONBOARDING_COMPLETE_KEY);
    setFirstBatchSent(false);
  }

  function sendFirstBatch() {
    if (!canSend) {
      return;
    }
    const brokerIds = [...selectedBrokerIds];
    setThrowOverlayCount(brokerIds.length);
    setThrowOverlayOpen(true);
    outreachMutation.mutate(brokerIds);
  }

  return (
    <section className="mx-auto grid max-w-container gap-[18px] px-gutter py-6">
      {throwOverlayOpen ? (
        <ThrowOverlay
          count={throwOverlayCount}
          resolveWhen={firstBatchSent}
          onClose={() => setThrowOverlayOpen(false)}
          onViewStatus={() => {
            setThrowOverlayOpen(false);
            navigate("/");
          }}
        />
      ) : null}

      {activeError ? (
        <ErrorState
          description="Smokescreen could not load setup details from the local API. Refresh setup after checking that the service is running."
          onAction={retryOnboarding}
          title="Setup details are unavailable"
        />
      ) : null}
      {updateSettingsMutation.error ? (
        <ErrorState
          description="Smokescreen could not save that setup step. Check the fields and try again."
          onAction={() => updateSettingsMutation.reset()}
          title="Setup was not saved"
        />
      ) : null}
      {outreachMutation.error ? (
        <ErrorState
          description={
            outreachMutation.error.message ||
            "Smokescreen could not start the first batch. Connect Gmail or enable dry run before trying again."
          }
          onAction={retryOnboarding}
          title="First batch did not start"
        />
      ) : null}

      <div>
        <h1 className="font-display text-2xl font-semibold leading-tight text-content-strong">
          Set up Smokescreen
        </h1>
        <p className="mt-1 max-w-[58ch] text-sm text-content-muted">
          Configure your identity, connect Claude, pick brokers, and throw the first smoke.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((step) => {
          const complete =
            (step.id === 0 && identityComplete) ||
            (step.id === 1 && claudeConfigured) ||
            (step.id === 2 && brokersComplete) ||
            (step.id === 3 && firstBatchSent);

          return (
            <StepTile
              key={step.id}
              idx={step.id}
              label={step.label}
              Icon={step.icon}
              active={activeStep === step.id}
              complete={complete}
              onClick={() => goToStep(step.id)}
            />
          );
        })}
      </div>

      {activeStep === 0 ? (
        <Card label="Step 1" title={<StepCardTitle>Configure identity</StepCardTitle>} pad={false}>
          <form className="grid max-w-[460px] gap-[14px]" onSubmit={saveIdentity}>
            <p className="text-sm text-content-muted">Smokescreen uses these details in every broker request.</p>
            <TextField
              label="Full name"
              value={gmailForm.senderName}
              onChange={(event) => setGmailForm((current) => ({ ...current, senderName: event.currentTarget.value }))}
              placeholder="Jane Doe"
            />
            <TextField
              label="Gmail address"
              type="email"
              icon={<Mail />}
              value={gmailForm.senderEmail}
              onChange={(event) => setGmailForm((current) => ({ ...current, senderEmail: event.currentTarget.value }))}
              placeholder="jane@gmail.com"
            />
            <div className="flex flex-wrap items-center gap-[10px]">
              <Button
                type="submit"
                disabled={!gmailForm.senderName.trim() || !gmailForm.senderEmail.trim() || updateSettingsMutation.isPending}
              >
                <Mail className="h-[15px] w-[15px]" />
                Save identity
              </Button>
              {identityComplete ? (
                <Badge variant="success" dot>
                  Saved
                </Badge>
              ) : null}
            </div>
          </form>
        </Card>
      ) : null}

      {activeStep === 1 ? (
        <Card label="Step 2" title={<StepCardTitle>Add Claude</StepCardTitle>}>
          <form className="grid max-w-[460px] gap-[14px]" onSubmit={saveClaude}>
            <p className="text-sm text-content-muted">
              Claude reads broker replies and drafts the next response when a follow-up is needed.
            </p>
            <TextField
              label="Anthropic API key"
              type="password"
              icon={<KeyRound />}
              value={anthropicApiKey}
              onChange={(event) => setAnthropicApiKey(event.currentTarget.value)}
              placeholder={settings?.anthropic_api_key ? "sk-ant-... saved" : "sk-ant-..."}
              hint="Stored locally. Never shared with brokers."
            />
            <div className="flex flex-wrap items-center gap-[10px]">
              <Button type="submit" disabled={!anthropicApiKey.trim() || updateSettingsMutation.isPending}>
                <KeyRound className="h-[15px] w-[15px]" />
                Save Claude key
              </Button>
              {claudeConfigured ? (
                <Badge variant="success" dot>
                  Configured
                </Badge>
              ) : null}
            </div>
          </form>
        </Card>
      ) : null}

      {activeStep === 2 ? (
        <Card
          label="Step 3"
          title={<StepCardTitle>Pick brokers</StepCardTitle>}
          action={<Badge variant="olive">{selectedBrokerIds.length} selected</Badge>}
        >
          <div className="grid gap-[10px]">
            <p className="text-sm text-content-muted">
              Choose the companies you want Smokescreen to contact first.
            </p>
            <div className="max-h-[300px] overflow-y-auto rounded-sm border border-border">
              {brokersQuery.isLoading ? (
                <LoadingState
                  className="border-0 bg-transparent py-12 shadow-none"
                  description="Loading the broker registry for your first batch."
                  title="Loading brokers"
                />
              ) : null}
              {!brokersQuery.isLoading && brokers.length === 0 ? (
                <EmptyState
                  className="border-0 bg-transparent py-12 shadow-none"
                  description="Add brokers before starting the first batch."
                  icon={<ShieldCheck className="h-5 w-5" />}
                  title="No brokers found"
                />
              ) : null}
              {brokers.map((broker, index) => {
                const selected = selectedBrokerIds.includes(broker.id);
                return (
                  <label
                    key={broker.id}
                    className={cn(
                      "flex min-h-[62px] cursor-pointer items-center gap-[11px] px-[13px] py-[11px] transition-colors hover:bg-fill-neutral",
                      index > 0 && "border-t border-border",
                      selected && "bg-fill-olive hover:bg-fill-olive",
                    )}
                  >
                    <input
                      className="h-[17px] w-[17px] rounded-sm border-[color:var(--border-field)] accent-brand"
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleBroker(broker.id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-content-strong">
                        {broker.name}
                      </span>
                      <span className="mt-1 block truncate font-mono text-xs text-content-muted">
                        {brokerDomain(broker)}
                      </span>
                    </span>
                    {selected ? <CheckCircle2 className="h-[17px] w-[17px] shrink-0 text-brand" /> : null}
                  </label>
                );
              })}
            </div>
            <div className="flex justify-end gap-[10px]">
              <Button variant="ghost" type="button" onClick={clearSelection} disabled={!selectedBrokerIds.length}>
                Clear
              </Button>
              <Button type="button" onClick={() => goToStep(3)} disabled={!brokersComplete}>
                Continue
                <ArrowRight className="h-[15px] w-[15px]" />
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      {activeStep === 3 ? (
        <Card label="Step 4" title={<StepCardTitle>Send first batch</StepCardTitle>}>
          <div className="grid gap-4">
            <div className="grid gap-[10px] sm:grid-cols-2 lg:grid-cols-4">
              <SetupCheck
                complete={identityComplete}
                label="Identity"
                value={identityComplete ? settings?.sender_email || gmailForm.senderEmail || "Saved" : "Missing identity"}
              />
              <SetupCheck
                complete={claudeConfigured}
                label="Claude key"
                value={claudeConfigured ? "Configured" : "Missing key"}
              />
              <SetupCheck
                complete={brokersComplete}
                label="Brokers"
                value={brokersComplete ? `${selectedBrokerIds.length} selected` : "None selected"}
              />
              <SetupCheck
                complete={gmailReady}
                label="Gmail"
                value={gmailReady ? settings?.gmail_connected_email || "Token ready" : "Not connected"}
              />
            </div>

            {advancedSettings?.dry_run ? (
              <div className="rounded-sm border border-bd-amber bg-fill-amber px-4 py-3 text-sm text-soft-amber">
                Dry run is on. The first batch will be prepared without sending email.
              </div>
            ) : null}

            {selectedBrokers.length > 0 ? (
              <div className="rounded-sm border border-border bg-surface-sunken">
                <div className="divide-y divide-border">
                  {selectedBrokers.slice(0, 6).map((broker) => (
                    <div key={broker.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                      <span className="min-w-0 truncate font-semibold text-content-strong">{broker.name}</span>
                      <span className="min-w-0 truncate font-mono text-xs text-content-muted">
                        {broker.privacy_email}
                      </span>
                    </div>
                  ))}
                  {selectedBrokers.length > 6 ? (
                    <div className="px-4 py-3 text-sm text-content-muted">
                      {selectedBrokers.length - 6} more brokers in this batch
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            {firstBatchSent ? (
              <LaunchConfirmation
                count={sentBrokerCount || selectedBrokerIds.length}
                onViewStatus={() => navigate("/")}
              />
            ) : (
              <div className="flex flex-wrap items-center justify-end gap-[10px]">
                <Button variant="outline" type="button" onClick={() => goToStep(2)}>
                  Edit brokers
                </Button>
                <Button
                  variant="accent"
                  type="button"
                  disabled={!canSend || outreachMutation.isPending}
                  onClick={sendFirstBatch}
                >
                  <Send className="h-[15px] w-[15px]" />
                  {outreachMutation.isPending ? "Sending" : "Send first batch"}
                </Button>
              </div>
            )}
          </div>
        </Card>
      ) : null}
    </section>
  );
}

function StepCardTitle({ children }: { children: string }) {
  return <h2 className="font-display text-lg font-semibold leading-snug text-content-strong">{children}</h2>;
}

function StepTile({
  Icon,
  active,
  complete,
  idx,
  label,
  onClick,
}: {
  Icon: LucideIcon;
  active: boolean;
  complete: boolean;
  idx: number;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        "flex min-h-[72px] min-w-0 items-center justify-between gap-[10px] rounded-md border bg-surface-card px-4 py-3 text-left transition-[border-color,box-shadow] duration-fast ease-standard",
        active ? "border-brand shadow-focus" : "border-border shadow-sm hover:border-[color:var(--border-strong)]",
      )}
      type="button"
      onClick={onClick}
    >
      <span className="flex min-w-0 items-center gap-[11px]">
        <span
          className={cn(
            "inline-grid h-[38px] w-[38px] shrink-0 place-items-center rounded-sm bg-surface-sunken text-content-muted",
            complete && "bg-fill-olive text-olive-300",
          )}
        >
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <span className="min-w-0">
          <span className="block truncate whitespace-nowrap font-display text-sm font-semibold leading-tight text-content-strong">
            {label}
          </span>
          <span className="ss-label mt-0.5 block whitespace-nowrap">Step {idx + 1}</span>
        </span>
      </span>
      {complete ? (
        <CheckCircle2 className="h-[18px] w-[18px] shrink-0 text-clear-500" />
      ) : (
        <Circle className="h-[18px] w-[18px] shrink-0 text-content-faint" />
      )}
    </button>
  );
}

function SetupCheck({ complete, label, value }: { complete: boolean; label: string; value: string }) {
  return (
    <div className="rounded-sm border border-border bg-surface-card px-[13px] py-3">
      <div className="flex items-center gap-1.5 text-sm font-semibold text-content-strong">
        {complete ? (
          <CheckCircle2 className="h-[15px] w-[15px] shrink-0 text-clear-500" />
        ) : (
          <Circle className="h-[15px] w-[15px] shrink-0 text-content-faint" />
        )}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-[5px] truncate font-mono text-xs text-content-muted">{value}</div>
    </div>
  );
}

function LaunchConfirmation({ count, onViewStatus }: { count: number; onViewStatus: () => void }) {
  const requestCopy = count === 1 ? "1 opt-out request is" : `${count} opt-out requests are`;

  return (
    <div className="relative flex items-center gap-3 overflow-hidden rounded-md border border-bd-green bg-fill-green px-[18px] py-4">
      <Avatar src="/assets/operator-head.png" size="md" />
      <div className="min-w-0 flex-1">
        <div className="font-display text-base font-semibold text-soft-green">Smoke's out.</div>
        <div className="mt-1 text-sm text-content-body">
          {requestCopy} on the way. Track them on the Status board.
        </div>
      </div>
      <Button variant="outline" size="sm" type="button" onClick={onViewStatus}>
        View status
        <ArrowRight className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
