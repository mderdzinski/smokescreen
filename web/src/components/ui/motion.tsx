import * as React from "react";

import { cn } from "../../lib/utils";
import { Button } from "./button";

const DEFAULT_COUNT_UP_DURATION = 900;
const COUNT_UP_TICK_MS = 33;
const MAIL_SMOKE_GLYPH_SRC = "/assets/glyph-mail-smoke.png";

const SMOKE_SHEETS = [
  "/assets/throw-key-a.png",
  "/assets/throw-key-b.png",
  "/assets/throw-key-c.png",
] as const;

const SMOKE_COLS = 8;
const SMOKE_FRAMES_PER_SHEET = 40;
const SMOKE_TOTAL_FRAMES = 120;
const SMOKE_FRAME_WIDTH = 384;
const SMOKE_FRAME_HEIGHT = 216;
const SMOKE_REDUCED_FRAME = 80;

const SMOKE_SEQUENCE = [
  ...Array.from({ length: 9 }, () => 37),
  ...Array.from({ length: SMOKE_TOTAL_FRAMES - 38 }, (_, index) => index + 38),
];
const LAST_SMOKE_SEQUENCE_FRAME = SMOKE_SEQUENCE[SMOKE_SEQUENCE.length - 1] ?? SMOKE_REDUCED_FRAME;

type CssVars = React.CSSProperties & Record<`--${string}`, string | number>;

function easeOutCubic(progress: number) {
  return 1 - Math.pow(1 - progress, 3);
}

function isDocumentHidden() {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function getPrefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function useLatest<T>(value: T) {
  const ref = React.useRef(value);

  React.useEffect(() => {
    ref.current = value;
  }, [value]);

  return ref;
}

export function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = React.useState(getPrefersReducedMotion);

  React.useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }

    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handleChange = () => setPrefersReducedMotion(mediaQuery.matches);
    handleChange();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  return prefersReducedMotion;
}

export function useCountUp(target: number, { duration = DEFAULT_COUNT_UP_DURATION } = {}) {
  const [value, setValue] = React.useState(target);
  const prefersReducedMotion = usePrefersReducedMotion();

  React.useEffect(() => {
    if (prefersReducedMotion || target <= 0 || duration <= 0 || isDocumentHidden()) {
      setValue(target);
      return undefined;
    }

    setValue(0);
    const startTime = Date.now();
    const timer = window.setInterval(() => {
      const progress = Math.min(1, (Date.now() - startTime) / duration);
      const nextValue = Math.round(target * easeOutCubic(progress));

      setValue(nextValue);

      if (progress >= 1) {
        setValue(target);
        window.clearInterval(timer);
      }
    }, COUNT_UP_TICK_MS);

    return () => window.clearInterval(timer);
  }, [duration, prefersReducedMotion, target]);

  return value;
}

export interface ScanSweepProps extends React.HTMLAttributes<HTMLSpanElement> {
  active?: boolean;
  color?: string;
}

export function ScanSweep({
  active = true,
  className,
  color = "rgba(238,159,67,0.18)",
  style,
  ...props
}: ScanSweepProps) {
  const prefersReducedMotion = usePrefersReducedMotion();

  if (!active || prefersReducedMotion) {
    return null;
  }

  return (
    <span
      aria-hidden="true"
      className={cn("ss-scan-layer absolute inset-x-0 top-0 h-[34%] rounded-[inherit]", className)}
      style={
        {
          background: `linear-gradient(180deg, transparent, ${color} 70%, ${color})`,
          ...style,
        } as React.CSSProperties
      }
      {...props}
    />
  );
}

interface PoofChip {
  delay: string;
  dx: string;
  dy: string;
  size: number;
  tone: "strong" | "soft";
}

export interface PoofProps extends React.HTMLAttributes<HTMLSpanElement> {
  count?: number;
  duration?: number;
  onDone?: () => void;
}

