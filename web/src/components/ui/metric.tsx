import * as React from "react";

import { cn } from "../../lib/utils";

type MetricTone = "neutral" | "working" | "done" | "attention";

const toneClasses: Record<MetricTone, { icon: string; rail: string }> = {
  neutral: {
    icon: "bg-fill-neutral text-soft-neutral",
    rail: "bg-steel-300",
  },
  working: {
    icon: "bg-fill-amber text-status-working",
    rail: "bg-status-working",
  },
  done: {
    icon: "bg-fill-green text-status-done",
    rail: "bg-status-done",
  },
  attention: {
    icon: "bg-fill-rust text-status-attention",
    rail: "bg-status-attention",
  },
};

export interface MetricProps extends React.HTMLAttributes<HTMLDivElement> {
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: MetricTone;
  rail?: boolean;
}

export function Metric({
  className,
  icon,
  label,
  rail = true,
  sub,
  tone = "neutral",
  value,
  ...props
}: MetricProps) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md border border-border bg-surface-card px-5 py-4 text-content-body shadow-sm",
        className,
      )}
      {...props}
    >
      {rail ? <span className={cn("absolute inset-y-0 left-0 w-[3px]", toneClasses[tone].rail)} /> : null}
      <div className="flex items-center justify-between gap-3">
        <span className="ss-label">{label}</span>
        {icon ? (
          <span
            className={cn(
              "inline-flex h-[30px] w-[30px] items-center justify-center rounded-sm [&_svg]:h-4 [&_svg]:w-4",
              toneClasses[tone].icon,
            )}
          >
            {icon}
          </span>
        ) : null}
      </div>
      <div className="mt-3 font-pixel text-[2rem] font-bold leading-none text-content-strong">{value}</div>
      {sub ? <div className="mt-2 text-xs text-content-muted">{sub}</div> : null}
    </div>
  );
}
