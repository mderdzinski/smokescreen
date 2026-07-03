import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { Switch } from "./switch";

function ControlledSwitch({
  initialChecked = false,
  onChange,
}: {
  initialChecked?: boolean;
  onChange?: (checked: boolean) => void;
}) {
  const [checked, setChecked] = React.useState(initialChecked);

  return (
    <Switch
      checked={checked}
      description="Prepare work without sending email."
      label="Dry run"
      onChange={(next) => {
        onChange?.(next);
        setChecked(next);
      }}
    />
  );
}

describe("Switch", () => {
  it("toggles from clicks and reports the next checked state", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ControlledSwitch onChange={onChange} />);

    const toggle = screen.getByRole("switch", { name: "Dry run" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveAccessibleDescription("Prepare work without sending email.");

    await user.click(toggle);

    expect(onChange).toHaveBeenCalledWith(true);
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("is keyboard-operable with Space and Enter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ControlledSwitch onChange={onChange} />);

    const toggle = screen.getByRole("switch", { name: "Dry run" });
    toggle.focus();

    await user.keyboard("[Space]");
    await user.keyboard("[Enter]");

    expect(onChange).toHaveBeenNthCalledWith(1, true);
    expect(onChange).toHaveBeenNthCalledWith(2, false);
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("does not toggle when disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Switch checked={false} disabled label="Dry run" onChange={onChange} />);

    const toggle = screen.getByRole("switch", { name: "Dry run" });
    expect(toggle).toBeDisabled();

    await user.click(toggle);

    expect(onChange).not.toHaveBeenCalled();
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("supports the full-width settings row treatment", () => {
    render(
      <Switch
        checked
        description="Ping me when a broker replies."
        label="Email notifications"
        row
      />,
    );

    const toggle = screen.getByRole("switch", { name: "Email notifications" });
    expect(toggle).toHaveClass("w-full", "justify-between", "border", "bg-surface-sunken");
    expect(toggle).toHaveAccessibleDescription("Ping me when a broker replies.");
  });
});