export function Poof({ className, count = 7, duration = 620, onDone, ...props }: PoofProps) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const onDoneRef = useLatest(onDone);
  const chips = React.useMemo<PoofChip[]>(
    () =>
      Array.from({ length: count }, (_, index) => ({
        delay: `${Math.round(Math.random() * 90)}ms`,
        dx: `${Math.round(Math.random() * 60 - 30)}px`,
        dy: `${Math.round(-110 - Math.random() * 90)}%`,
        size: 7 + Math.round(Math.random() * 6),
        tone: index % 3 === 0 ? "strong" : "soft",
      })),
    [count],
  );

  React.useEffect(() => {
    const doneDelay = prefersReducedMotion ? 0 : duration + 60;
    const timer = window.setTimeout(() => onDoneRef.current?.(), doneDelay);

    return () => window.clearTimeout(timer);
  }, [duration, onDoneRef, prefersReducedMotion]);

  if (prefersReducedMotion) {
    return null;
  }

  return (
    <span
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0 z-[5] overflow-visible", className)}
      {...props}
    >
      {chips.map((chip, index) => (
        <span
          key={`${chip.dx}-${chip.dy}-${index}`}
          data-ss-motion="poof-chip"
          style={
            {
              "--dx": chip.dx,
              "--dy": chip.dy,
              animation: `ss-poof ${duration}ms var(--ease-out) ${chip.delay} both`,
              background: chip.tone === "strong" ? "var(--smoke-400)" : "var(--smoke-300)",
              borderRadius: "var(--radius-sm)",
              height: chip.size,
              left: "50%",
              marginLeft: -chip.size / 2,
              marginTop: -chip.size / 2,
              pointerEvents: "none",
              position: "absolute",
              top: "50%",
              width: chip.size,
            } as CssVars
          }
        />
      ))}
    </span>
  );
}

export interface SmokePlayerProps extends React.CanvasHTMLAttributes<HTMLCanvasElement> {
  fps?: number;
  loop?: boolean;
  onDone?: () => void;
  sheetSources?: readonly string[];
  width?: number | string;
}

