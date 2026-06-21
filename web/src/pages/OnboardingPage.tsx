import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowRight,
  Brain,
  Check,
  CheckCircle2,
  Circle,
  KeyRound,
  Mail,
  Rocket,
  Search,
  Send,
  Settings,
  ShieldCheck,
} from "lucide-react";

import { ApiError } from "../App";
import { api, type Broker } from "../lib/api";
import { useAdvancedSettings, useBrokers, useSettings } from "../lib/queries";
import { cn } from "../lib/utils";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";

const ONBOARDING_STEP_KEY = "smokescreen:onboarding-step";
const ONBOARDING_COMPLETE_KEY = "smokescreen:onboarding-complete";
const ONBOARDING_BROKERS_KEY = "smokescreen:onboarding-brokers";

const inputClass =
  "h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring";

const steps = [
  { id: 0, label: "Gmail", icon: Mail },
  { id: 1, label: "Claude", icon: Brain },
  { id: 2, label: "Brokers", icon: ShieldCheck },
  { id: 3, label: "First batch", icon: Rocket },
];

type GmailForm = {
  senderName: string;
  senderEmail: string;
};

function loadStep(): number {
  const value = Number(window.localStorage.getItem(ONBOARDING_STEP_KEY) ?? "0");
  return Number.isInteger(value) && value >= 0 && value < steps.length ? value : 0;
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

function brokerMatchesSearch(broker: Broker, search: string): boolean {
  const query = search.trim().toLowerCase();
  if (!query) {
    return true;
  }
  return [broker.name, broker.domain, broker.privacy_email, broker.notes, ...broker.aliases]
    .join(" ")
    .toLowerCase()
    .includes(query);
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
  const [brokerSearch, setBrokerSearch] = useState("");

  const filteredBrokers = useMemo(
    () => brokers.filter((broker) => brokerMatchesSearch(broker, brokerSearch)),
    [brokers, brokerSearch],
  );
  const selectedBrokers = useMemo(
    () => brokers.filter((broker) => selectedBrokerIds.includes(broker.id)),
    [brokers, selectedBrokerIds],
  );

  const gmailComplete = Boolean(settings?.gmail_connected && settings.gmail_connected_email);
  const claudeComplete = Boolean(settings?.anthropic_api_key);
  const brokersComplete = selectedBrokerIds.length > 0;
  const canSend = gmailComplete && claudeComplete && brokersComplete;
  const activeError =
    settingsQuery.error?.message ??
    advancedSettingsQuery.error?.message ??
    brokersQuery.error?.message;

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
    onSuccess: async () => {
      window.localStorage.setItem(ONBOARDING_COMPLETE_KEY, "true");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["opt-outs"] }),
        queryClient.invalidateQueries({ queryKey: ["extended-stats"] }),
      ]);
      navigate("/");
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

  function saveGmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    updateSettingsMutation.mutate(
      {
        sender_name: gmailForm.senderName.trim(),
        sender_email: gmailForm.senderEmail.trim(),
      },
      {
        onSuccess: () => goToStep(1),
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
  }

  function selectAllFiltered() {
    setSelectedBrokerIds((current) => Array.from(new Set([...current, ...filteredBrokers.map((broker) => broker.id)])));
  }

  function clearSelection() {
    setSelectedBrokerIds([]);
  }

  function sendFirstBatch() {
    if (!canSend) {
      return;
    }
    outreachMutation.mutate(selectedBrokerIds);
  }

  return (
    <section className="mx-auto grid max-w-6xl gap-5 px-5 py-6 sm:px-6 lg:px-8">
      {activeError ? <ApiError message={activeError} /> : null}
      {updateSettingsMutation.error ? <ApiError message={updateSettingsMutation.error.message} /> : null}
      {outreachMutation.error ? <ApiError message={outreachMutation.error.message} /> : null}

      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h2 className="text-2xl font-semibold tracking-normal">Set up Smokescreen</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Connect the inbox, add Claude, choose brokers, and start the first opt-out batch.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/settings">
            <Settings className="h-4 w-4" />
            Settings
          </Link>
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        {steps.map((step) => {
          const Icon = step.icon;
          const complete =
            (step.id === 0 && gmailComplete) ||
            (step.id === 1 && claudeComplete) ||
            (step.id === 2 && brokersComplete) ||
            false;
          return (
            <button
              key={step.id}
              className={cn(
                "flex h-20 items-center justify-between rounded-md border bg-card px-4 text-left transition-colors hover:bg-muted",
                activeStep === step.id && "border-primary ring-2 ring-primary/20",
              )}
              type="button"
              onClick={() => goToStep(step.id)}
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
                  <Icon className="h-5 w-5" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-foreground">{step.label}</span>
                  <span className="block text-xs text-muted-foreground">Step {step.id + 1}</span>
                </span>
              </span>
              {complete ? <CheckCircle2 className="h-5 w-5 text-primary" /> : <Circle className="h-5 w-5 text-muted-foreground" />}
            </button>
          );
        })}
      </div>

      {activeStep === 0 ? (
        <div className="rounded-md border bg-card p-5">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
              <Mail className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h3 className="text-lg font-semibold tracking-normal">Connect Gmail</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Smokescreen sends broker requests from your Gmail address and watches that inbox for replies.
              </p>
            </div>
          </div>
          <form className="mt-5 grid gap-4 sm:max-w-xl" onSubmit={saveGmail}>
            <label className="grid gap-2 text-sm font-medium">
              Full name
              <input
                className={inputClass}
                value={gmailForm.senderName}
                onChange={(event) => setGmailForm((current) => ({ ...current, senderName: event.currentTarget.value }))}
                placeholder="Jane Doe"
              />
            </label>
            <label className="grid gap-2 text-sm font-medium">
              Gmail address
              <input
                className={inputClass}
                type="email"
                value={gmailForm.senderEmail}
                onChange={(event) => setGmailForm((current) => ({ ...current, senderEmail: event.currentTarget.value }))}
                placeholder="jane@gmail.com"
              />
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="submit"
                disabled={!gmailForm.senderName.trim() || !gmailForm.senderEmail.trim() || updateSettingsMutation.isPending}
              >
                <Mail className="h-4 w-4" />
                Connect Gmail
              </Button>
              {gmailComplete ? (
                <Badge variant="secondary">
                  <Check className="mr-1 h-3 w-3" />
                  {settings?.gmail_connected_email}
                </Badge>
              ) : null}
            </div>
          </form>
        </div>
      ) : null}

      {activeStep === 1 ? (
        <div className="rounded-md border bg-card p-5">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
              <Brain className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h3 className="text-lg font-semibold tracking-normal">Add Claude</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Claude reads broker replies and drafts the next response when the process needs a follow-up.
              </p>
            </div>
          </div>
          <form className="mt-5 grid gap-4 sm:max-w-xl" onSubmit={saveClaude}>
            <label className="grid gap-2 text-sm font-medium">
              Anthropic API key
              <input
                className={inputClass}
                type="password"
                value={anthropicApiKey}
                onChange={(event) => setAnthropicApiKey(event.currentTarget.value)}
                placeholder={settings?.anthropic_api_key || "sk-ant-..."}
              />
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={!anthropicApiKey.trim() || updateSettingsMutation.isPending}>
                <KeyRound className="h-4 w-4" />
                Save Claude key
              </Button>
              {claudeComplete ? (
                <Badge variant="secondary">
                  <Check className="mr-1 h-3 w-3" />
                  Key saved
                </Badge>
              ) : null}
            </div>
          </form>
        </div>
      ) : null}

      {activeStep === 2 ? (
        <div className="rounded-md border bg-card p-5">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
                <ShieldCheck className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h3 className="text-lg font-semibold tracking-normal">Pick brokers</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Start with the companies you want Smokescreen to contact first.
                </p>
              </div>
            </div>
            <Badge variant="outline">{selectedBrokerIds.length} selected</Badge>
          </div>

          <div className="mt-5 flex flex-col gap-3 sm:flex-row">
            <div className="flex h-10 flex-1 items-center gap-2 rounded-md border bg-background px-3">
              <Search className="h-4 w-4 text-muted-foreground" />
              <input
                className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                type="search"
                value={brokerSearch}
                onChange={(event) => setBrokerSearch(event.currentTarget.value)}
                placeholder="Search brokers"
                aria-label="Search brokers"
              />
            </div>
            <Button variant="outline" type="button" onClick={selectAllFiltered} disabled={filteredBrokers.length === 0}>
              <Check className="h-4 w-4" />
              Select visible
            </Button>
            <Button variant="ghost" type="button" onClick={clearSelection} disabled={selectedBrokerIds.length === 0}>
              Clear
            </Button>
          </div>

          <div className="mt-4 max-h-[420px] overflow-y-auto rounded-md border">
            {filteredBrokers.map((broker) => {
              const selected = selectedBrokerIds.includes(broker.id);
              return (
                <label
                  key={broker.id}
                  className="flex min-h-20 cursor-pointer items-center gap-3 border-b px-4 py-3 last:border-b-0 hover:bg-muted/60"
                >
                  <input
                    className="h-5 w-5 rounded border-input accent-primary"
                    type="checkbox"
                    checked={selected}
                    onChange={() => toggleBroker(broker.id)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-foreground">{broker.name}</span>
                    <span className="mt-1 block break-words text-xs text-muted-foreground">
                      {broker.domain || broker.privacy_email}
                    </span>
                  </span>
                  {selected ? <CheckCircle2 className="h-5 w-5 shrink-0 text-primary" /> : null}
                </label>
              );
            })}
            {!brokersQuery.isLoading && filteredBrokers.length === 0 ? (
              <div className="px-5 py-12 text-center">
                <Search className="mx-auto h-9 w-9 text-muted-foreground" />
                <h4 className="mt-3 text-base font-semibold tracking-normal">No brokers found</h4>
                <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
                  Add brokers or clear the search before starting the first batch.
                </p>
                <Button asChild className="mt-4" variant="outline">
                  <Link to="/brokers">Open brokers</Link>
                </Button>
              </div>
            ) : null}
          </div>

          <div className="mt-5 flex justify-end">
            <Button type="button" disabled={!brokersComplete} onClick={() => goToStep(3)}>
              Continue
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : null}

      {activeStep === 3 ? (
        <div className="rounded-md border bg-card p-5">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
              <Rocket className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h3 className="text-lg font-semibold tracking-normal">Send first batch</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Smokescreen will create opt-out records for the selected brokers and send the initial requests when dry
                run is off.
              </p>
            </div>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <SetupCheck complete={gmailComplete} label="Gmail connected" value={settings?.gmail_connected_email || "Not connected"} />
            <SetupCheck complete={claudeComplete} label="Claude ready" value={claudeComplete ? "Key saved" : "Missing key"} />
            <SetupCheck
              complete={brokersComplete}
              label="Brokers picked"
              value={brokersComplete ? `${selectedBrokerIds.length} selected` : "None selected"}
            />
          </div>

          {advancedSettings?.dry_run ? (
            <div className="mt-5 rounded-md border border-accent/40 bg-accent/10 px-4 py-3 text-sm text-accent-foreground">
              Dry run is on. The first batch will be prepared without sending email.
            </div>
          ) : null}

          <div className="mt-5 rounded-md border bg-background">
            {selectedBrokers.length > 0 ? (
              <div className="divide-y">
                {selectedBrokers.slice(0, 6).map((broker) => (
                  <div key={broker.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                    <span className="font-medium">{broker.name}</span>
                    <span className="min-w-0 truncate text-muted-foreground">{broker.privacy_email}</span>
                  </div>
                ))}
                {selectedBrokers.length > 6 ? (
                  <div className="px-4 py-3 text-sm text-muted-foreground">
                    {selectedBrokers.length - 6} more brokers in this batch
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="px-5 py-8 text-center text-sm text-muted-foreground">
                Pick at least one broker before sending the first batch.
              </div>
            )}
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-end gap-3">
            <Button variant="outline" type="button" onClick={() => goToStep(2)}>
              Edit brokers
            </Button>
            <Button type="button" disabled={!canSend || outreachMutation.isPending} onClick={sendFirstBatch}>
              <Send className="h-4 w-4" />
              {outreachMutation.isPending ? "Sending" : "Send first batch"}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function SetupCheck({ complete, label, value }: { complete: boolean; label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background p-4">
      <div className="flex items-center gap-2 text-sm font-semibold">
        {complete ? <CheckCircle2 className="h-4 w-4 text-primary" /> : <Circle className="h-4 w-4 text-muted-foreground" />}
        {label}
      </div>
      <p className="mt-2 truncate text-sm text-muted-foreground">{value}</p>
    </div>
  );
}
