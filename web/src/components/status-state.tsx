import type { ReactNode } from "react";
import { AlertTriangle, LoaderCircle, RefreshCcw } from "lucide-react";

import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { EmptyState as GlyphEmptyState } from "./ui/motion";

type StatusStateTone = "default" | "error";

interface StatusStateProps {
  actionLabel?: string;
  children?: ReactNode;
  className?: string;
  description: string;
  icon: ReactNode;
  onAction?: () => void;
  title: string;
  tone?: StatusStateTone;
}

function StatusState({
  actionLabel,
  children,
  className,
  description,
  icon,
  onAction,
  title,
  tone = "default",
}: StatusStateProps) {
  return (
    <div
      className={cn(
        "rounded-md border bg-card px-5 py-8 text-center shadow-sm",
        tone === "error" && "border-destructive/40 bg-destructive/10",
        className,
      )}
    >
      <div
        className={cn(
          "mx-auto flex h-10 w-10 items-center justify-center rounded-md bg-secondary text-secondary-foreground",
          tone === "error" && "bg-destructive/10 text-destructive",
        )}
      >
        {icon}
      </div>
      <h3 className="mt-4 text-base font-semibold tracking-normal text-foreground">{title}</h3>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">{description}</p>
      {children ? <div className="mt-4">{children}</div> : null}
      {onAction && actionLabel ? (
        <Button className="mt-4" type="button" variant={tone === "error" ? "outline" : "secondary"} onClick={onAction}>
          <RefreshCcw className="h-4 w-4" />
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}

interface LoadingStateProps {
  className?: string;
  description: string;
  title?: string;
}

export function LoadingState({ className, title = "Loading", description }: LoadingStateProps) {
  return (
    <StatusState
      className={className}
      description={description}
      icon={<LoaderCircle className="h-5 w-5 animate-spin" />}
      title={title}
    />
  );
}

export function EmptyState({
  actionLabel,
  children,
  className,
  compact = false,
  description,
  icon: _icon,
  onAction,
  title,
}: {
  actionLabel?: string;
  children?: ReactNode;
  className?: string;
  compact?: boolean;
  description: string;
  icon?: ReactNode;
  onAction?: () => void;
  title: string;
}) {
  const action =
    children ??
    (onAction && actionLabel ? (
      <Button type="button" variant="secondary" onClick={onAction}>
        <RefreshCcw className="h-4 w-4" />
        {actionLabel}
      </Button>
    ) : null);

  return (
    <GlyphEmptyState
      action={action}
      body={description}
      className={className}
      compact={compact}
      title={title}
    />
  );
}

export function ErrorState({
  actionLabel = "Try again",
  className,
  description,
  onAction,
  title = "Something did not load",
}: {
  actionLabel?: string;
  className?: string;
  description: string;
  onAction?: () => void;
  title?: string;
}) {
  return (
    <StatusState
      actionLabel={actionLabel}
      className={className}
      description={description}
      icon={<AlertTriangle className="h-5 w-5" />}
      onAction={onAction}
      title={title}
      tone="error"
    />
  );
}