export function SmokePlayer({
  className,
  fps = 30,
  loop = false,
  onDone,
  sheetSources = SMOKE_SHEETS,
  style,
  width = 360,
  ...props
}: SmokePlayerProps) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const onDoneRef = useLatest(onDone);
  const prefersReducedMotion = usePrefersReducedMotion();

  React.useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");

    if (!canvas || !context) {
      return undefined;
    }

    let loaded = 0;
    let dead = false;
    let finished = false;
    let timer: number | undefined;
    let reducedMotionDoneTimer: number | undefined;
    const images: HTMLImageElement[] = [];
    const frameRate = fps > 0 ? fps : 30;

    const drawFrame = (frameIndex: number) => {
      const sheetIndex = Math.floor(frameIndex / SMOKE_FRAMES_PER_SHEET);
      const sheetFrame = frameIndex % SMOKE_FRAMES_PER_SHEET;
      const image = images[sheetIndex];

      if (!image) {
        return;
      }

      context.clearRect(0, 0, SMOKE_FRAME_WIDTH, SMOKE_FRAME_HEIGHT);
      try {
        context.drawImage(
          image,
          (sheetFrame % SMOKE_COLS) * SMOKE_FRAME_WIDTH,
          Math.floor(sheetFrame / SMOKE_COLS) * SMOKE_FRAME_HEIGHT,
          SMOKE_FRAME_WIDTH,
          SMOKE_FRAME_HEIGHT,
          0,
          0,
          SMOKE_FRAME_WIDTH,
          SMOKE_FRAME_HEIGHT,
        );
      } catch {
        // Broken image loads should not leave the launch overlay stuck forever.
      }
    };

    const finish = () => {
      if (finished) {
        return;
      }

      finished = true;
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
      if (reducedMotionDoneTimer !== undefined) {
        window.clearTimeout(reducedMotionDoneTimer);
        reducedMotionDoneTimer = undefined;
      }
      onDoneRef.current?.();
    };

    const start = () => {
      if (prefersReducedMotion) {
        drawFrame(SMOKE_REDUCED_FRAME);
        return;
      }

      drawFrame(SMOKE_SEQUENCE[0] ?? LAST_SMOKE_SEQUENCE_FRAME);
      const startTime = Date.now();
      timer = window.setInterval(() => {
        if (dead) {
          return;
        }

        const elapsedSeconds = (Date.now() - startTime) / 1000;
        let sequenceIndex = Math.floor(elapsedSeconds * frameRate);

        if (sequenceIndex >= SMOKE_SEQUENCE.length) {
          if (loop) {
            sequenceIndex %= SMOKE_SEQUENCE.length;
          } else {
            drawFrame(LAST_SMOKE_SEQUENCE_FRAME);
            finish();
            return;
          }
        }

        drawFrame(SMOKE_SEQUENCE[sequenceIndex] ?? LAST_SMOKE_SEQUENCE_FRAME);
      }, 1000 / frameRate);
    };

    if (sheetSources.length === 0) {
      finish();
      return undefined;
    }

    if (prefersReducedMotion) {
      reducedMotionDoneTimer = window.setTimeout(finish, 0);
    }

    const handleAssetReady = () => {
      loaded += 1;
      if (loaded === sheetSources.length && !dead) {
        start();
      }
    };

    sheetSources.forEach((source) => {
      const image = new Image();
      image.onload = handleAssetReady;
      image.onerror = handleAssetReady;
      image.src = source;
      images.push(image);
    });

    return () => {
      dead = true;
      if (timer !== undefined) {
        window.clearInterval(timer);
      }
      if (reducedMotionDoneTimer !== undefined) {
        window.clearTimeout(reducedMotionDoneTimer);
      }
    };
  }, [fps, loop, onDoneRef, prefersReducedMotion, sheetSources]);

  return (
    <canvas
      ref={canvasRef}
      className={cn("block max-w-full", className)}
      height={SMOKE_FRAME_HEIGHT}
      style={
        {
          aspectRatio: "16 / 9",
          imageRendering: "auto",
          width,
          ...style,
        } as React.CSSProperties
      }
      width={SMOKE_FRAME_WIDTH}
      {...props}
    />
  );
}

export interface ThrowOverlayProps {
  count?: number;
  onClose?: () => void;
  onViewStatus?: () => void;
  resolveWhen?: boolean;
}

