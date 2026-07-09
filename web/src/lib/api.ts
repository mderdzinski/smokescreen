const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

export type BrokerStatus =
  | "PENDING"
  | "INITIAL_SENT"
  | "INITIAL_SENT_PINGED"
  | "AWAITING_RESPONSE"
  | "AWAITING_RESPONSE_PINGED"
  | "INFO_REQUESTED"
  | "INFO_REQUESTED_PINGED"
  | "FOLLOW_UP_SENT"
  | "FOLLOW_UP_SENT_PINGED"
  | "COMPLETED"
  | "REJECTED"
  | "REJECTED_REBUTTED"
  | "NEEDS_MANUAL"
  | "FAILED";
export type OptOutStatusFilter = BrokerStatus | "needs_attention";

interface ListOptOutsOptions {
  includeDisabled?: boolean;
}

export interface NeedsManualReason {
  reason_code: string;
  short_summary: string;
  broker_reply_excerpt: string;
  raw_reply_body?: string | null;
  classifier_output: Record<string, unknown>;
  missing_fields: string[];
  transitioned_at: string;
}

export interface StateTransition {
  from_status: string;
  to_status: string;
  transitioned_at: string;
  reason: string | null;
  message_id: string | null;
}

export interface ThreadHistoryEntry {
  cycle_number: number;
  thread_ids: string[];
  started_at: string;
  ended_at: string;
  final_status: string;
}

export interface OptOutRecord {
  broker_id: string;
  status: BrokerStatus;
  previous_status: BrokerStatus | null;
  retries: number;
  thread_id: string | null;
  thread_ids?: string[];
  thread_history?: ThreadHistoryEntry[];
  last_message_id: string | null;
  last_completed_at: string | null;
  notes: string;
  needs_manual_reason: NeedsManualReason | null;
  requested_fields: string[];
  missing_fields: string[];
  requested_other_details: string;
  state_history: StateTransition[];
  created_at: string;
  updated_at: string;
  broker_name: string;
  broker_domain: string;
  broker_privacy_email: string;
}

export interface ExtendedStats {
  total: number;
  by_status: Partial<Record<BrokerStatus, number>>;
  completed_count: number;
  success_rate: number;
  avg_completion_hours: number | null;
  needs_attention: number;
  recent_activity: Array<{
    broker_id: string;
    broker_name: string;
    status: BrokerStatus;
    updated_at: string;
  }>;
}

export interface Broker {
  id: string;
  name: string;
  domain: string;
  privacy_email: string;
  aliases: string[];
  notes: string;
}

export interface BrokerInput {
  id?: string;
  name: string;
  domain: string;
  privacy_email: string;
  aliases: string[];
  notes: string;
}

export interface BrokerUpdate {
  name?: string;
  domain?: string;
  privacy_email?: string;
  aliases?: string[];
  notes?: string;
}

export interface BrokerImportInput {
  file: File;
  name_col?: string;
  email_col?: string;
  domain_col?: string;
  id_col?: string;
  notes_col?: string;
}

export interface BrokerImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

export interface OutreachResult {
  status: "sent";
  processed: string[];
  processed_count: number;
  dry_run: boolean;
}

export interface PollQueueResult {
  status: "queued";
  message: string;
}

export type AiProvider = "anthropic" | "gemini";

