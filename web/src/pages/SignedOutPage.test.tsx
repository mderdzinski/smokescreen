import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SignedOutPage } from "./SignedOutPage";
import { renderWithProviders } from "../test/test-utils";

const IAP_CLEAR_URL = "/?gcp-iap-mode=CLEAR_LOGIN_COOKIE";

describe("SignedOutPage", () => {
  beforeEach(() => {
    window.localStorage.setItem("smokescreen:test", "1");
    window.sessionStorage.setItem("smokescreen:test", "1");
  });

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("clears local storage and exposes the documented IAP clear-cookie URL", () => {
    renderWithProviders(<SignedOutPage autoRedirect={false} />);

    expect(window.localStorage.getItem("smokescreen:test")).toBeNull();
    expect(window.sessionStorage.getItem("smokescreen:test")).toBeNull();

    const iapLink = screen.getByTestId("signed-out-iap-link");
    expect(iapLink).toHaveAttribute("href", IAP_CLEAR_URL);
    expect(screen.getByText(/You have been signed out/i)).toBeInTheDocument();
    expect(screen.getByText(/does not sign you out of Google/i)).toBeInTheDocument();
  });

  it("auto-redirects to the IAP clear-cookie endpoint after the confirmation state renders", () => {
    vi.useFakeTimers();
    const assignSpy = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, assign: assignSpy },
    });

    try {
      renderWithProviders(<SignedOutPage redirectDelayMs={500} />);

      expect(screen.getByTestId("signed-out-status")).toHaveTextContent(
        /Redirecting to IAP/i,
      );

      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(assignSpy).toHaveBeenCalledWith(IAP_CLEAR_URL);
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });
});
