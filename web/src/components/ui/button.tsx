import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border border-transparent font-mono text-xs font-semibold uppercase leading-none tracking-label transition-[background,border-color,color,box-shadow,transform] duration-fast ease-standard focus-visible:outline-none focus-visible:shadow-focus active:translate-y-px disabled:pointer-events-none disabled:cursor-not-allowed disabled:translate-y-0 disabled:opacity-[.45] [&_svg]:pointer-events-none [&_svg]:h-[15px] [&_svg]:w-[15px] [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-brand text-content-on-olive hover:bg-brand-hover",
        accent: "bg-accent text-content-on-amber hover:bg-accent-strong",
        secondary:
          "border-[color:var(--border-strong)] bg-surface-raised text-content-strong hover:bg-ink-700",
        outline:
          "border-[color:var(--border-strong)] bg-transparent text-content-strong hover:bg-fill-neutral",
        ghost: "bg-transparent text-content-body hover:bg-fill-neutral hover:text-content-strong",
        danger: "bg-rust-500 text-content-on-dark hover:bg-rust-400",
        default: "bg-brand text-content-on-olive hover:bg-brand-hover",
        destructive: "bg-rust-500 text-content-on-dark hover:bg-rust-400",
      },
      size: {
        sm: "h-[30px] px-3 text-2xs",
        md: "h-[38px] px-4",
        lg: "h-[46px] px-6 text-sm",
        icon: "h-[38px] w-[38px] p-0",
        default: "h-[38px] px-4",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

const iconOnlySizes: Record<string, string> = {
  sm: "h-[30px] w-[30px] p-0",
  md: "h-[38px] w-[38px] p-0",
  lg: "h-[46px] w-[46px] p-0",
  default: "h-[38px] w-[38px] p-0",
};

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  iconOnly?: boolean;
  block?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ block = false, className, iconOnly = false, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    const resolvedSize = size ?? "md";
    return (
      <Comp
        className={cn(
          buttonVariants({ variant, size }),
          iconOnly && iconOnlySizes[resolvedSize],
          block && "w-full",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