export function ThrowOverlay({
  count = 0,
  onClose,
  onViewStatus,
  resolveWhen = true,
}: ThrowOverlayProps) {
  const [playerDone, setPlayerDone] = React.useState(false);
  const done = playerDone && resolveWhen;
  const prefersReducedMotion = usePrefersReducedMotion();

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && done) {
        onClose?.();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [done, onClose]);

  return (
    <div
      aria-label="Sending opt-out requests"
      aria-modal="true"
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center px-4 [animation:ss-ov-in_240ms_var(--ease-standard)_both]"
      onClick={() => {
        if (done) {
          onClose?.();
        }
      }}
      role="dialog"
      style={{
        WebkitBackdropFilter: "blur(3px)",
        backdropFilter: "blur(3px)",
        background: "rgba(9,11,12,0.62)",
      }}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute h-[90vmin] w-[90vmin] rounded-full"
        style={{
          animation: prefersReducedMotion ? "none" : "ss-haze-bloom 2400ms var(--ease-out) 700ms both",
          background:
            "radial-gradient(circle, rgba(205,210,200,0.34), rgba(180,186,176,0.14) 45%, transparent 68%)",
          opacity: prefersReducedMotion ? 0.5 : 0,
        }}
      />

      <div
        aria-live="polite"
        className="ss-label pointer-events-none absolute left-1/2 top-[26px] -translate-x-1/2 whitespace-nowrap text-center text-steel-300"
      >
        {done ? "Deployment complete" : "Deploying smokescreen · going dark"}
      </div>

      <div className="pointer-events-none relative z-[1] [filter:drop-shadow(0_14px_26px_rgba(0,0,0,0.5))]">
        <SmokePlayer fps={30} width="min(62vw, 720px)" onDone={() => setPlayerDone(true)} />
      </div>

      {done ? (
        <div
          className="relative z-[2] mt-2 flex w-full max-w-[520px] flex-col gap-4 rounded-md border border-border bg-card px-5 py-4 shadow-lg [animation:ss-panel-rise_360ms_var(--ease-out)_both] sm:flex-row sm:items-center"
          onClick={(event) => event.stopPropagation()}
          style={{ borderTopColor: "var(--clear-500)", borderTopWidth: 2 }}
        >
          <img
            alt=""
            className="h-12 w-12 flex-none rounded-sm border border-[color:var(--border-strong)] [image-rendering:pixelated]"
            height="48"
            src="/assets/operator-head.png"
            width="48"
          />
          <div className="min-w-0 flex-1">
            <div className="ss-pixel text-xl text-clear-400">smoke's out.</div>
            <div className="mt-1 text-sm text-content-body">
              {count} opt-out {count === 1 ? "request is" : "requests are"} on their way. Smokescreen will track
              every reply.
            </div>
          </div>
          <div className="flex flex-none flex-wrap gap-2 sm:ml-auto">
            <Button size="sm" type="button" variant="outline" onClick={onClose}>
              Close
            </Button>
            <Button size="sm" type="button" variant="accent" onClick={onViewStatus}>
              View status
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export interface EmptyStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  action?: React.ReactNode;
  body?: React.ReactNode;
  compact?: boolean;
  title: React.ReactNode;
}

export function EmptyState({ action, body, className, compact = false, title, ...props }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "gap-2 px-5 py-7" : "gap-3 px-6 py-12",
        className,
      )}
      {...props}
    >
      <img
        alt=""
        aria-hidden="true"
        className={cn(
          "mb-0.5 h-auto opacity-[0.92] [filter:drop-shadow(0_6px_14px_rgba(0,0,0,0.35))] [image-rendering:pixelated]",
          compact ? "w-[66px]" : "w-[92px]",
        )}
        src={MAIL_SMOKE_GLYPH_SRC}
      />
      <h3 className={cn("font-display font-semibold leading-snug text-content-strong", compact ? "text-md" : "text-lg")}>
        {title}
      </h3>
      {body ? (
        <p
          className={cn(
            "max-w-[36ch] text-sm leading-[1.55] text-content-muted",
            compact && "max-w-[26ch] text-xs leading-relaxed",
          )}
        >
          {body}
        </p>
      ) : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

export interface SplashScreenProps extends React.HTMLAttributes<HTMLDivElement> {
  label?: string;
}

export function SplashScreen({ className, label = "Priming the smokescreen…", ...props }: SplashScreenProps) {
  return (
    <div
      aria-label={label}
      className={cn(
        "fixed inset-0 z-[90] flex flex-col items-center justify-center gap-[22px]",
        "bg-[radial-gradient(120%_90%_at_32%_24%,rgba(102,114,63,0.22),transparent_60%),linear-gradient(160deg,#20262a,#14181a)]",
        className,
      )}
      role="status"
      {...props}
    >
      <img
        alt=""
        aria-hidden="true"
        className="h-auto w-[132px] [animation:ss-splash-bob_2.4s_var(--ease-standard)_infinite] [filter:drop-shadow(0_14px_30px_rgba(0,0,0,0.5))] [image-rendering:pixelated]"
        data-ss-motion="splash-glyph"
        src={MAIL_SMOKE_GLYPH_SRC}
      />
      <div className="ss-pixel text-[22px] text-smoke-50">
        smoke<b className="text-olive-300">screen</b>
      </div>
      <div className="h-[3px] w-[168px] overflow-hidden rounded-sm bg-[rgba(255,255,255,0.10)]">
        <span
          aria-hidden="true"
          className="block h-full w-[40%] bg-accent [animation:ss-splash-load_1.5s_var(--ease-standard)_infinite]"
          data-ss-motion="splash-bar"
        />
      </div>
      <div className="ss-label text-steel-300">{label}</div>
    </div>
  );
}
