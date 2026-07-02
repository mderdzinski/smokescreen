import { fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Poof, ScanSweep, SmokePlayer, ThrowOverlay, useCountUp } from "./motion";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function mockReducedMotion(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches,
      media: query,
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  );
}

function CountUpProbe({ duration = 900, target }: { duration?: number; target: number }) {
  const value = useCountUp(target, { duration });

  return <div data-testid="count-up-value">{value}</div>;
}

function mockSmokeCanvas() {
  const loadedSources: string[] = [];
  const drawImage = vi.fn();

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect: vi.fn(),
    drawImage,
  } as unknown as CanvasRenderingContext2D);

  class MockImage {
    onload: (() => void) | null = null;

    set src(value: string) {
      loadedSources.push(value);
      window.setTimeout(() => this.onload?.(), 0);
    }
  }

  vi.stubGlobal("Image", MockImage);

  return { drawImage, loadedSources };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useCountUp", () => {
  it("lands exactly on the target with timer-based easing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mockReducedMotion(false);

    render(<CountUpProbe duration={900} target={42} />);

    expect(screen.getByTestId("count-up-value")).toHaveTextContent("0");

    act(() => {
      vi.advanceTimersByTime(900);
    });

    expect(screen.getByTestId("count-up-value")).toHaveTextContent("42");
  });

  it("jumps to the target when reduced motion is requested", () => {
    vi.useFakeTimers();
    mockReducedMotion(true);

    render(<CountUpProbe target={42} />);

    expect(screen.getByTestId("count-up-value")).toHaveTextContent("42");
  });
});

describe("ScanSweep", () => {
  it("renders an amber sweep layer only when active", () => {
    mockReducedMotion(false);
    const { container, rerender } = render(<ScanSweep />);

    expect(container.querySelector(".ss-scan-layer")).toBeInTheDocument();

    rerender(<ScanSweep active={false} />);

    expect(container.querySelector(".ss-scan-layer")).not.toBeInTheDocument();
  });

  it("does not render the sweep when reduced motion is requested", () => {
    mockReducedMotion(true);
    const { container } = render(<ScanSweep />);

    expect(container.querySelector(".ss-scan-layer")).not.toBeInTheDocument();
  });
});

describe("Poof", () => {
  it("renders the requested number of smoke chips and calls onDone", () => {
    vi.useFakeTimers();
    mockReducedMotion(false);
    const onDone = vi.fn();
    const { container } = render(<Poof count={4} duration={620} onDone={onDone} />);

    expect(container.querySelectorAll('[data-ss-motion="poof-chip"]')).toHaveLength(4);

    act(() => {
      vi.advanceTimersByTime(680);
    });

    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("suppresses chips and resolves immediately under reduced motion", () => {
    vi.useFakeTimers();
    mockReducedMotion(true);
    const onDone = vi.fn();
    const { container } = render(<Poof onDone={onDone} />);

    expect(container.firstChild).toBeNull();

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe("SmokePlayer", () => {
  it("loads the throw sprite sheets and resolves on a reduced-motion still frame", () => {
    vi.useFakeTimers();
    mockReducedMotion(true);
    const onDone = vi.fn();
    const { drawImage, loadedSources } = mockSmokeCanvas();

    render(<SmokePlayer onDone={onDone} />);

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(loadedSources).toEqual([
      "/assets/throw-key-a.png",
      "/assets/throw-key-b.png",
      "/assets/throw-key-c.png",
    ]);
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("advances frames from elapsed wall-clock time and completes once", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mockReducedMotion(false);
    const onDone = vi.fn();
    const { drawImage } = mockSmokeCanvas();

    render(<SmokePlayer fps={10} onDone={onDone} />);

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(drawImage.mock.calls[0].slice(1, 3)).toEqual([1920, 864]);

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    const frameAtOneSecond = drawImage.mock.calls[drawImage.mock.calls.length - 1];
    expect(frameAtOneSecond.slice(1, 3)).toEqual([2688, 864]);
    expect(onDone).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(9000);
    });

    expect(onDone).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe("ThrowOverlay", () => {
  it("resolves to the panel under reduced motion and honors dismiss actions", () => {
    vi.useFakeTimers();
    mockReducedMotion(true);
    mockSmokeCanvas();
    const onClose = vi.fn();
    const onViewStatus = vi.fn();

    render(<ThrowOverlay count={2} onClose={onClose} onViewStatus={onViewStatus} />);

    const dialog = screen.getByRole("dialog", { name: "Sending opt-out requests" });
    expect(screen.getByText("Deploying smokescreen · going dark")).toBeInTheDocument();

    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(screen.getByText("Deployment complete")).toBeInTheDocument();
    expect(screen.getByText(/2 opt-out requests are on their way/)).toBeInTheDocument();

    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(3);

    fireEvent.click(screen.getByRole("button", { name: "View status" }));
    expect(onViewStatus).toHaveBeenCalledTimes(1);
  });
});
