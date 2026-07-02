import * as React from "react";

import { cn } from "../../lib/utils";

type SharedTextFieldProps = {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  error?: boolean;
  className?: string;
};

type TextFieldInputProps = SharedTextFieldProps &
  Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> & {
    multiline?: false;
  };

type TextFieldTextareaProps = SharedTextFieldProps &
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
    multiline: true;
  };

export type TextFieldProps = TextFieldInputProps | TextFieldTextareaProps;

const fieldClass =
  "w-full rounded-sm border border-[color:var(--border-field)] bg-surface-field text-sm text-content-strong outline-none transition-[border-color,box-shadow] duration-fast ease-standard placeholder:text-content-faint hover:border-[color:var(--border-strong)] focus-visible:border-ring focus-visible:shadow-focus disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-content-faint";

export function TextField(props: TextFieldProps) {
  const {
    className,
    error = false,
    hint,
    icon,
    id,
    label,
    multiline = false,
    ...fieldProps
  } = props;
  const autoId = React.useId();
  const fieldId = id ?? autoId;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const describedBy = [props["aria-describedby"], hintId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={cn("grid gap-2", className)}>
      {label ? (
        <label className="ss-label" htmlFor={fieldId}>
          {label}
        </label>
      ) : null}
      <div className="relative flex items-center">
        {icon ? (
          <span className="pointer-events-none absolute left-[10px] inline-flex text-content-faint [&_svg]:h-4 [&_svg]:w-4">
            {icon}
          </span>
        ) : null}
        {multiline ? (
          <textarea
            {...(fieldProps as React.TextareaHTMLAttributes<HTMLTextAreaElement>)}
            aria-describedby={describedBy}
            aria-invalid={error || undefined}
            className={cn(
              fieldClass,
              "min-h-[76px] resize-y px-3 py-3 leading-normal",
              error && "border-rust-400 hover:border-rust-400 focus-visible:border-rust-400",
            )}
            id={fieldId}
          />
        ) : (
          <input
            {...(fieldProps as Omit<React.InputHTMLAttributes<HTMLInputElement>, "size">)}
            aria-describedby={describedBy}
            aria-invalid={error || undefined}
            className={cn(
              fieldClass,
              "h-[38px] px-3",
              icon && "pl-8",
              error && "border-rust-400 hover:border-rust-400 focus-visible:border-rust-400",
            )}
            id={fieldId}
          />
        )}
      </div>
      {hint ? (
        <span className={cn("text-xs text-content-muted", error && "text-soft-rust")} id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}
