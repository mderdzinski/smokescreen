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

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      Accept: "application/json",
      ...init?.headers,
    },
    ...init,
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed with ${response.status}`);
  }

  return (await response.json()) as T;
}

export const api = {
  getExtendedStats: () => requestJson<ExtendedStats>("/api/stats/extended"),
  listOptOuts: () => requestJson<OptOutRecord[]>("/api/optouts"),
};
