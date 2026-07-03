import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  ChevronDown,
  Clock3,
  FileLock2,
  Mail,
  Plug,
  RefreshCcw,
  RotateCcw,
  Save,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
} from "lucide-react";
import { Link } from "react-router-dom";

import { EmptyState, ErrorState, LoadingState } from "../components/status-state";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { StatusPill } from "../components/ui/status-pill";
import { Switch } from "../components/ui/switch";
import { TextField } from "../components/ui/text-field";
import { api, type AdvancedSettings, type FriendlySettings, type SettingsUpdate } from "../lib/api";
import { useAdvancedSettings, useBrokers, usePendingWhitelist, useSettings, useWhitelist } from "../lib/queries";
import { cn } from "../lib/utils";

const REREQUEST_INTERVAL_MIN_DAYS = 7;
const REREQUEST_INTERVAL_MAX_DAYS = 365;
const STATE_TIMEOUT_MIN_DAYS = 1;
const STATE_TIMEOUT_MAX_DAYS = 90;

type SettingsSectionId = "identity" | "connections" | "trusted" | "cadence" | "advanced";

type SettingsDraft = {
  sender_name: string;
  sender_email: string;
  gmail_connected: boolean;
  rerequest_interval_days: number;
  state_timeout_days: number;
  poll_label: string;
  max_retries: number;
  dry_run: boolean;
};

type SaveRequest = {
  payload: SettingsUpdate;
  snapshot: SettingsDraft;
};

const identityDocSlots = [
  {
    id: "government-id",
    title: "Government ID",
    description: "Driver's license, passport, or state ID.",
  },
  {
    id: "proof-address",
    title: "Proof of address",
    description: "Utility bill or bank statement from the last 90 days.",
  },
  {
    id: "ssn-last-four",
    title: "SSN last 4",
    description: "Optional verifier for brokers that request it.",
  },
] as const;

function draftFromSettings(settings: FriendlySettings, advanced: AdvancedSettings): SettingsDraft {
  return normalizeDraft({
    dry_run: advanced.dry_run,
    gmail_connected: settings.gmail_connected,
    max_retries: advanced.max_retries,
    poll_label: advanced.poll_label,
    rerequest_interval_days: settings.rerequest_interval_days,
    sender_email: settings.sender_email,
    sender_name: settings.sender_name,
    state_timeout_days: settings.state_timeout_days,
  });
}

