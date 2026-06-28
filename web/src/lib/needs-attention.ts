import type { OptOutRecord } from "./api";

export type AttentionViewState = "loading" | "error" | "empty" | "review";

type AttentionRecord = Pick<OptOutRecord, "broker_name" | "notes" | "status" | "thread_id">;

export interface AttentionGuidance {
  title: string;
  plainLanguage: string;
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
      plainLanguage: `${record.broker_name} declined the opt-out request. The saved reply below should explain what stopped the request.`,
      recommendedStep:
        "Read the reply before retrying. Retry only after changing the request details, or mark it handled if there is no follow-up left.",
    };
  }

  if (record.status === "FAILED") {
    return {
      title: "Retry after checking details",
      plainLanguage: `Smokescreen could not finish ${record.broker_name} automatically. This usually means the broker reply or contact details need a quick check.`,
      recommendedStep:
        "Check the broker reply and contact information. Retry when the issue is fixed, or mark it handled if you completed the request elsewhere.",
    };
  }

  return {
    title: "Review the broker reply",
    plainLanguage: `Smokescreen saved ${record.broker_name}'s reply because it could not safely decide the next step on its own.`,
    recommendedStep:
      "Open the source email and look for a request, confirmation, or rejection. If you resolve it yourself, mark it handled. If Smokescreen should try again, retry the request.",
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
    retry: isRetrying ? "Retrying" : "Retry request",
    sourceEmail: "Open source email",
  };
}
