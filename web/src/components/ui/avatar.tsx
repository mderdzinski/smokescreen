import * as React from "react";

import { cn } from "../../lib/utils";

type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";
type AvatarShape = "square" | "round";

const sizeClasses: Record<AvatarSize, string> = {
  xs: "h-6 w-6",
  sm: "h-8 w-8",
  md: "h-11 w-11",
  lg: "h-16 w-16",
  xl: "h-24 w-24",
};

const shapeClasses: Record<AvatarShape, string> = {
  square: "rounded-sm",
  round: "rounded-pill",
};

export interface AvatarProps extends React.HTMLAttributes<HTMLSpanElement> {
  src?: string;
  alt?: string;
  size?: AvatarSize;
  shape?: AvatarShape;
  ring?: boolean;
  initials?: string;
}

export function Avatar({
  alt = "",
  className,
  initials,
  ring = false,
  shape = "square",
  size = "md",
  src,
  ...props
}: AvatarProps) {
  return (
    <span
      className={cn(
        "relative inline-flex flex-none items-center justify-center overflow-hidden border border-[color:var(--border-strong)] bg-surface-sunken text-content-muted",
        sizeClasses[size],
        shapeClasses[shape],
        ring && "ring-2 ring-paper ring-offset-2 ring-offset-brand",
        className,
      )}
      {...props}
    >
      {src ? (
        <img alt={alt} className="block h-full w-full object-cover [image-rendering:pixelated]" src={src} />
      ) : (
        <span className="font-pixel text-[.7em] leading-none text-brand-strong">{initials || ".."}</span>
      )}
    </span>
  );
}
