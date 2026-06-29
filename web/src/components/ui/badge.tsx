import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-[.4em] whitespace-nowrap rounded-sm border px-[.6em] py-[.34em] font-mono text-2xs font-semibold uppercase leading-none tracking-label transition-colors",
  {
    variants: {
      variant: {
        neutral: "border-border bg-fill-neutral text-soft-neutral",
        olive: "border-bd-olive bg-fill-olive text-soft-olive",
        amber: "border-bd-amber bg-fill-amber text-soft-amber",
        success: "border-bd-green bg-fill-green text-soft-green",
        danger: "border-bd-rust bg-fill-rust text-soft-rust",
        solid: "border-transparent bg-brand text-content-on-olive",
        outline: "border-[color:var(--border-strong)] bg-transparent text-content-muted",
        default: "border-transparent bg-brand text-content-on-olive",
        secondary: "border-border bg-fill-neutral text-soft-neutral",
        destructive: "border-bd-rust bg-fill-rust text-soft-rust",
      },
    },
    defaultVariants: {
      variant: "neutral",
    },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  dot?: boolean;
}

function Badge({ children, className, dot = false, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot ? <span className="h-[6px] w-[6px] rounded-pill bg-current" /> : null}
      {children}
    </span>
  );
}

export { Badge, badgeVariants };