function normalizeDraft(draft: SettingsDraft): SettingsDraft {
  return {
    ...draft,
    max_retries: Math.max(0, Math.trunc(Number.isFinite(draft.max_retries) ? draft.max_retries : 0)),
    poll_label: draft.poll_label.trim(),
    rerequest_interval_days: clampInteger(
      draft.rerequest_interval_days,
      REREQUEST_INTERVAL_MIN_DAYS,
      REREQUEST_INTERVAL_MAX_DAYS,
    ),
    sender_email: draft.sender_email.trim(),
    sender_name: draft.sender_name.trim(),
    state_timeout_days: clampInteger(draft.state_timeout_days, STATE_TIMEOUT_MIN_DAYS, STATE_TIMEOUT_MAX_DAYS),
  };
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

function sameDraft(left: SettingsDraft | null, right: SettingsDraft | null): boolean {
  if (!left || !right) {
    return true;
  }
  return JSON.stringify(normalizeDraft(left)) === JSON.stringify(normalizeDraft(right));
}

function cadenceWord(days: number): string | null {
  if (days === 7) {
    return "weekly";
  }
  if (days === 14) {
    return "every two weeks";
  }
  if (days === 30) {
    return "monthly";
  }
  if (days === 90) {
    return "quarterly";
  }
  if (days === 365) {
    return "yearly";
  }
  return null;
}

function buildSettingsPayload(
  savedDraft: SettingsDraft,
  draft: SettingsDraft,
  settings: FriendlySettings | undefined,
): SaveRequest {
  const saved = normalizeDraft(savedDraft);
  const next = normalizeDraft(draft);
  const payload: SettingsUpdate = {};

  if (next.sender_name !== saved.sender_name) {
    payload.sender_name = next.sender_name;
  }
  if (next.sender_email !== saved.sender_email) {
    payload.sender_email = next.sender_email;
  }
  if (
    next.rerequest_interval_days !== saved.rerequest_interval_days &&
    !settings?.rerequest_interval_days_from_env
  ) {
    payload.rerequest_interval_days = next.rerequest_interval_days;
  }
  if (next.state_timeout_days !== saved.state_timeout_days && !settings?.state_timeout_days_from_env) {
    payload.state_timeout_days = next.state_timeout_days;
  }
  if (next.poll_label !== saved.poll_label) {
    payload.poll_label = next.poll_label;
  }
  if (next.max_retries !== saved.max_retries) {
    payload.max_retries = next.max_retries;
  }
  if (next.dry_run !== saved.dry_run) {
    payload.dry_run = next.dry_run;
  }
  if (saved.gmail_connected && !next.gmail_connected) {
    payload.gmail_token_json = "";
    payload.gmail_credentials_json = "";
  }

  return { payload, snapshot: next };
}

function payloadHasChanges(payload: SettingsUpdate): boolean {
  return Object.keys(payload).length > 0;
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const settingsQuery = useSettings();
  const advancedQuery = useAdvancedSettings();
  const pendingWhitelistQuery = usePendingWhitelist();
  const settings = settingsQuery.data;
  const advancedSettings = advancedQuery.data;
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [savedDraft, setSavedDraft] = useState<SettingsDraft | null>(null);
  const [activeSection, setActiveSection] = useState<SettingsSectionId>("identity");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [message, setMessage] = useState("");
  const sectionRefs = useRef<Record<SettingsSectionId, HTMLElement | null>>({
    advanced: null,
    cadence: null,
    connections: null,
    identity: null,
    trusted: null,
  });

  useEffect(() => {
    if (!settings || !advancedSettings) {
      return;
    }
    const nextDraft = draftFromSettings(settings, advancedSettings);
    setDraft(nextDraft);
    setSavedDraft(nextDraft);
  }, [advancedSettings, settings]);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.getAttribute("data-section") as SettingsSectionId);
          }
        }
      },
      { rootMargin: "-120px 0px -58% 0px", threshold: 0 },
    );

    for (const element of Object.values(sectionRefs.current)) {
      if (element) {
        observer.observe(element);
      }
    }

    return () => observer.disconnect();
  }, [draft]);

  const saveMutation = useMutation({
    mutationFn: ({ payload }: SaveRequest) => api.updateSettings(payload),
    onSuccess: async (result, { snapshot }) => {
      setDraft(snapshot);
      setSavedDraft(snapshot);
      setMessage(result.restart_required ? "Saved. Restart Smokescreen to apply every change." : "Saved.");
      queryClient.setQueryData<FriendlySettings | undefined>(["settings"], (current) =>
        current
          ? {
              ...current,
              gmail_connected: snapshot.gmail_connected,
              rerequest_interval_days: snapshot.rerequest_interval_days,
              sender_email: snapshot.sender_email,
              sender_name: snapshot.sender_name,
              state_timeout_days: snapshot.state_timeout_days,
            }
          : current,
      );
      queryClient.setQueryData<AdvancedSettings | undefined>(["settings", "advanced"], (current) =>
        current
          ? {
              ...current,
              dry_run: snapshot.dry_run,
              max_retries: snapshot.max_retries,
              poll_label: snapshot.poll_label,
            }
          : current,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
        queryClient.invalidateQueries({ queryKey: ["settings", "advanced"] }),
      ]);
    },
  });

  function setDraftField<Key extends keyof SettingsDraft>(key: Key, value: SettingsDraft[Key]) {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
    setMessage("");
    saveMutation.reset();
  }

  function registerSection(id: SettingsSectionId) {
    return (node: HTMLElement | null) => {
      sectionRefs.current[id] = node;
    };
  }

  function goToSection(id: SettingsSectionId) {
    setActiveSection(id);
    const section = sectionRefs.current[id];
    if (typeof section?.scrollIntoView === "function") {
      section.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function refreshSettings() {
    void settingsQuery.refetch();
    void advancedQuery.refetch();
    void pendingWhitelistQuery.refetch();
  }

  function discardChanges() {
    if (savedDraft) {
      setDraft(savedDraft);
    }
    setMessage("");
    saveMutation.reset();
  }

  function saveChanges() {
    if (!draft || !savedDraft) {
      return;
    }
    const request = buildSettingsPayload(savedDraft, draft, settings);
    if (!payloadHasChanges(request.payload)) {
      setDraft(request.snapshot);
      setSavedDraft(request.snapshot);
      return;
    }
    saveMutation.mutate(request);
  }

  const settingsLoading =
    (settingsQuery.isLoading && !settings) || (advancedQuery.isLoading && !advancedSettings) || !draft;
  const loadError = settingsQuery.error ?? advancedQuery.error;
  const pendingCount = pendingWhitelistQuery.data?.length ?? 0;
  const dirty = !sameDraft(savedDraft, draft);
  const canSave = Boolean(draft && savedDraft && dirty && !saveMutation.isPending);
  const saveRequest = draft && savedDraft ? buildSettingsPayload(savedDraft, draft, settings) : null;
  const hasPayloadChanges = saveRequest ? payloadHasChanges(saveRequest.payload) : false;

  const sections: Array<{
    id: SettingsSectionId;
    label: string;
    icon: ReactNode;
    badge?: number;
  }> = [
    { id: "identity", icon: <UserRound aria-hidden="true" className="h-[15px] w-[15px]" />, label: "Identity" },
    { id: "connections", icon: <Plug aria-hidden="true" className="h-[15px] w-[15px]" />, label: "Connections" },
    {
      badge: pendingCount,
      id: "trusted",
      icon: <ShieldCheck aria-hidden="true" className="h-[15px] w-[15px]" />,
      label: "Trusted senders",
    },
    {
      id: "cadence",
      icon: <SlidersHorizontal aria-hidden="true" className="h-[15px] w-[15px]" />,
      label: "Cadence",
    },
    { id: "advanced", icon: <Settings aria-hidden="true" className="h-[15px] w-[15px]" />, label: "Advanced" },
  ];

  return (
    <section className={cn("mx-auto max-w-container px-gutter py-6", dirty && "pb-28")}>
      {loadError ? (
        <ErrorState
          description="Smokescreen could not load your settings from the local API. Try refreshing before making changes."
          onAction={refreshSettings}
          title="Settings are unavailable"
        />
      ) : null}
      {saveMutation.error ? (
        <ErrorState
          description="Smokescreen could not save those settings. Review the fields and try again."
          onAction={() => saveMutation.reset()}
          title="Settings were not saved"
        />
      ) : null}
      {message ? <SettingsToast message={message} /> : null}

      <div className="grid gap-7 lg:grid-cols-[210px_minmax(0,1fr)]">
        <SettingsRail
          activeSection={activeSection}
          onSelect={goToSection}
          pendingCount={pendingCount}
          sections={sections}
        />

        <div className="grid min-w-0 gap-5">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <div>
              <h1 className="font-display text-2xl font-semibold leading-tight text-content-strong">Settings</h1>
              <p className="mt-1 max-w-[56ch] text-sm leading-relaxed text-content-muted">
                The identity, connections, and cadence Smokescreen uses to run opt-outs on your behalf.
              </p>
            </div>
            <Button size="sm" type="button" variant="outline" onClick={refreshSettings}>
              <RefreshCcw aria-hidden="true" />
              Refresh
            </Button>
          </div>

          {settingsLoading ? (
            <LoadingState description="Loading your identity, Gmail, cadence, and advanced settings." title="Loading settings" />
          ) : null}

          {!settingsLoading && draft ? (
            <>
              <SettingsSection refCallback={registerSection("identity")} id="identity">
                <Card pad>
                  <SectionHead
                    description="Smokescreen uses these details in every broker request."
                    label="01 · Identity"
                    title="Who the requests come from"
                  />
                  <div className="grid max-w-[460px] gap-[14px]">
                    <TextField
                      label="Full name"
                      placeholder="Jane Doe"
                      value={draft.sender_name}
                      onChange={(event) => setDraftField("sender_name", event.currentTarget.value)}
                    />
                    <TextField
                      icon={<Mail aria-hidden="true" />}
                      label="Sender email"
                      placeholder="jane@example.com"
                      type="email"
                      value={draft.sender_email}
                      onChange={(event) => setDraftField("sender_email", event.currentTarget.value)}
                    />
                  </div>
                  <IdentityDocumentsShell />
                </Card>
              </SettingsSection>

              <SettingsSection refCallback={registerSection("connections")} id="connections">
                <Card pad>
                  <SectionHead
                    description="Smokescreen sends from your inbox and uses an AI model to read broker replies."
                    label="02 · Connections"
                    title="Inbox and AI"
                  />
                  <GmailConnectionRow
                    connectedEmail={settings?.gmail_connected_email}
                    draftConnected={draft.gmail_connected}
                    savedConnected={Boolean(savedDraft?.gmail_connected)}
                    onDisconnect={() => setDraftField("gmail_connected", false)}
                  />
                  <AiProviderShell settings={settings} />
                </Card>
              </SettingsSection>

              <SettingsSection refCallback={registerSection("trusted")} id="trusted">
                <Card pad>
                  <SectionHead
                    description="Smokescreen only acts on replies from approved addresses."
                    label="03 · Trusted senders"
                    title="Who Smokescreen trusts"
                  />
                  <TrustedSendersShell />
                </Card>
              </SettingsSection>

              <SettingsSection refCallback={registerSection("cadence")} id="cadence">
                <Card pad>
                  <SectionHead
                    description="Tune how persistent Smokescreen is with brokers."
                    label="04 · Cadence"
                    title="How often Smokescreen acts"
                  />
                  <div className="grid gap-[22px]">
                    <CadenceControl
                      disabled={Boolean(settings?.rerequest_interval_days_from_env)}
                      icon={<RotateCcw aria-hidden="true" className="h-[15px] w-[15px]" />}
                      label="Re-request cadence"
                      max={REREQUEST_INTERVAL_MAX_DAYS}
                      min={REREQUEST_INTERVAL_MIN_DAYS}
                      onChange={(value) => setDraftField("rerequest_interval_days", value)}
                      presets={[
                        { days: 7, label: "Weekly" },
                        { days: 30, label: "Monthly" },
                        { days: 90, label: "Quarterly" },
                      ]}
                      sentence={rerequestSentence(draft.rerequest_interval_days)}
                      value={draft.rerequest_interval_days}
                    />
                    <div className="border-t border-border pt-5">
                      <CadenceControl
                        disabled={Boolean(settings?.state_timeout_days_from_env)}
                        icon={<Clock3 aria-hidden="true" className="h-[15px] w-[15px]" />}
                        label="Silent-broker timeout"
                        max={STATE_TIMEOUT_MAX_DAYS}
                        min={STATE_TIMEOUT_MIN_DAYS}
                        onChange={(value) => setDraftField("state_timeout_days", value)}
                        presets={[
                          { days: 7, label: "1 week" },
                          { days: 14, label: "2 weeks" },
                          { days: 30, label: "Monthly" },
                        ]}
                        sentence={timeoutSentence(draft.state_timeout_days)}
                        value={draft.state_timeout_days}
                      />
                    </div>
                  </div>
                </Card>
              </SettingsSection>

              <SettingsSection refCallback={registerSection("advanced")} id="advanced">
                <Card className="overflow-hidden shadow-none" variant="flat">
                  <button
                    aria-expanded={advancedOpen}
                    className="flex w-full cursor-pointer items-center justify-between gap-3 bg-transparent px-5 py-4 text-left transition-colors duration-fast ease-standard hover:bg-fill-neutral focus-visible:outline-none focus-visible:shadow-focus"
                    onClick={() => setAdvancedOpen((open) => !open)}
                    type="button"
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <span className="inline-grid h-10 w-10 shrink-0 place-items-center rounded-sm border border-border bg-surface-sunken text-content-body">
                        <Settings aria-hidden="true" className="h-[18px] w-[18px]" />
                      </span>
                      <span className="min-w-0">
                        <span className="block font-display text-base font-semibold text-content-strong">Advanced</span>
                        <span className="mt-0.5 block text-sm text-content-muted">
                          Gmail poll label, retries, and dry run.
                        </span>
                      </span>
                    </span>
                    <ChevronDown
                      aria-hidden="true"
                      className={cn(
                        "h-[18px] w-[18px] shrink-0 text-content-muted transition-transform duration-fast ease-standard",
                        advancedOpen && "rotate-180",
                      )}
                    />
                  </button>
                  {advancedOpen ? (
                    <div className="grid max-w-[460px] gap-[14px] px-5 pb-5">
                      <TextField
                        label="Gmail poll label"
                        placeholder="smokescreen"
                        value={draft.poll_label}
                        onChange={(event) => setDraftField("poll_label", event.currentTarget.value)}
                      />
                      <TextField
                        label="Max retries"
                        min={0}
                        type="number"
                        value={String(draft.max_retries)}
                        onChange={(event) =>
                          setDraftField("max_retries", Math.max(0, Number(event.currentTarget.value) || 0))
                        }
                      />
                      <Switch
                        checked={draft.dry_run}
                        description="Prepare work without sending email."
                        label="Dry run"
                        row
                        onChange={(checked) => setDraftField("dry_run", checked)}
                      />
                    </div>
                  ) : null}
                </Card>
              </SettingsSection>
            </>
          ) : null}
        </div>
      </div>

      {dirty ? (
        <StickySaveBar
          canSave={canSave && hasPayloadChanges}
          isSaving={saveMutation.isPending}
          onDiscard={discardChanges}
          onSave={saveChanges}
        />
      ) : null}
    </section>
  );
}

function SettingsRail({
  activeSection,
  onSelect,
  sections,
}: {
  activeSection: SettingsSectionId;
  onSelect: (id: SettingsSectionId) => void;
  pendingCount: number;
  sections: Array<{ id: SettingsSectionId; label: string; icon: ReactNode; badge?: number }>;
}) {
  return (
    <nav
      aria-label="Settings sections"
      className="sticky top-[88px] z-10 grid content-start gap-0.5 self-start overflow-x-auto border-b border-border pb-3 lg:border-b-0 lg:pb-0"
    >
      <span className="ss-label px-[10px] pb-2">Settings</span>
      <div className="flex gap-1 lg:grid lg:gap-0.5">
        {sections.map((section) => {
          const selected = activeSection === section.id;
          return (
            <button
              aria-current={selected ? "true" : undefined}
              className={cn(
                "flex min-w-max items-center gap-[9px] rounded-sm border-l-2 border-l-transparent px-[10px] py-2 text-left text-sm font-medium text-content-muted transition-[background,border-color,color] duration-fast ease-standard hover:bg-fill-neutral hover:text-content-strong lg:min-w-0",
                selected && "border-l-brand bg-fill-olive font-semibold text-content-strong",
              )}
              key={section.id}
              onClick={() => onSelect(section.id)}
              type="button"
            >
              <span className={cn("text-content-faint", selected && "text-brand-strong")}>{section.icon}</span>
              <span className="flex-1 whitespace-nowrap">{section.label}</span>
              {section.badge ? (
                <span
                  aria-label={`${section.badge} trusted sender${section.badge === 1 ? "" : "s"} await review`}
                  className="ss-badge-live inline-grid h-4 min-w-4 place-items-center rounded-pill bg-rust-500 px-1 font-mono text-[10px] font-semibold leading-none text-paper"
                >
                  {section.badge}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function SettingsSection({
  children,
  id,
  refCallback,
}: {
  children: ReactNode;
  id: SettingsSectionId;
  refCallback: (node: HTMLElement | null) => void;
}) {
  return (
    <section className="scroll-mt-24" data-section={id} id={`settings-${id}`} ref={refCallback}>
      {children}
    </section>
  );
}

function SectionHead({
  description,
  label,
  title,
}: {
  description: string;
  label: string;
  title: string;
}) {
  return (
    <div className="mb-4">
      <span className="ss-label text-brand-strong">{label}</span>
      <h2 className="mt-1 font-display text-xl font-semibold leading-tight text-content-strong">{title}</h2>
      <p className="mt-1 max-w-[60ch] text-sm leading-relaxed text-content-muted">{description}</p>
    </div>
  );
}

function IdentityDocumentsShell() {
  return (
    <div className="mt-[22px] border-t border-border pt-[18px]">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-display text-base font-semibold text-content-strong">Identity documents</span>
        <StatusPill label="Encrypted bucket" pulse={false} tone="idle" />
      </div>
      <div className="grid gap-3">
        {identityDocSlots.map((slot) => (
          <div className="flex items-start gap-3 rounded-sm border border-border bg-surface-sunken p-3" key={slot.id}>
            <span className="inline-grid h-9 w-9 shrink-0 place-items-center rounded-sm border border-border bg-surface-card text-content-faint">
              <FileLock2 aria-hidden="true" className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-display text-sm font-semibold text-content-strong">{slot.title}</span>
                <Badge variant="outline">Optional</Badge>
              </div>
              <p className="mt-1 text-sm leading-relaxed text-content-muted">{slot.description}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function GmailConnectionRow({
  connectedEmail,
  draftConnected,
  onDisconnect,
  savedConnected,
}: {
  connectedEmail?: string;
  draftConnected: boolean;
  onDisconnect: () => void;
  savedConnected: boolean;
}) {
  return (
    <div className="flex items-start gap-[14px] border-b border-border pb-[18px]">
      <span className="inline-grid h-10 w-10 shrink-0 place-items-center rounded-sm border border-border bg-surface-sunken text-content-body">
        <Mail aria-hidden="true" className="h-[18px] w-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-[10px]">
          <span className="font-display text-base font-semibold text-content-strong">Gmail</span>
          <StatusPill
            label={draftConnected ? "Connected" : "Not connected"}
            pulse={false}
            tone={draftConnected ? "done" : "attention"}
          />
        </div>
        <p className="mt-1 text-sm leading-relaxed text-content-muted">
          A reusable OAuth token lets Smokescreen send requests and watch for replies.
        </p>
        <p className="mt-1.5 break-words font-mono text-xs text-content-faint">
          {draftConnected
            ? `Connected as ${connectedEmail || "configured Gmail account"}`
            : savedConnected
              ? "Gmail disconnect will be saved with the rest of your changes."
              : "No reusable Gmail token configured."}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {draftConnected ? (
            <Button size="sm" type="button" variant="outline" onClick={onDisconnect}>
              <RotateCcw aria-hidden="true" />
              Disconnect
            </Button>
          ) : (
            <Button asChild size="sm" variant="secondary">
              <Link to="/onboarding">
                <Mail aria-hidden="true" />
                Connect Gmail
              </Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function AiProviderShell({ settings }: { settings?: FriendlySettings }) {
  const activeProvider = settings?.ai_provider ?? "anthropic";
  const providers = [
    {
      icon: <Brain aria-hidden="true" className="h-4 w-4" />,
      id: "gemini",
      name: "Gemini",
      subtitle: "Vertex AI",
      tag: "Default",
    },
    {
      icon: <Brain aria-hidden="true" className="h-4 w-4" />,
      id: "anthropic",
      name: "Claude",
      subtitle: "Anthropic",
      tag: "Optional",
    },
  ] as const;

  return (
    <div className="pt-[18px]">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="font-display text-base font-semibold text-content-strong">AI provider</span>
        <StatusPill
          label={activeProvider === "gemini" ? "Active · Vertex AI" : "Active · Claude"}
          pulse={false}
          tone="done"
        />
      </div>
      <div className="grid gap-[10px] sm:grid-cols-2">
        {providers.map((provider) => {
          const selected = provider.id === activeProvider;
          return (
            <div
              aria-selected={selected}
              className={cn(
                "rounded-sm border border-[color:var(--border-strong)] bg-transparent p-[13px] transition-[background,border-color,box-shadow] duration-fast ease-standard",
                selected && "border-brand bg-fill-olive shadow-focus",
              )}
              key={provider.id}
            >
              <div className="flex items-start justify-between gap-3">
                <span className="flex min-w-0 items-center gap-[9px]">
                  <span
                    className={cn(
                      "inline-grid h-[30px] w-[30px] shrink-0 place-items-center rounded-sm bg-surface-sunken text-content-muted",
                      selected && "bg-brand text-content-on-olive",
                    )}
                  >
                    {provider.icon}
                  </span>
                  <span className="min-w-0">
                    <span className="block font-display text-base font-semibold text-content-strong">{provider.name}</span>
                    <span className="ss-label">{provider.subtitle}</span>
                  </span>
                </span>
                {selected ? <CheckCircle2 aria-hidden="true" className="h-[18px] w-[18px] text-brand-strong" /> : null}
              </div>
              <div className="mt-2">
                <Badge variant={selected ? "olive" : "neutral"}>{provider.tag}</Badge>
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-sm leading-relaxed text-content-muted">
        {activeProvider === "gemini"
          ? `Gemini model: ${settings?.gemini_model || "gemini"}`
          : settings?.anthropic_key_from_secret
            ? "Claude key is supplied by Secret Manager."
            : settings?.anthropic_api_key
              ? "Claude key is on file."
              : "Claude key is not configured."}
      </p>
    </div>
  );
}

function TrustedSendersShell() {
  const whitelistQuery = useWhitelist();
  const pendingQuery = usePendingWhitelist();
  const brokersQuery = useBrokers();
  const trustedSenders = whitelistQuery.data ?? [];
  const pendingSenders = pendingQuery.data ?? [];
  const brokerById = useMemo(
    () => new Map((brokersQuery.data ?? []).map((broker) => [broker.id, broker.name])),
    [brokersQuery.data],
  );
  const manualCount = trustedSenders.filter((entry) => entry.source === "manual").length;
  const registryCount = trustedSenders.length - manualCount;
  const loading = whitelistQuery.isLoading || pendingQuery.isLoading || brokersQuery.isLoading;
  const error = whitelistQuery.error ?? pendingQuery.error ?? brokersQuery.error;

  if (error) {
    return (
      <ErrorState
        className="shadow-none"
        description="Smokescreen could not load trusted-sender counts."
        onAction={() => {
          void whitelistQuery.refetch();
          void pendingQuery.refetch();
          void brokersQuery.refetch();
        }}
        title="Trusted senders are unavailable"
      />
    );
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <SettingsMetric label="Trusted" loading={loading} value={trustedSenders.length} />
        <SettingsMetric label="Need review" loading={loading} tone="attention" value={pendingSenders.length} />
        <SettingsMetric label="From registry" loading={loading} value={registryCount} />
        <SettingsMetric label="Added by you" loading={loading} value={manualCount} />
      </div>

      {loading ? (
        <LoadingState
          className="bg-surface-sunken py-8 shadow-none"
          description="Checking approved and newly detected sender addresses."
          title="Loading trusted senders"
        />
      ) : null}

      {!loading && pendingSenders.length > 0 ? (
        <div className="rounded-sm border border-bd-rust bg-fill-rust p-4">
          <div className="flex items-center gap-2 text-soft-rust">
            <AlertTriangle aria-hidden="true" className="h-4 w-4" />
            <span className="font-display text-sm font-semibold">Pending sender review</span>
          </div>
          <div className="mt-3 grid gap-2">
            {pendingSenders.slice(0, 3).map((entry) => (
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm" key={entry.id}>
                <span className="break-all font-mono text-content-strong">{entry.email}</span>
                <Badge variant="danger">{brokerById.get(entry.broker_id ?? "") ?? "Unknown broker"}</Badge>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {!loading && pendingSenders.length === 0 ? (
        <EmptyState
          className="bg-surface-sunken py-8 shadow-none"
          description="No sender approvals are waiting right now."
          icon={<CheckCircle2 aria-hidden="true" className="h-5 w-5" />}
          title="All senders are reviewed"
        />
      ) : null}
    </div>
  );
}

function SettingsMetric({
  label,
  loading,
  tone = "neutral",
  value,
}: {
  label: string;
  loading: boolean;
  tone?: "attention" | "neutral";
  value: number;
}) {
  return (
    <div className="rounded-sm border border-border bg-surface-sunken px-3 py-3">
      <div className="ss-label">{label}</div>
      <div className={cn("mt-1 font-display text-2xl font-semibold text-content-strong", tone === "attention" && "text-soft-rust")}>
        {loading ? "--" : value}
      </div>
    </div>
  );
}

function CadenceControl({
  disabled,
  icon,
  label,
  max,
  min,
  onChange,
  presets,
  sentence,
  value,
}: {
  disabled: boolean;
  icon: ReactNode;
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  presets: Array<{ days: number; label: string }>;
  sentence: string;
  value: number;
}) {
  return (
    <div>
      <div className="mb-[10px] flex flex-wrap items-center gap-2">
        <span className="text-content-muted">{icon}</span>
        <span className="font-display text-base font-semibold text-content-strong">{label}</span>
        {disabled ? <Badge variant="outline">Set by environment</Badge> : null}
      </div>
      <div className="grid gap-3">
        <div className="flex flex-wrap gap-1.5">
          {presets.map((preset) => {
            const selected = value === preset.days;
            return (
              <button
                aria-pressed={selected}
                className={cn(
                  "rounded-sm border border-[color:var(--border-strong)] px-[11px] py-1.5 font-mono text-2xs font-semibold uppercase tracking-label text-content-muted transition-[background,border-color,color] duration-fast ease-standard hover:border-brand hover:text-content-strong disabled:cursor-not-allowed disabled:opacity-45",
                  selected && "border-brand bg-fill-olive text-brand-strong",
                )}
                disabled={disabled}
                key={preset.days}
                onClick={() => onChange(preset.days)}
                type="button"
              >
                {preset.label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-[14px]">
          <input
            aria-label={label}
            className="h-1 min-w-0 flex-1 disabled:cursor-not-allowed disabled:opacity-45"
            disabled={disabled}
            max={max}
            min={min}
            onChange={(event) => onChange(Number(event.currentTarget.value))}
            style={{ accentColor: "var(--brand)" }}
            type="range"
            value={value}
          />
          <div className="flex min-w-[92px] items-baseline justify-end gap-1.5">
            <span className="font-pixel text-[22px] leading-none text-content-strong">{value}</span>
            <span className="ss-label">days</span>
          </div>
        </div>
        <p className="text-sm leading-relaxed text-content-body">{sentence}</p>
      </div>
    </div>
  );
}

function rerequestSentence(days: number): string {
  const word = cadenceWord(days);
  return `Smokescreen re-sends a deletion request to each completed broker every ${days} days${
    word ? ` - ${word}` : ""
  }. Brokers can quietly re-add your data; periodic re-requests keep them honest.`;
}

function timeoutSentence(days: number): string {
  const word = cadenceWord(days);
  return `After ${days} days${
    word ? ` (${word})` : ""
  } with no reply, Smokescreen sends a polite follow-up ping. A second silent period flags the record for your review.`;
}

function StickySaveBar({
  canSave,
  isSaving,
  onDiscard,
  onSave,
}: {
  canSave: boolean;
  isSaving: boolean;
  onDiscard: () => void;
  onSave: () => void;
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-50 border-t border-[color:var(--border-strong)] bg-surface-inverse shadow-lg">
      <div className="mx-auto flex max-w-container flex-col gap-3 px-gutter py-3 sm:flex-row sm:items-center sm:justify-between">
        <span className="flex items-center gap-[9px] text-sm text-content-on-dark">
          <span className="h-2 w-2 rounded-pill bg-accent shadow-[0_0_0_3px_rgb(var(--amber-500-rgb)_/_0.22)]" />
          Unsaved changes
        </span>
        <div className="flex flex-wrap gap-[10px]">
          <Button disabled={isSaving} size="sm" type="button" variant="ghost" onClick={onDiscard}>
            Discard
          </Button>
          <Button disabled={!canSave} size="sm" type="button" variant="accent" onClick={onSave}>
            <Save aria-hidden="true" />
            {isSaving ? "Saving" : "Save changes"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SettingsToast({ message }: { message: string }) {
  return (
    <div
      aria-live="polite"
      className="fixed left-1/2 top-[76px] z-[60] flex -translate-x-1/2 items-center gap-2 rounded-sm border border-bd-green bg-fill-green px-[14px] py-[9px] text-sm text-soft-green shadow-md"
      role="status"
    >
      <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
      {message}
    </div>
  );
}
