import type { OptOutRecord } from "./api";

export type AttentionViewState = "loading" | "error" | "empty" | "review";

type AttentionRecord = Pick<OptOutRecord, "broker_name" | "notes" | "status" | "thread_id">;

export interface AttentionGuidance {
  title: string;
  recommendedStep: string;
}

export function getAttentionViewState({
  hasError,
  isLoading,
  recordCount,
}: {
  hasError: boolean;
  isLoading: boolean;
  recordCount: number;
}): AttentionViewState {
  if (hasError) {
    return "error";
  }
  if (isLoading) {
    return "loading";
  }
  if (recordCount === 0) {
    return "empty";
  }
  return "review";
}

export function getAttentionGuidance(record: AttentionRecord): AttentionGuidance {
  if (record.status === "REJECTED") {
    return {
      title: "Broker rejected the request",
      recommendedStep: "Read the reply, change the request details, then retry — or mark handled.",
    };
  }

  if (record.status === "FAILED") {
    return {
      title: "Retry after checking details",
      recommendedStep: "Check the broker contact and reply. Retry when fixed, or mark handled.",
    };
  }

  return {
    title: "Review the broker reply",
    recommendedStep: "Open the source email. Resolve it yourself and mark handled, or retry the request.",
  };
}

export function getBrokerReplyText(record: AttentionRecord): string {
  return (
    record.notes.trim() ||
    "No saved broker reply is available for this item. Open the source email if a thread is linked, then choose the safest next action."
  );
}

export function getSourceEmailHref(threadId: string | null): string | null {
  const trimmedThreadId = threadId?.trim();
  if (!trimmedThreadId) {
    return null;
  }
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(trimmedThreadId)}`;
}

export function getAttentionActionLabels({
  isMarkingHandled,
  isRetrying,
}: {
  isMarkingHandled: boolean;
  isRetrying: boolean;
}) {
  return {
    markHandled: isMarkingHandled ? "Marking handled" : "Mark handled",
    retry: isRetrying ? "Retrying" : "Retry",
    sourceEmail: "Source email",
  };
}
