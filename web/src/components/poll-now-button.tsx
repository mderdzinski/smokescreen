import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Clock3 } from "lucide-react";

import { ApiRequestError, api } from "../lib/api";
import { cn } from "../lib/utils";
import { Button, type ButtonProps } from "./ui/button";

const POLL_SUCCESS_MESSAGE = "Poll queued. State will update within about a minute.";
const POLL_RATE_LIMIT_MESSAGE = "Please wait a moment before triggering another poll.";
const POLL_ERROR_MESSAGE = "Smokescreen could not queue a poll run.";

type PollToast = {
  message: string;
  tone: "danger" | "success" | "warning";
};

interface PollNowButtonProps {
  className?: string;
  size?: ButtonProps["size"];
  variant?: ButtonProps["variant"];
}

export function PollNowButton({
  className,
  size = "sm",
  variant = "secondary",
}: PollNowButtonProps) {
  const queryClient = useQueryClient();
  const [toast, setToast] = useState<PollToast | null>(null);
  const pollMutation = useMutation({
    mutationFn: api.queuePoll,
    onSuccess: async () => {
      setToast({ message: POLL_SUCCESS_MESSAGE, tone: "success" });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["opt-outs"] }),
        queryClient.invalidateQueries({ queryKey: ["extended-stats"] }),
      ]);
    },
    onError: (error) => {
      if (error instanceof ApiRequestError && error.status === 429) {
        setToast({ message: POLL_RATE_LIMIT_MESSAGE, tone: "warning" });
        return;
      }
      setToast({ message: POLL_ERROR_MESSAGE, tone: "danger" });
    },
  });

  useEffect(() => {
    if (!toast) {
      return undefined;
    }

    const timeout = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  return (
    <div className={cn("relative inline-flex", className)}>
      <Button
        disabled={pollMutation.isPending}
        onClick={() => {
          setToast(null);
          pollMutation.mutate();
        }}
        size={size}
        type="button"
        variant={variant}
      >
        <Clock3
          aria-hidden="true"
          className={cn(pollMutation.isPending && "animate-spin")}
        />
        {pollMutation.isPending ? "Polling" : "Poll now"}
      </Button>
      {toast ? (
        <div
          aria-live={toast.tone === "success" ? "polite" : "assertive"}
          className={cn(
            "absolute right-0 top-[calc(100%+8px)] z-30 w-[min(320px,calc(100vw-32px))] rounded-sm border px-3 py-2 text-sm font-medium shadow-lg",
            toast.tone === "success" && "border-bd-green bg-fill-green text-soft-green",
            toast.tone === "warning" && "border-bd-amber bg-fill-amber text-soft-amber",
            toast.tone === "danger" && "border-bd-rust bg-fill-rust text-soft-rust",
          )}
          role={toast.tone === "success" ? "status" : "alert"}
        >
          {toast.message}
        </div>
      ) : null}
    </div>
  );
}