export interface VerificationAddress {
  street: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

export interface VerificationDocument {
  label: string;
  storage_note: string;
}

export interface VerificationProfile {
  home_addresses: VerificationAddress[];
  phone_numbers: string[];
  email_aliases: string[];
  documents: VerificationDocument[];
  date_of_birth: string | null;
  last_four_ssn: string | null;
  employer_name: string | null;
  additional_notes: string | null;
}

export interface FriendlySettings {
  sender_email: string;
  sender_name: string;
  anthropic_api_key: string;
  rerequest_interval_days: number;
  state_timeout_days: number;
  identity_configured: boolean;
  gmail_token_available: boolean;
  gmail_credentials_available: boolean;
  gmail_connected: boolean;
  gmail_connected_email: string;
  sender_email_from_env: boolean;
  sender_name_from_env: boolean;
  rerequest_interval_days_from_env: boolean;
  state_timeout_days_from_env: boolean;
  ai_provider: AiProvider;
  anthropic_key_from_secret: boolean;
  gmail_configured: boolean;
  gemini_model: string;
}

export interface AdvancedSettings {
  ai_provider: AiProvider;
  poll_label: string;
  max_retries: number;
  dry_run: boolean;
  anthropic_model: string;
  gemini_model: string;
  gemini_project: string;
  gemini_location: string;
}

export type SettingsUpdate = Partial<
  Pick<
    FriendlySettings,
    "sender_email" | "sender_name" | "anthropic_api_key" | "rerequest_interval_days" | "state_timeout_days"
  > &
    AdvancedSettings & {
      gmail_token_json: string;
      gmail_credentials_json: string;
    }
>;

export interface WhitelistEntry {
  id: number;
  broker_id: string;
  email: string;
  source: "registry" | "manual";
  added_at: string;
}

export interface PendingWhitelistEntry {
  id: number;
  broker_id: string | null;
  email: string;
  message_subject: string;
  message_snippet: string;
  detected_at: string;
  status: "pending";
}

export class ApiRequestError extends Error {
  retryAfter: string | null;
  status: number;

  constructor(message: string, status: number, retryAfter: string | null) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function responseErrorMessage(response: Response): Promise<string> {
  const fallback = `Request failed with ${response.status}`;
  const text = await response.text();
  if (!text) {
    return fallback;
  }

  try {
    const body = JSON.parse(text) as unknown;
    if (body && typeof body === "object" && "detail" in body) {
      const detail = (body as { detail: unknown }).detail;
      if (typeof detail === "string") {
        return detail;
      }
      if (detail && typeof detail === "object" && "message" in detail) {
        const message = (detail as { message: unknown }).message;
        if (typeof message === "string") {
          return message;
        }
      }
    }
  } catch {
    return text;
  }

  return text || fallback;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    throw new ApiRequestError(
      await responseErrorMessage(response),
      response.status,
      response.headers.get("Retry-After"),
    );
  }

  return (await response.json()) as T;
}

async function requestVoid(path: string, init?: RequestInit): Promise<void> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    throw new ApiRequestError(
      await responseErrorMessage(response),
      response.status,
      response.headers.get("Retry-After"),
    );
  }
}

