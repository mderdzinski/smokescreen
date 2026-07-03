import * as React from "react";

import { cn } from "../../lib/utils";

export interface SwitchProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children" | "onChange" | "role" | "type"> {
  checked?: boolean;
  description?: React.ReactNode;
  label?: React.ReactNode;
  onChange?: (checked: boolean) => void;
  row?: boolean;
}

const trackClass =
  "relative h-[22px] w-[38px] shrink-0 rounded-pill border border-[color:var(--border-field)] bg-surface-field transition-[background,border-color,box-shadow] duration-fast ease-standard group-focus-visible:shadow-focus group-disabled:opacity-[.45]";

const thumbClass =
  "absolute left-[2px] top-[2px] h-4 w-4 rounded-pill bg-steel-300 transition-[transform,background] duration-fast ease-standard";

const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  (
    {
      "aria-describedby": ariaDescribedBy,
      "aria-labelledby": ariaLabelledBy,
      checked = false,
      className,
      description,
      disabled = false,
      id,
      label,
      onChange,
      onClick,
      row = false,
      ...props
    },
    ref,
  ) => {
    const autoId = React.useId();
    const switchId = id ?? autoId;
    const labelId = label ? `${switchId}-label` : undefined;
    const descriptionId = description ? `${switchId}-description` : undefined;
    const describedBy = [ariaDescribedBy, descriptionId].filter(Boolean).join(" ") || undefined;

    function handleClick(event: React.MouseEvent<HTMLButtonElement>) {
      onClick?.(event);
      if (!event.defaultPrevented) {
        onChange?.(!checked);
      }
    }

    return (
      <button
        aria-checked={checked}
        aria-describedby={describedBy}
        aria-labelledby={ariaLabelledBy ?? labelId}
        className={cn(
          "group inline-flex cursor-pointer select-none items-center gap-3 rounded-sm text-left transition-[background,border-color,box-shadow] duration-fast ease-standard focus-visible:outline-none disabled:cursor-not-allowed",
          row
            ? "w-full justify-between border border-border bg-surface-sunken px-4 py-3"
            : "justify-start",
          disabled && "cursor-not-allowed",
          className,
        )}
        disabled={disabled}
        id={switchId}
        onClick={handleClick}
        ref={ref}
        role="switch"
        type="button"
        {...props}
      >
        {label || description ? (
          <span className="grid min-w-0 gap-px">
            {label ? (
              <span className="text-sm font-medium text-content-strong" id={labelId}>
                {label}
              </span>
            ) : null}
            {description ? (
              <span className="text-xs text-content-muted" id={descriptionId}>
                {description}
              </span>
            ) : null}
          </span>
        ) : null}
        <span
          className={cn(
            trackClass,
            checked && "border-brand bg-brand",
          )}
        >
          <span className={cn(thumbClass, checked && "translate-x-4 bg-content-on-olive")} />
        </span>
      </button>
    );
  },
);
Switch.displayName = "Switch";

export { Switch };
