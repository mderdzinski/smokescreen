import * as React from "react";

import { cn } from "../../lib/utils";

type LogoSize = "sm" | "md" | "lg";

const markSizes: Record<LogoSize, string> = {
  sm: "h-[30px] w-[30px]",
  md: "h-10 w-10",
  lg: "h-14 w-14",
};

const wordSizes: Record<LogoSize, string> = {
  sm: "text-[13px]",
  md: "text-[17px]",
  lg: "text-2xl",
};

export interface LogoProps extends React.HTMLAttributes<HTMLSpanElement> {
  src?: string;
  size?: LogoSize;
  inverse?: boolean;
  showMark?: boolean;
  tagline?: React.ReactNode;
}

export function Logo({
  className,
  inverse = false,
  showMark = true,
  size = "md",
  src = "/assets/operator-head.png",
  tagline,
  ...props
}: LogoProps) {
  return (
    <span className={cn("inline-flex items-center gap-3", className)} {...props}>
      {showMark ? (
        <span
          className={cn(
            "inline-flex flex-none items-center justify-center overflow-hidden rounded-sm border border-ink-600 bg-ink-800",
            markSizes[size],
          )}
        >
          <img alt="" className="block h-full w-full object-cover [image-rendering:pixelated]" src={src} />
        </span>
      ) : null}
      <span className="flex flex-col gap-0.5 leading-none">
        <span
          aria-label="Smokescreen"
          className={cn(
            "font-pixel font-bold normal-case tracking-normal",
            inverse ? "text-smoke-50" : "text-content-strong",
            wordSizes[size],
          )}
        >
          smoke<b className="text-brand">screen</b>
        </span>
        {tagline ? (
          <span className={cn("ss-label", inverse ? "text-steel-300" : "text-content-muted")}>{tagline}</span>
        ) : null}
      </span>
    </span>
  );
}
