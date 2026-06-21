const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

export type BrokerStatus =
  | "PENDING"
  | "INITIAL_SENT"
  | "AWAITING_RESPONSE"
  | "IDENTITY_REQUESTED"
  | "IDENTITY_SENT"
  | "COMPLETED"
  | "REJECTED"
  | "NEEDS_MANUAL"
  | "FAILED";

export interface OptOutRecord {
  broker_id: string;
  status: BrokerStatus;
  retries: number;
  thread_id: string | null;
  last_message_id: string | null;
  notes: string;
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
  id: string;
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
  name_col: string;
  email_col: string;
  domain_col: string;
  id_col: string;
  notes_col: string;
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

export interface FriendlySettings {
  sender_email: string;
  sender_name: string;
  identity_docs_dir: string;
  anthropic_api_key: string;
  gmail_connected: boolean;
  gmail_connected_email: string;
}

export interface AdvancedSettings {
  poll_label: string;
  max_retries: number;
  rerequest_interval_days: number;
  dry_run: boolean;
  anthropic_model: string;
}

export type SettingsUpdate = Partial<
  Pick<FriendlySettings, "sender_email" | "sender_name" | "identity_docs_dir" | "anthropic_api_key"> &
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

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed with ${response.status}`);
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
    const message = await response.text();
    throw new Error(message || `Request failed with ${response.status}`);
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
  form.append("name_col", input.name_col);
  form.append("email_col", input.email_col);
  form.append("domain_col", input.domain_col);
  form.append("id_col", input.id_col);
  form.append("notes_col", input.notes_col);
  return form;
}

export const api = {
  listBrokers: () => requestJson<Broker[]>("/api/brokers"),
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
  listOptOuts: (status?: BrokerStatus) => {
    const params = status ? `?status=${encodeURIComponent(status)}` : "";
    return requestJson<OptOutRecord[]>(`/api/optouts${params}`);
  },
  resetOptOut: (brokerId: string) =>
    requestJson<{ status: "reset"; broker_id: string }>(`/api/optouts/${encodeURIComponent(brokerId)}/reset`, {
      method: "POST",
    }),
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