function jsonRequest<T>(method: "POST" | "PUT", body: T): RequestInit {
  return {
    method,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

function brokerImportForm(input: BrokerImportInput): FormData {
  const form = new FormData();
  form.append("file", input.file);
  form.append("name_col", input.name_col ?? "");
  form.append("email_col", input.email_col ?? "");
  form.append("domain_col", input.domain_col ?? "");
  form.append("id_col", input.id_col ?? "");
  form.append("notes_col", input.notes_col ?? "");
  return form;
}

export interface AppVersion {
  version: string;
}

export interface BrokerSelections {
  enabled_broker_ids: string[];
  selection_document_size_bytes: number;
  selection_size_warning: string | null;
}

export const api = {
  getVersion: () => requestJson<AppVersion>("/api/version"),
  listBrokers: () => requestJson<Broker[]>("/api/brokers"),
  getBrokerSelections: () => requestJson<BrokerSelections>("/api/brokers/selections"),
  putBrokerSelections: (enabledBrokerIds: string[]) =>
    requestJson<BrokerSelections>(
      "/api/brokers/selections",
      jsonRequest("PUT", { enabled_broker_ids: enabledBrokerIds }),
    ),
  createBroker: (input: BrokerInput) => requestJson<Broker>("/api/brokers", jsonRequest("POST", input)),
  updateBroker: (brokerId: string, input: BrokerUpdate) =>
    requestJson<Broker>(`/api/brokers/${encodeURIComponent(brokerId)}`, jsonRequest("PUT", input)),
  deleteBroker: (brokerId: string) =>
    requestVoid(`/api/brokers/${encodeURIComponent(brokerId)}`, {
      method: "DELETE",
    }),
  importBrokersCsv: (input: BrokerImportInput) =>
    requestJson<BrokerImportResult>("/api/brokers/import", {
      method: "POST",
      body: brokerImportForm(input),
    }),
  getExtendedStats: () => requestJson<ExtendedStats>("/api/stats/extended"),
  getSettings: () => requestJson<FriendlySettings>("/api/settings"),
  getVerificationProfile: () => requestJson<VerificationProfile>("/api/settings/verification-profile"),
  putVerificationProfile: (profile: VerificationProfile) =>
    requestJson<VerificationProfile>(
      "/api/settings/verification-profile",
      jsonRequest("PUT", profile),
    ),
  getAdvancedSettings: () => requestJson<AdvancedSettings>("/api/settings/advanced"),
  updateSettings: (settings: SettingsUpdate) =>
    requestJson<{ status: "saved"; restart_required: boolean }>("/api/settings", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(settings),
    }),
  runOutreach: (brokerIds: string[]) =>
    requestJson<OutreachResult>("/api/outreach", jsonRequest("POST", { broker_ids: brokerIds })),
  queuePoll: () =>
    requestJson<PollQueueResult>("/api/poll", {
      method: "POST",
    }),
  listOptOuts: (status?: OptOutStatusFilter, options: ListOptOutsOptions = {}) => {
    const params = new URLSearchParams();
    if (status) {
      params.set("status", status);
    }
    if (options.includeDisabled) {
      params.set("include_disabled", "true");
    }
    const query = params.toString();
    return requestJson<OptOutRecord[]>(`/api/optouts${query ? `?${query}` : ""}`);
  },
  resetOptOut: (brokerId: string) =>
    requestJson<{ status: "reset"; broker_id: string }>(`/api/optouts/${encodeURIComponent(brokerId)}/reset`, {
      method: "POST",
    }),
  retryClassification: (brokerId: string) =>
    requestJson<OptOutRecord>(`/api/optouts/${encodeURIComponent(brokerId)}/retry_classification`, {
      method: "POST",
    }),
  rescanClassification: (brokerId: string) =>
    requestJson<OptOutRecord>(`/api/optouts/${encodeURIComponent(brokerId)}/rescan`, {
      method: "POST",
    }),
  acceptRejection: (brokerId: string) =>
    requestJson<OptOutRecord>(`/api/optouts/${encodeURIComponent(brokerId)}/accept_rejection`, {
      method: "POST",
    }),
  escalateRejection: (brokerId: string, context: string) =>
    requestJson<OptOutRecord>(
      `/api/optouts/${encodeURIComponent(brokerId)}/escalate_rejection`,
      jsonRequest("POST", { context }),
    ),
  markOptOutHandled: (brokerId: string) =>
    requestJson<{ status: "handled"; broker_id: string }>(
      `/api/optouts/${encodeURIComponent(brokerId)}/handled`,
      {
        method: "POST",
      },
    ),
  listWhitelist: () => requestJson<WhitelistEntry[]>("/api/whitelist"),
  addWhitelist: (data: { broker_id: string; email: string }) =>
    requestJson<WhitelistEntry>("/api/whitelist", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    }),
  deleteWhitelist: (entryId: number) =>
    requestVoid(`/api/whitelist/${encodeURIComponent(String(entryId))}`, {
      method: "DELETE",
    }),
  listPendingWhitelist: () => requestJson<PendingWhitelistEntry[]>("/api/whitelist/pending"),
  approvePendingWhitelist: (entryId: number) =>
    requestJson<WhitelistEntry>(`/api/whitelist/pending/${encodeURIComponent(String(entryId))}/approve`, {
      method: "POST",
    }),
  rejectPendingWhitelist: (entryId: number) =>
    requestJson<{ status: "rejected"; id: number }>(
      `/api/whitelist/pending/${encodeURIComponent(String(entryId))}/reject`,
      {
        method: "POST",
      },
    ),
};
