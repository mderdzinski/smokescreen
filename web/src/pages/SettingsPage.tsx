import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Brain,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Circle,
  Eye,
  EyeOff,
  KeyRound,
  Mail,
  Plus,
  Plug,
  RefreshCcw,
  RotateCcw,
  Save,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  UserRound,
  X,
} from "lucide-react";
import { useLocation } from "react-router-dom";

import { ErrorState, LoadingState } from "../components/status-state";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { TrustedSendersSection } from "../components/trusted-senders-section";
import { Card } from "../components/ui/card";
import { StatusPill } from "../components/ui/status-pill";
import { Switch } from "../components/ui/switch";
import { TextField } from "../components/ui/text-field";
import {
  api,
  type AdvancedSettings,
  type AiProvider,
  type FriendlySettings,
  type SettingsUpdate,
  type VerificationAddress,
  type VerificationDocument,
  type VerificationProfile,
} from "../lib/api";
import {
  useAdvancedSettings,
  usePendingWhitelist,
  useSettings,
  useVerificationProfile,
} from "../lib/queries";
import { cn } from "../lib/utils";

const REREQUEST_INTERVAL_MIN_DAYS = 7;
const REREQUEST_INTERVAL_MAX_DAYS = 365;
const STATE_TIMEOUT_MIN_DAYS = 1;
const STATE_TIMEOUT_MAX_DAYS = 90;

type SettingsSectionId =
  | "identity"
  | "verification-profile"
  | "connections"
  | "trusted"
  | "cadence"
  | "advanced";

type SettingsDraft = {
  sender_name: string;
  sender_email: string;
  gmail_connected: boolean;
  rerequest_interval_days: number;
  state_timeout_days: number;
  poll_label: string;
  max_retries: number;
  dry_run: boolean;
  ai_provider: AiProvider;
  anthropic_api_key: string;
  anthropic_model: string;
  gemini_model: string;
  gemini_project: string;
};

type SaveRequest = {
  payload: SettingsUpdate;
  snapshot: SettingsDraft;
};

