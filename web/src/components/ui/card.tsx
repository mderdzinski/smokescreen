import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";

const cardVariants = cva(
  "relative rounded-md border border-border bg-surface-card text-content-body shadow-sm",
  {
    variants: {
      variant: {
        default: "",
        sunken: "bg-surface-sunken shadow-none",
        flat: "shadow-none",
        inverse: "border-[color:var(--border-dark)] bg-surface-inverse text-content-on-dark",
        accent: "border-t-bold border-t-brand",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface CardProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title">,
    VariantProps<typeof cardVariants> {
  label?: React.ReactNode;
  title?: React.ReactNode;
  action?: React.ReactNode;
  pad?: boolean;
}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ action, children, className, label, pad = false, title, variant, ...props }, ref) => {
    const hasHeader = Boolean(label || title || action);

    return (
      <div
        ref={ref}
        className={cn(cardVariants({ variant }), pad && !hasHeader && "p-5", className)}
        {...props}
      >
        {hasHeader ? (
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0">
              {label ? <div className="ss-label">{label}</div> : null}
              {title ? (
                <div className="mt-0.5 font-display text-lg font-semibold leading-snug text-content-strong">
                  {title}
                </div>
              ) : null}
            </div>
            {action ? <div className="shrink-0">{action}</div> : null}
          </div>
        ) : null}
        {hasHeader ? <div className="p-5">{children}</div> : children}
      </div>
    );
  },
);
Card.displayName = "Card";

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("flex flex-row items-start justify-between gap-3 border-b border-border px-5 py-4", className)}
      {...props}
    />
  ),
);
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3
      ref={ref}
      className={cn("font-display text-lg font-semibold leading-snug text-content-strong", className)}
      {...props}
    />
  ),
);
CardTitle.displayName = "CardTitle";

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("p-5", className)} {...props} />,
);
CardContent.displayName = "CardContent";

export { Card, CardContent, CardHeader, CardTitle, cardVariants };
