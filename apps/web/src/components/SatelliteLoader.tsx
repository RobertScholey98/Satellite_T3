import { useLayoutEffect, useRef, type ComponentPropsWithoutRef } from "react";
import {
  satelliteLoaderExitFrame,
  satelliteLoaderLoopFrame,
  satelliteLoaderPreset,
  satelliteLoaderStill,
  smoothLoaderProgress,
  type SatelliteLoaderFrame,
} from "./satellite-loader-motion";

export interface SatelliteLoaderProps extends Omit<
  ComponentPropsWithoutRef<"svg">,
  "children" | "viewBox" | "aria-hidden" | "dangerouslySetInnerHTML"
> {
  loading: boolean;
  /** Called once after a true → false exit, never on an initially idle mount. */
  onExitComplete?: () => void;
  /** Finish an already-completed observed operation on its first visible mount. */
  finishOnMount?: boolean;
  size?: number | string;
}

/** Version (7)'s 1.6 s loading loop and 850 ms spiral finish.
 * Keep mounted when loading becomes false; onExitComplete is the removal point.
 * An idle loader is invisible but retains its footprint. Loading again cancels
 * any unfinished exit and restarts the loop. Colour comes from currentColor.
 */
export function SatelliteLoader({
  loading,
  onExitComplete,
  finishOnMount = false,
  size = 32,
  width = size,
  height = size,
  ...props
}: SatelliteLoaderProps) {
  const svg = useRef<SVGSVGElement>(null);
  const group = useRef<SVGGElement>(null);
  const body = useRef<SVGPathElement>(null);
  const square = useRef<SVGRectElement>(null);
  const phase = useRef(0);
  const active = useRef(false);
  const currentFrame = useRef<SatelliteLoaderFrame>(satelliteLoaderStill);
  const completed = useRef(onExitComplete);

  useLayoutEffect(() => {
    completed.current = onExitComplete;
  }, [onExitComplete]);

  useLayoutEffect(() => {
    const root = svg.current;
    const parts = group.current;
    const shape = body.current;
    const satellite = square.current;
    if (!root || !parts || !shape || !satellite) return;

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let disposed = false;
    let settled = false;
    let request: number | undefined;
    let deadline: number | undefined;
    let lastTime: number | undefined;
    let lastPaint: number | undefined;
    let exitStarted = performance.now();
    let exitDuration = motion.matches ? 200 : satelliteLoaderPreset.finishDuration * 1000;
    let fadeOnly = motion.matches;
    let fadeFrame = currentFrame.current;
    const exitPhase = phase.current;

    function draw(frame: SatelliteLoaderFrame) {
      currentFrame.current = frame;
      shape!.setAttribute("d", frame.path);
      satellite!.setAttribute(
        "transform",
        `translate(${frame.x} ${frame.y}) rotate(${frame.rotation}) scale(${frame.squareScale})`,
      );
      parts!.setAttribute("opacity", String(frame.opacity));
    }
    function cancelFrame() {
      if (request !== undefined) cancelAnimationFrame(request);
      request = undefined;
    }
    function finish() {
      if (disposed || settled) return;
      settled = true;
      active.current = false;
      cancelFrame();
      window.clearTimeout(deadline);
      parts!.setAttribute("opacity", "0");
      root!.setAttribute("aria-hidden", "true");
      root!.setAttribute("data-state", "idle");
      completed.current?.();
    }
    function tick(time: number) {
      request = undefined;
      if (disposed || settled) return;
      // High-refresh displays keep the approved motion without painting above 60Hz.
      if (lastPaint !== undefined && time - lastPaint < 1000 / 60) {
        request = requestAnimationFrame(tick);
        return;
      }
      lastPaint = time;
      if (loading) {
        if (lastTime !== undefined)
          phase.current =
            (phase.current + (time - lastTime) / (satelliteLoaderPreset.duration * 1000)) % 1;
        lastTime = time;
        draw(satelliteLoaderLoopFrame(phase.current));
      } else {
        const progress = Math.min(1, (time - exitStarted) / exitDuration);
        draw(
          fadeOnly
            ? { ...fadeFrame, opacity: fadeFrame.opacity * (1 - smoothLoaderProgress(progress)) }
            : satelliteLoaderExitFrame(progress, exitPhase),
        );
        if (progress >= 1) {
          finish();
          return;
        }
      }
      request = requestAnimationFrame(tick);
    }
    function schedule() {
      cancelFrame();
      lastTime = undefined;
      lastPaint = undefined;
      if (disposed || settled) return;
      if (!loading && performance.now() - exitStarted >= exitDuration) {
        finish();
        return;
      }
      if (loading && motion.matches) {
        draw(satelliteLoaderStill);
        return;
      }
      if (!document.hidden) request = requestAnimationFrame(tick);
    }
    function motionChanged() {
      if (settled) return;
      if (!loading && motion.matches && !fadeOnly) {
        // If the preference changes mid-exit, freeze the visible pose and fade.
        fadeFrame = currentFrame.current;
        fadeOnly = true;
        exitDuration = Math.max(0, Math.min(200, exitDuration - (performance.now() - exitStarted)));
        exitStarted = performance.now();
        window.clearTimeout(deadline);
        deadline = window.setTimeout(finish, exitDuration);
      }
      schedule();
    }

    if (loading) {
      active.current = true;
      phase.current = 0;
      root.setAttribute("aria-hidden", "false");
      root.setAttribute("data-state", "loading");
      draw(motion.matches ? satelliteLoaderStill : satelliteLoaderLoopFrame(0));
    } else if (active.current || finishOnMount) {
      root.setAttribute("aria-hidden", "false");
      draw(currentFrame.current);
      root.setAttribute("data-state", "finishing");
      // A timer settles hidden/background loaders too; requestAnimationFrame
      // alone cannot guarantee the completion callback while a page is hidden.
      deadline = window.setTimeout(finish, exitDuration);
    } else {
      root.setAttribute("aria-hidden", "true");
      root.setAttribute("data-state", "idle");
      parts.setAttribute("opacity", "0");
      return;
    }
    motion.addEventListener("change", motionChanged);
    document.addEventListener("visibilitychange", schedule);
    schedule();
    return () => {
      disposed = true;
      cancelFrame();
      window.clearTimeout(deadline);
      motion.removeEventListener("change", motionChanged);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [loading, finishOnMount]);

  // The refs own animated attributes after mount; React only updates SVG props.
  return (
    <svg
      {...props}
      ref={svg}
      width={width}
      height={height}
      viewBox="-8 -8 80 80"
      fill="currentColor"
      role={props.role ?? "img"}
      aria-label={props["aria-label"] ?? "Loading"}
      aria-hidden="true"
      focusable="false"
      data-state="idle"
    >
      <g ref={group} opacity="0">
        <path ref={body} d={satelliteLoaderStill.path} />
        <rect ref={square} x="-7" y="-7" width="14" height="14" transform="translate(48 16)" />
      </g>
    </svg>
  );
}