function draftFromSettings(settings: FriendlySettings, advanced: AdvancedSettings): SettingsDraft {
  return normalizeDraft({
    dry_run: advanced.dry_run,
    gmail_connected: settings.gmail_connected,
    ai_provider: settings.ai_provider ?? advanced.ai_provider ?? "gemini",
    anthropic_api_key: "",
    anthropic_model: advanced.anthropic_model ?? "claude-sonnet-4-20250514",
    gemini_model: settings.gemini_model || advanced.gemini_model || "gemini-3.1-flash-lite",
    gemini_project: advanced.gemini_project ?? "",
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
    anthropic_api_key: (draft.anthropic_api_key ?? "").trim(),
    anthropic_model: (draft.anthropic_model ?? "").trim(),
    gemini_model: (draft.gemini_model ?? "").trim(),
    gemini_project: (draft.gemini_project ?? "").trim(),
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

function emptyAddress(): VerificationAddress {
  return {
    street: "",
    city: "",
    state: "",
    zip: "",
    country: "",
  };
}

function emptyDocument(): VerificationDocument {
  return {
    label: "",
    storage_note: "",
  };
}

function emptyVerificationProfile(): VerificationProfile {
  return {
    home_addresses: [emptyAddress()],
    phone_numbers: [""],
    email_aliases: [""],
    documents: [emptyDocument()],
    date_of_birth: null,
    last_four_ssn: null,
    employer_name: null,
    additional_notes: null,
  };
}

function hydrateVerificationProfile(profile?: VerificationProfile | null): VerificationProfile {
  const normalized = normalizeVerificationProfile(profile ?? emptyVerificationProfile());
  return {
    ...normalized,
    home_addresses: normalized.home_addresses.length ? normalized.home_addresses : [emptyAddress()],
    phone_numbers: normalized.phone_numbers.length ? normalized.phone_numbers : [""],
    email_aliases: normalized.email_aliases.length ? normalized.email_aliases : [""],
    documents: normalized.documents.length ? normalized.documents : [emptyDocument()],
  };
}

function normalizeVerificationProfile(profile: VerificationProfile): VerificationProfile {
  return {
    home_addresses: profile.home_addresses
      .map((address) => ({
        street: address.street.trim(),
        city: address.city.trim(),
        state: address.state.trim(),
        zip: address.zip.trim(),
        country: address.country.trim(),
      }))
      .filter((address) =>
        Boolean(address.street || address.city || address.state || address.zip || address.country),
      ),
    phone_numbers: profile.phone_numbers.map((value) => value.trim()).filter(Boolean),
    email_aliases: profile.email_aliases.map((value) => value.trim()).filter(Boolean),
    documents: (profile.documents ?? [])
      .map((document) => ({
        label: document.label.trim(),
        storage_note: document.storage_note.trim(),
      }))
      .filter((document) => Boolean(document.label || document.storage_note)),
    date_of_birth: trimToNull(profile.date_of_birth),
    last_four_ssn: trimToNull(profile.last_four_ssn)?.replace(/\D/g, "").slice(0, 4) ?? null,
    employer_name: trimToNull(profile.employer_name),
    additional_notes: trimToNull(profile.additional_notes),
  };
}

function sameVerificationProfile(
  left: VerificationProfile | null,
  right: VerificationProfile | null,
): boolean {
  if (!left || !right) {
    return true;
  }
  return JSON.stringify(normalizeVerificationProfile(left)) === JSON.stringify(normalizeVerificationProfile(right));
}

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
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
  if (next.ai_provider !== saved.ai_provider) {
    payload.ai_provider = next.ai_provider;
  }
  if (next.gemini_model !== saved.gemini_model) {
    payload.gemini_model = next.gemini_model;
  }
  if (next.gemini_project !== saved.gemini_project) {
    payload.gemini_project = next.gemini_project;
  }
  if (next.anthropic_model !== saved.anthropic_model) {
    payload.anthropic_model = next.anthropic_model;
  }
  if (next.anthropic_api_key) {
    payload.anthropic_api_key = next.anthropic_api_key;
  }
  if (saved.gmail_connected && !next.gmail_connected) {
    payload.gmail_token_json = "";
    payload.gmail_credentials_json = "";
  }

  return { payload, snapshot: { ...next, anthropic_api_key: "" } };
}

function payloadHasChanges(payload: SettingsUpdate): boolean {
  return Object.keys(payload).length > 0;
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const location = useLocation();
  const settingsQuery = useSettings();
  const advancedQuery = useAdvancedSettings();
  const verificationProfileQuery = useVerificationProfile();
  const pendingWhitelistQuery = usePendingWhitelist();
  const settings = settingsQuery.data;
  const advancedSettings = advancedQuery.data;
  const verificationProfile = verificationProfileQuery.data;
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [savedDraft, setSavedDraft] = useState<SettingsDraft | null>(null);
  const [profileDraft, setProfileDraft] = useState<VerificationProfile | null>(null);
  const [savedProfileDraft, setSavedProfileDraft] = useState<VerificationProfile | null>(null);
  const [activeSection, setActiveSection] = useState<SettingsSectionId>("identity");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [showLastFour, setShowLastFour] = useState(false);
  const [message, setMessage] = useState("");
  const sectionRefs = useRef<Record<SettingsSectionId, HTMLElement | null>>({
    advanced: null,
    cadence: null,
    connections: null,
    identity: null,
    trusted: null,
    "verification-profile": null,
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
    if (!verificationProfile) {
      return;
    }
    const nextProfile = hydrateVerificationProfile(verificationProfile);
    setProfileDraft(nextProfile);
    setSavedProfileDraft(nextProfile);
  }, [verificationProfile]);

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

  useEffect(() => {
    const sectionId = location.hash.replace(/^#settings-/, "") as SettingsSectionId;
    if (!sectionId || !(sectionId in sectionRefs.current)) {
      return;
    }
    window.setTimeout(() => goToSection(sectionId), 0);
  }, [location.hash, draft]);

  const saveMutation = useMutation({
    mutationFn: ({ payload }: SaveRequest) => api.updateSettings(payload),
    onSuccess: async (result, { payload, snapshot }) => {
      setDraft(snapshot);
      setSavedDraft(snapshot);
      setMessage(result.restart_required ? "Saved. Restart Smokescreen to apply every change." : "Saved.");
      queryClient.setQueryData<FriendlySettings | undefined>(["settings"], (current) =>
        current
          ? {
              ...current,
              gmail_connected: snapshot.gmail_connected,
              ai_provider: snapshot.ai_provider,
              anthropic_api_key: payload.anthropic_api_key ? "stored" : current.anthropic_api_key,
              gemini_model: snapshot.gemini_model,
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
              ai_provider: snapshot.ai_provider,
              anthropic_model: snapshot.anthropic_model,
              dry_run: snapshot.dry_run,
              gemini_model: snapshot.gemini_model,
              gemini_project: snapshot.gemini_project,
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

  const saveProfileMutation = useMutation({
    mutationFn: (profile: VerificationProfile) => api.putVerificationProfile(profile),
    onSuccess: async () => {
      setMessage("Verification profile saved.");
      await queryClient.invalidateQueries({ queryKey: ["settings", "verification-profile"] });
    },
  });

  function setDraftField<Key extends keyof SettingsDraft>(key: Key, value: SettingsDraft[Key]) {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
    setMessage("");
    saveMutation.reset();
  }

  function setProfileDraftValue(nextProfile: VerificationProfile) {
    setProfileDraft(nextProfile);
    setMessage("");
    saveProfileMutation.reset();
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
    void verificationProfileQuery.refetch();
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

  function saveVerificationProfile() {
    if (!profileDraft) {
      return;
    }
    saveProfileMutation.mutate(normalizeVerificationProfile(profileDraft), {
      onSuccess: (savedProfile) => {
        const hydrated = hydrateVerificationProfile(savedProfile);
        setProfileDraft(hydrated);
        setSavedProfileDraft(hydrated);
        queryClient.setQueryData(["settings", "verification-profile"], savedProfile);
      },
    });
  }

  const settingsLoading =
    (settingsQuery.isLoading && !settings) ||
    (advancedQuery.isLoading && !advancedSettings) ||
    (verificationProfileQuery.isLoading && !verificationProfile) ||
    !draft ||
    !profileDraft;
  const loadError = settingsQuery.error ?? advancedQuery.error ?? verificationProfileQuery.error;
  const pendingCount = pendingWhitelistQuery.data?.length ?? 0;
  const dirty = !sameDraft(savedDraft, draft);
  const profileDirty = !sameVerificationProfile(savedProfileDraft, profileDraft);
  const hasAnthropicKey = Boolean(settings?.anthropic_key_from_secret || settings?.anthropic_api_key);
  const providerReady = Boolean(
    !draft ||
      !savedDraft ||
      draft.ai_provider !== "anthropic" ||
      draft.ai_provider === savedDraft.ai_provider ||
      hasAnthropicKey ||
      draft.anthropic_api_key.trim(),
  );
  const canSave = Boolean(draft && savedDraft && dirty && providerReady && !saveMutation.isPending);
  const saveRequest = draft && savedDraft ? buildSettingsPayload(savedDraft, draft, settings) : null;
  const hasPayloadChanges = saveRequest ? payloadHasChanges(saveRequest.payload) : false;

  const sections: Array<{
    id: SettingsSectionId;
    label: string;
    icon: ReactNode;
    badge?: number;
  }> = [
    { id: "identity", icon: <UserRound aria-hidden="true" className="h-[15px] w-[15px]" />, label: "Identity" },
    {
      id: "verification-profile",
      icon: <ShieldCheck aria-hidden="true" className="h-[15px] w-[15px]" />,
      label: "Verification Profile",
    },
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
      {saveProfileMutation.error ? (
        <ErrorState
          description="Smokescreen could not save the verification profile. Review the fields and try again."
          onAction={() => saveProfileMutation.reset()}
          title="Verification profile was not saved"
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
                The identity, verification profile, connections, and cadence Smokescreen uses to run opt-outs on your behalf.
              </p>
            </div>
            <Button size="sm" type="button" variant="outline" onClick={refreshSettings}>
              <RefreshCcw aria-hidden="true" />
              Refresh
            </Button>
          </div>

          {settingsLoading ? (
            <LoadingState description="Loading your identity, verification profile, Gmail, cadence, and advanced settings." title="Loading settings" />
          ) : null}

          {!settingsLoading && draft && profileDraft ? (
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
                </Card>
              </SettingsSection>

              <SettingsSection refCallback={registerSection("verification-profile")} id="verification-profile">
                <Card pad>
                  <SectionHead
                    description="Only fill out fields you are comfortable sharing with data brokers. Any field you leave blank will not be shared."
                    label="02 · Verification Profile"
                    title="Fields brokers may ask for"
                  />
                  <VerificationProfileForm
                    draft={profileDraft}
                    isSaving={saveProfileMutation.isPending}
                    onChange={setProfileDraftValue}
                    onSave={saveVerificationProfile}
                    profileDirty={profileDirty}
                    showLastFour={showLastFour}
                    onToggleLastFour={() => setShowLastFour((shown) => !shown)}
                  />
                </Card>
              </SettingsSection>

              <SettingsSection refCallback={registerSection("connections")} id="connections">
                <Card pad>
                  <SectionHead
                    description="Smokescreen sends from your inbox and uses an AI model to read broker replies."
                    label="03 · Connections"
                    title="Inbox and AI"
                  />
                  <GmailConnectionRow
                    connectedEmail={settings?.gmail_connected_email}
                    draftConnected={draft.gmail_connected}
                    savedConnected={Boolean(savedDraft?.gmail_connected)}
                    onDisconnect={() => setDraftField("gmail_connected", false)}
                  />
                  <AiProviderPicker
                    draft={draft}
                    hasAnthropicKey={hasAnthropicKey}
                    maskedAnthropicKey={settings?.anthropic_api_key}
                    onChange={setDraftField}
                  />
                </Card>
              </SettingsSection>

              <SettingsSection refCallback={registerSection("trusted")} id="trusted">
                <Card pad>
                  <SectionHead
                    description="Smokescreen only acts on replies from approved addresses. Most are added automatically from the broker registry; review detected senders before their messages are trusted."
                    label="04 · Trusted senders"
                    title="Who Smokescreen trusts"
                  />
                  <TrustedSendersSection />
                </Card>
              </SettingsSection>

              <SettingsSection refCallback={registerSection("cadence")} id="cadence">
                <Card pad>
                  <SectionHead
                    description="Tune how persistent Smokescreen is with brokers."
                    label="05 · Cadence"
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

function VerificationProfileForm({
  draft,
  isSaving,
  onChange,
  onSave,
  onToggleLastFour,
  profileDirty,
  showLastFour,
}: {
  draft: VerificationProfile;
  isSaving: boolean;
  onChange: (profile: VerificationProfile) => void;
  onSave: () => void;
  onToggleLastFour: () => void;
  profileDirty: boolean;
  showLastFour: boolean;
}) {
  function setAddress(index: number, key: keyof VerificationAddress, value: string) {
    const home_addresses = draft.home_addresses.map((address, currentIndex) =>
      currentIndex === index ? { ...address, [key]: value } : address,
    );
    onChange({ ...draft, home_addresses });
  }

  function addAddress() {
    onChange({ ...draft, home_addresses: [...draft.home_addresses, emptyAddress()] });
  }

  function removeAddress(index: number) {
    const home_addresses = draft.home_addresses.filter((_, currentIndex) => currentIndex !== index);
    onChange({ ...draft, home_addresses: home_addresses.length ? home_addresses : [emptyAddress()] });
  }

  function setDocument(index: number, key: keyof VerificationDocument, value: string) {
    const documents = draft.documents.map((document, currentIndex) =>
      currentIndex === index ? { ...document, [key]: value } : document,
    );
    onChange({ ...draft, documents });
  }

  function addDocument() {
    onChange({ ...draft, documents: [...draft.documents, emptyDocument()] });
  }

  function removeDocument(index: number) {
    const documents = draft.documents.filter((_, currentIndex) => currentIndex !== index);
    onChange({ ...draft, documents: documents.length ? documents : [emptyDocument()] });
  }

  function setStringList(key: "phone_numbers" | "email_aliases", index: number, value: string) {
    const nextValues = draft[key].map((item, currentIndex) => (currentIndex === index ? value : item));
    onChange({ ...draft, [key]: nextValues });
  }

  function addStringListItem(key: "phone_numbers" | "email_aliases") {
    onChange({ ...draft, [key]: [...draft[key], ""] });
  }

  function removeStringListItem(key: "phone_numbers" | "email_aliases", index: number) {
    const nextValues = draft[key].filter((_, currentIndex) => currentIndex !== index);
    onChange({ ...draft, [key]: nextValues.length ? nextValues : [""] });
  }

  return (
    <div className="grid gap-6">
      <div className="grid gap-[14px]">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-display text-base font-semibold text-content-strong">Home addresses</h3>
          <Button size="sm" type="button" variant="outline" onClick={addAddress}>
            <Plus aria-hidden="true" />
            Add address
          </Button>
        </div>
        <div className="grid gap-3">
          {draft.home_addresses.map((address, index) => (
            <div className="rounded-sm border border-border bg-surface-sunken p-3" key={index}>
              <div className="mb-3 flex items-center justify-between gap-2">
                <span className="ss-label">Address {index + 1}</span>
                <Button
                  aria-label={`Remove address ${index + 1}`}
                  iconOnly
                  onClick={() => removeAddress(index)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <X aria-hidden="true" />
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField
                  className="sm:col-span-2"
                  label="Street"
                  value={address.street}
                  onChange={(event) => setAddress(index, "street", event.currentTarget.value)}
                />
                <TextField
                  label="City"
                  value={address.city}
                  onChange={(event) => setAddress(index, "city", event.currentTarget.value)}
                />
                <TextField
                  label="State"
                  value={address.state}
                  onChange={(event) => setAddress(index, "state", event.currentTarget.value)}
                />
                <TextField
                  label="ZIP"
                  value={address.zip}
                  onChange={(event) => setAddress(index, "zip", event.currentTarget.value)}
                />
                <TextField
                  label="Country"
                  value={address.country}
                  onChange={(event) => setAddress(index, "country", event.currentTarget.value)}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <RepeatableTextList
          addLabel="Add phone"
          label="Phone numbers"
          onAdd={() => addStringListItem("phone_numbers")}
          onRemove={(index) => removeStringListItem("phone_numbers", index)}
          onValueChange={(index, value) => setStringList("phone_numbers", index, value)}
          placeholder="+1 555 010 1234"
          values={draft.phone_numbers}
        />
        <RepeatableTextList
          addLabel="Add email"
          label="Email aliases"
          onAdd={() => addStringListItem("email_aliases")}
          onRemove={(index) => removeStringListItem("email_aliases", index)}
          onValueChange={(index, value) => setStringList("email_aliases", index, value)}
          placeholder="old-email@example.com"
          type="email"
          values={draft.email_aliases}
        />
      </div>

      <div className="grid gap-[14px]">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-display text-base font-semibold text-content-strong">Documents</h3>
          <Button size="sm" type="button" variant="outline" onClick={addDocument}>
            <Plus aria-hidden="true" />
            Add document
          </Button>
        </div>
        <div className="grid gap-3">
          {draft.documents.map((document, index) => (
            <div className="rounded-sm border border-border bg-surface-sunken p-3" key={index}>
              <div className="mb-3 flex items-center justify-between gap-2">
                <span className="ss-label">Document {index + 1}</span>
                <Button
                  aria-label={`Remove document ${index + 1}`}
                  iconOnly
                  onClick={() => removeDocument(index)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <X aria-hidden="true" />
                </Button>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <TextField
                  label="Document label"
                  placeholder="Utility Bill"
                  value={document.label}
                  onChange={(event) => setDocument(index, "label", event.currentTarget.value)}
                />
                <TextField
                  label="Storage note"
                  placeholder="Offline file"
                  value={document.storage_note}
                  onChange={(event) => setDocument(index, "storage_note", event.currentTarget.value)}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <TextField
          label="Date of birth"
          placeholder="YYYY-MM-DD"
          type="text"
          value={draft.date_of_birth ?? ""}
          onChange={(event) => onChange({ ...draft, date_of_birth: event.currentTarget.value })}
        />
        <div className="grid gap-2">
          <span className="ss-label">Last four SSN</span>
          <div className="flex gap-2">
            <input
              aria-label="Last four SSN"
              className="h-[38px] min-w-0 flex-1 rounded-sm border border-[color:var(--border-field)] bg-surface-field px-3 text-sm text-content-strong outline-none transition-[border-color,box-shadow] duration-fast ease-standard placeholder:text-content-faint hover:border-[color:var(--border-strong)] focus-visible:border-ring focus-visible:shadow-focus"
              inputMode="numeric"
              maxLength={4}
              type={showLastFour ? "text" : "password"}
              value={draft.last_four_ssn ?? ""}
              onChange={(event) =>
                onChange({
                  ...draft,
                  last_four_ssn: event.currentTarget.value.replace(/\D/g, "").slice(0, 4),
                })
              }
            />
            <Button
              aria-label={showLastFour ? "Hide last four SSN" : "Reveal last four SSN"}
              iconOnly
              onClick={onToggleLastFour}
              size="md"
              type="button"
              variant="outline"
            >
              {showLastFour ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            </Button>
          </div>
        </div>
        <TextField
          label="Employer name"
          value={draft.employer_name ?? ""}
          onChange={(event) => onChange({ ...draft, employer_name: event.currentTarget.value })}
        />
      </div>

      <TextField
        label="Additional notes"
        multiline
        value={draft.additional_notes ?? ""}
        onChange={(event) => onChange({ ...draft, additional_notes: event.currentTarget.value })}
      />

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <Button disabled={!profileDirty || isSaving} onClick={onSave} type="button">
          <Save aria-hidden="true" />
          {isSaving ? "Saving" : "Save profile"}
        </Button>
        {profileDirty ? <span className="text-xs text-content-muted">Unsaved verification profile changes</span> : null}
      </div>
    </div>
  );
}

function RepeatableTextList({
  addLabel,
  label,
  onAdd,
  onRemove,
  onValueChange,
  placeholder,
  type = "text",
  values,
}: {
  addLabel: string;
  label: string;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onValueChange: (index: number, value: string) => void;
  placeholder?: string;
  type?: string;
  values: string[];
}) {
  return (
    <div className="grid gap-[10px]">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-display text-base font-semibold text-content-strong">{label}</h3>
        <Button size="sm" type="button" variant="outline" onClick={onAdd}>
          <Plus aria-hidden="true" />
          {addLabel}
        </Button>
      </div>
      <div className="grid gap-2">
        {values.map((value, index) => (
          <div className="flex gap-2" key={index}>
            <TextField
              className="flex-1"
              aria-label={`${label} ${index + 1}`}
              placeholder={placeholder}
              type={type}
              value={value}
              onChange={(event) => onValueChange(index, event.currentTarget.value)}
            />
            <Button
              aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
              iconOnly
              onClick={() => onRemove(index)}
              size="md"
              type="button"
              variant="ghost"
            >
              <X aria-hidden="true" />
            </Button>
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
            <Button disabled size="sm" type="button" variant="secondary">
              <Mail aria-hidden="true" />
              Connect Gmail
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function AiProviderPicker({
  draft,
  hasAnthropicKey,
  maskedAnthropicKey,
  onChange,
}: {
  draft: SettingsDraft;
  hasAnthropicKey: boolean;
  maskedAnthropicKey?: string;
  onChange: <Key extends keyof SettingsDraft>(key: Key, value: SettingsDraft[Key]) => void;
}) {
  const providers = [
    {
      icon: <Sparkles aria-hidden="true" className="h-4 w-4" />,
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
          label={draft.ai_provider === "gemini" ? "Active · Vertex AI" : hasAnthropicKey ? "Key on file" : "Key required"}
          pulse={false}
          tone={draft.ai_provider === "anthropic" && !hasAnthropicKey ? "attention" : "done"}
        />
      </div>
      <div className="grid gap-[10px] sm:grid-cols-2">
        {providers.map((provider) => {
          const selected = provider.id === draft.ai_provider;
          return (
            <button
              aria-pressed={selected}
              className={cn(
                "rounded-sm border border-[color:var(--border-strong)] bg-transparent p-[13px] text-left transition-[background,border-color,box-shadow] duration-fast ease-standard hover:border-brand focus-visible:outline-none focus-visible:shadow-focus",
                selected && "border-brand bg-fill-olive shadow-focus",
              )}
              key={provider.id}
              onClick={() => onChange("ai_provider", provider.id)}
              type="button"
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
                {selected ? (
                  <CheckCircle2 aria-hidden="true" className="h-[18px] w-[18px] text-brand-strong" />
                ) : (
                  <Circle aria-hidden="true" className="h-[18px] w-[18px] text-content-faint" />
                )}
              </div>
              <div className="mt-2">
                <Badge variant={selected ? "olive" : "neutral"}>{provider.tag}</Badge>
              </div>
            </button>
          );
        })}
      </div>

      {draft.ai_provider === "gemini" ? (
        <div className="mt-3 grid gap-3 rounded-sm border border-border bg-surface-sunken p-4">
          <StatusPill label="Active · Vertex AI" pulse={false} tone="done" />
          <p className="text-sm leading-relaxed text-content-body">
            Smokescreen runs on your Google Cloud project's Vertex AI credentials - no API key required.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="GCP project"
              placeholder="my-gcp-project"
              value={draft.gemini_project}
              onChange={(event) => onChange("gemini_project", event.currentTarget.value)}
            />
            <TextField
              label="Gemini model"
              placeholder="gemini-3.1-flash-lite"
              value={draft.gemini_model}
              onChange={(event) => onChange("gemini_model", event.currentTarget.value)}
            />
          </div>
        </div>
      ) : (
        <div className="mt-3 grid gap-3 rounded-sm border border-border bg-surface-sunken p-4">
          <StatusPill label={hasAnthropicKey ? "Key on file" : "Key required"} pulse={false} tone={hasAnthropicKey ? "done" : "attention"} />
          <p className="text-sm leading-relaxed text-content-body">
            Prefer Claude? Add an Anthropic API key and Smokescreen will use it instead of Vertex AI.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              icon={<KeyRound aria-hidden="true" />}
              label="Anthropic API key"
              placeholder={maskedAnthropicKey || "sk-ant-..."}
              type="password"
              value={draft.anthropic_api_key}
              onChange={(event) => onChange("anthropic_api_key", event.currentTarget.value)}
            />
            <TextField
              label="Claude model"
              placeholder="claude-sonnet-4-20250514"
              value={draft.anthropic_model}
              onChange={(event) => onChange("anthropic_model", event.currentTarget.value)}
            />
          </div>
        </div>
      )}
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
