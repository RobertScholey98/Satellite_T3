import type { SatelliteBridge, SatellitePillState, SatelliteShellState } from "@t3tools/contracts";
import { Minimize2Icon, MoreVerticalIcon, PinIcon, PinOffIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import "./SatelliteDesktopShell.css";

const INITIAL_SHELL: SatelliteShellState = {
  mode: "pill",
  phase: "settled",
  transitionId: 0,
  pillBounds: { x: 0, y: 0, width: 320, height: 70 },
  workspaceSize: { width: 1200, height: 800 },
};
const INITIAL_PILL: SatellitePillState = {
  threadId: null,
  environmentId: null,
  title: "SatelliteT3",
  detail: "Waiting for conversation state",
  state: "unknown",
  attention: false,
};

function subscribeToViewportResize(onChange: () => void) {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

/** The workspace stays mounted so collapsing never interrupts a conversation or browser session. */
export function SatelliteDesktopShell({
  bridge,
  children,
}: {
  bridge: SatelliteBridge;
  children: ReactNode;
}) {
  const [shell, setShell] = useState(INITIAL_SHELL);
  const [pill, setPill] = useState(INITIAL_PILL);
  const [pillKeyboardFocus, setPillKeyboardFocus] = useState(false);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const pillGestureRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    dragged: boolean;
    captureTarget: Element;
    frame: number | null;
  } | null>(null);
  const suppressPillClickRef = useRef(false);
  const interruptedMotionRef = useRef<{
    surface: {
      left: string;
      top: string;
      width: string;
      height: string;
      borderRadius: string;
      backgroundColor: string;
      borderColor: string;
    };
    workspaceOpacity: string;
    workspaceTransform: string;
    pillOpacity: string;
  } | null>(null);
  const workspaceActive = shell.mode === "workspace" && shell.phase === "settled";
  const pillVisible = shell.mode === "pill" || shell.phase !== "settled";
  const zoomFactor = useSyncExternalStore(subscribeToViewportResize, bridge.getZoomFactor);
  // Native and renderer viewport widths round differently at fractional display
  // scales. Use Chromium's exact zoom so the pill keeps its native size and anchor.
  const canvasScale = 1 / zoomFactor;
  const pillMode = shell.mode === "pill";
  const collapsedSurface = useMemo(
    () => ({
      left: `${shell.pillBounds.x * canvasScale}px`,
      top: `${shell.pillBounds.y * canvasScale}px`,
      width: `${shell.pillBounds.width * canvasScale}px`,
      height: `${shell.pillBounds.height * canvasScale}px`,
      borderRadius: `${35 * canvasScale}px`,
      backgroundColor: "#181a1e",
      borderColor: "#363d47",
    }),
    [
      shell.pillBounds.x,
      shell.pillBounds.y,
      shell.pillBounds.width,
      shell.pillBounds.height,
      canvasScale,
    ],
  );
  const expandedSurface = useMemo(
    () => ({
      left: "0px",
      top: "0px",
      width: `${shell.workspaceSize.width * canvasScale}px`,
      height: `${shell.workspaceSize.height * canvasScale}px`,
      borderRadius: `${14 * canvasScale}px`,
      backgroundColor: "var(--background)",
      borderColor: "var(--border)",
    }),
    [shell.workspaceSize.width, shell.workspaceSize.height, canvasScale],
  );
  const targetSurface = pillMode ? collapsedSurface : expandedSurface;
  const { phase, transitionId } = shell;

  const finishPillDrag = useCallback(() => {
    const gesture = pillGestureRef.current;
    if (!gesture) return;
    pillGestureRef.current = null;
    if (gesture.frame !== null) window.cancelAnimationFrame(gesture.frame);
    if (gesture.dragged) bridge.endPillDrag();
    if (gesture.captureTarget.hasPointerCapture(gesture.pointerId)) {
      gesture.captureTarget.releasePointerCapture(gesture.pointerId);
    }
  }, [bridge]);

  useEffect(() => {
    if (!pillMode || phase !== "settled") finishPillDrag();
    return finishPillDrag;
  }, [finishPillDrag, pillMode, phase]);

  useEffect(() => {
    // Subscribe before ready asks the native shell to send both initial snapshots.
    const unsubscribePill = bridge.onPillState(setPill);
    const unsubscribeShell = bridge.onShellState((state) => {
      if (
        state.phase === "collapsing" &&
        document.activeElement instanceof HTMLElement &&
        document.activeElement !== document.body &&
        !pillRef.current?.contains(document.activeElement)
      ) {
        previousFocusRef.current = document.activeElement;
      }
      setShell(state);
    });
    return () => {
      unsubscribeShell();
      unsubscribePill();
    };
  }, [bridge]);

  useLayoutEffect(() => {
    document.documentElement.dataset.satelliteMode = workspaceActive ? "workspace" : "pill";
    return () => {
      delete document.documentElement.dataset.satelliteMode;
    };
  }, [workspaceActive]);

  useLayoutEffect(() => {
    if (workspaceActive) {
      if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus();
      return;
    }
    if (shell.phase === "settled") openRef.current?.focus({ preventScroll: true });
  }, [workspaceActive, shell.phase]);

  useLayoutEffect(() => {
    // Install before workspace effects attach global shortcuts. Inert affects DOM
    // controls, but does not suspend those window listeners while the pill has focus.
    const guardPillKeyboard = (event: KeyboardEvent) => {
      if (document.documentElement.dataset.satelliteMode !== "pill") return;
      if (event.type === "keydown") setPillKeyboardFocus(true);
      const nativeQuit =
        ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "q") ||
        (event.altKey && event.key === "F4");
      if (nativeQuit) return;
      event.stopImmediatePropagation();
      if (
        event.altKey &&
        (event.key === "ArrowLeft" ||
          event.key === "ArrowRight" ||
          event.key === "ArrowUp" ||
          event.key === "ArrowDown")
      ) {
        event.preventDefault();
        if (event.type === "keydown") bridge.movePill(event.key);
        return;
      }
      // Default button activation and tab navigation still work; workspace
      // shortcuts and dialog Escape handlers must not consume these events.
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        !["Tab", "Enter", " "].includes(event.key)
      ) {
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", guardPillKeyboard, true);
    window.addEventListener("keyup", guardPillKeyboard, true);
    return () => {
      window.removeEventListener("keydown", guardPillKeyboard, true);
      window.removeEventListener("keyup", guardPillKeyboard, true);
    };
  }, [bridge]);

  useLayoutEffect(() => {
    if (phase === "settled") {
      interruptedMotionRef.current = null;
      return;
    }
    const surface = surfaceRef.current;
    const workspace = workspaceRef.current;
    const pillElement = pillRef.current;
    if (!surface || !workspace || !pillElement) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      interruptedMotionRef.current = null;
      bridge.finishTransition(transitionId);
      return;
    }
    const expanding = phase === "expanding";
    const interrupted = interruptedMotionRef.current;
    interruptedMotionRef.current = null;
    const animations = [
      surface.animate(
        [interrupted?.surface ?? (expanding ? collapsedSurface : expandedSurface), targetSurface],
        { duration: 500, easing: "cubic-bezier(.2,.75,.2,1)", fill: "both" },
      ),
      workspace.animate(
        [
          { opacity: interrupted?.workspaceOpacity ?? (expanding ? 0 : 1) },
          { opacity: expanding ? 1 : 0 },
        ],
        {
          duration: expanding ? 220 : 120,
          delay: expanding ? 140 : 0,
          easing: "ease",
          fill: "both",
        },
      ),
      workspace.animate(
        [
          {
            transform:
              interrupted?.workspaceTransform ??
              (expanding ? "translateY(8px)" : "translateY(0px)"),
          },
          { transform: expanding ? "translateY(0px)" : "translateY(8px)" },
        ],
        {
          duration: expanding ? 350 : 180,
          delay: expanding ? 100 : 0,
          easing: "ease",
          fill: "both",
        },
      ),
      pillElement.animate(
        [
          { opacity: interrupted?.pillOpacity ?? (expanding ? 1 : 0) },
          { opacity: expanding ? 0 : 1 },
        ],
        {
          duration: expanding ? 100 : 160,
          delay: expanding ? 0 : 180,
          easing: "ease",
          fill: "both",
        },
      ),
    ];
    let cancelled = false;
    let completed = false;
    void Promise.all(animations.map((animation) => animation.finished)).then(
      () => {
        if (!cancelled) {
          completed = true;
          bridge.finishTransition(transitionId);
        }
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
      if (!completed) {
        // A blur or second click can reverse the morph. Continue from its visible
        // frame before cancelling the old animations, rather than either endpoint.
        const visibleSurface = getComputedStyle(surface);
        interruptedMotionRef.current = {
          surface: {
            left: visibleSurface.left,
            top: visibleSurface.top,
            width: visibleSurface.width,
            height: visibleSurface.height,
            borderRadius: visibleSurface.borderTopLeftRadius,
            backgroundColor: visibleSurface.backgroundColor,
            borderColor: visibleSurface.borderTopColor,
          },
          workspaceOpacity: getComputedStyle(workspace).opacity,
          workspaceTransform: getComputedStyle(workspace).transform,
          pillOpacity: getComputedStyle(pillElement).opacity,
        };
      }
      for (const animation of animations) animation.cancel();
    };
  }, [bridge, collapsedSurface, expandedSurface, targetSurface, phase, transitionId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (!workspaceActive) return;
      if (event.key !== "Escape") return;
      const overlay = document.querySelector(
        '[role="dialog"], [role="alertdialog"], [role="menu"], [data-slot="popover-popup"]',
      );
      if (overlay) return;
      event.preventDefault();
      bridge.hideMain();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [bridge, workspaceActive]);

  return (
    <div data-satellite="shell" data-phase={shell.phase} data-mode={shell.mode}>
      <div
        ref={surfaceRef}
        data-satellite="shell-surface"
        style={{
          ...targetSurface,
          borderWidth: canvasScale,
        }}
      >
        <div
          ref={workspaceRef}
          data-satellite="workspace"
          inert={!workspaceActive}
          style={{
            width: shell.workspaceSize.width * canvasScale - 2 * canvasScale,
            height: shell.workspaceSize.height * canvasScale - 2 * canvasScale,
            opacity: pillMode ? 0 : 1,
            transform: pillMode ? "translateY(8px)" : "translateY(0px)",
          }}
        >
          {children}
          <div data-satellite="window-controls">
            <button
              type="button"
              aria-label={shell.pinned ? "Unpin workspace" : "Keep workspace open"}
              aria-pressed={shell.pinned ?? false}
              onClick={() => bridge.setPinned(!shell.pinned)}
            >
              {shell.pinned ? <PinOffIcon /> : <PinIcon />}
            </button>
            <button type="button" aria-label="Collapse to pill" onClick={() => bridge.hideMain()}>
              <Minimize2Icon />
            </button>
          </div>
        </div>
        <div
          ref={pillRef}
          data-satellite="pill"
          data-state={pill.state}
          data-keyboard-focus={pillKeyboardFocus || undefined}
          aria-hidden={!pillVisible}
          // Base UI preserves live regions outside modals. Keep this status
          // surface reachable when a dialog stays open in the collapsed workspace.
          aria-live="polite"
          inert={!pillVisible || shell.phase !== "settled"}
          onPointerDown={(event) => {
            setPillKeyboardFocus(false);
            if (!pillMode || phase !== "settled" || event.button !== 0 || pillGestureRef.current) {
              return;
            }
            const button = event.target instanceof Element ? event.target.closest("button") : null;
            const captureTarget =
              button && event.currentTarget.contains(button) ? button : event.currentTarget;
            suppressPillClickRef.current = false;
            pillGestureRef.current = {
              pointerId: event.pointerId,
              startX: event.screenX,
              startY: event.screenY,
              dragged: false,
              captureTarget,
              frame: null,
            };
            // Capture persistent controls rather than status children that may
            // disappear during a drag, while preserving normal button clicks.
            captureTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const gesture = pillGestureRef.current;
            if (!gesture || gesture.pointerId !== event.pointerId) return;
            if (!gesture.dragged) {
              if (Math.hypot(event.screenX - gesture.startX, event.screenY - gesture.startY) < 6) {
                return;
              }
              gesture.dragged = true;
              suppressPillClickRef.current = true;
              bridge.beginPillDrag();
            }
            event.preventDefault();
            if (gesture.frame === null) {
              gesture.frame = window.requestAnimationFrame(() => {
                gesture.frame = null;
                if (pillGestureRef.current === gesture) bridge.updatePillDrag();
              });
            }
          }}
          onPointerUp={(event) => {
            if (pillGestureRef.current?.pointerId === event.pointerId) finishPillDrag();
          }}
          onPointerCancel={(event) => {
            if (pillGestureRef.current?.pointerId === event.pointerId) finishPillDrag();
          }}
          onLostPointerCapture={(event) => {
            if (pillGestureRef.current?.pointerId === event.pointerId) finishPillDrag();
          }}
          onClickCapture={(event) => {
            if (suppressPillClickRef.current && event.detail !== 0) {
              event.preventDefault();
              event.stopPropagation();
            }
            suppressPillClickRef.current = false;
          }}
          style={{
            width: `${100 / canvasScale}%`,
            height: `${100 / canvasScale}%`,
            transform: `scale(${canvasScale})`,
            transformOrigin: "0 0",
            opacity: shell.mode === "pill" ? 1 : 0,
          }}
        >
          <span data-satellite="pill-dot" aria-hidden="true" />
          <button
            ref={openRef}
            type="button"
            data-satellite="pill-content"
            aria-label="Expand SatelliteT3"
            onClick={() => bridge.openMain()}
          >
            <span data-satellite="pill-title">{pill.title}</span>
            <span data-satellite="pill-detail">{pill.detail}</span>
          </button>
          {pill.attention ? (
            <span data-satellite="pill-attention" aria-label="Needs your attention">
              !
            </span>
          ) : null}
          <button
            type="button"
            data-satellite="pill-menu"
            aria-label="SatelliteT3 menu"
            onClick={() => bridge.showMenu()}
          >
            <MoreVerticalIcon />
          </button>
        </div>
      </div>
    </div>
  );
}
