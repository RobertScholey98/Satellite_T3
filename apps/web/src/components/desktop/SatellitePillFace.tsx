import type {
  SatelliteAttentionSummary,
  SatellitePillBridge,
  SatellitePillLayout,
  SatellitePillState,
} from "@t3tools/contracts";
import { BellIcon, BellOffIcon, PanelTopIcon } from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { randomUUID } from "../../lib/utils";
import { pendingRequestKey } from "../../pendingRequestStore";
import { SatelliteActionPanel } from "./SatelliteActionWing";

const INITIAL_PILL: SatellitePillState = {
  threadId: null,
  environmentId: null,
  title: "SatelliteT3",
  detail: "Waiting for conversation state",
  state: "unknown",
  attention: false,
};

/** Transfer one thresholded gesture to native capture. A later click belongs to the drag until a new press. */
export function SatellitePillFace({ bridge }: { bridge: SatellitePillBridge }) {
  const [pill, setPill] = useState(INITIAL_PILL);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const [layout, setLayout] = useState<SatellitePillLayout>({
    mode: "compact",
    width: 252,
    height: 56,
    pill: { x: 0, y: 0, width: 252, height: 56 },
    wing: null,
    panel: null,
  });
  const [peek, setPeek] = useState<SatelliteAttentionSummary | null>(null);
  const wingButton = useRef<HTMLButtonElement>(null);
  const knownRequests = useRef(new Set<string>());
  const peekTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingLayout = useRef<{
    requestId: string;
    mode: SatellitePillLayout["mode"];
    explicit: boolean;
  } | null>(null);
  const view = pill.actionWing;
  const mode = layout.mode;
  const visibleCount = view?.items.filter((item) => !item.muted).length ?? 0;
  const displayedCount =
    visibleCount || (view?.incompleteEnvironments.length ? "?" : (view?.items.length ?? 0));
  const hasWing = (view?.items.length ?? 0) > 0 || (view?.incompleteEnvironments.length ?? 0) > 0;
  const requestLayout = useCallback(
    (nextMode: SatellitePillLayout["mode"], explicit = false) => {
      const requestId = randomUUID();
      pendingLayout.current = { requestId, mode: nextMode, explicit };
      bridge.setLayout({ requestId, mode: nextMode, wing: hasWing });
    },
    [bridge, hasWing],
  );
  const closePanel = useCallback(() => {
    requestLayout("compact", true);
    wingButton.current?.focus();
  }, [requestLayout]);
  useEffect(() => {
    return bridge.onLayout((nextLayout) => {
      if (nextLayout.requestId === pendingLayout.current?.requestId) pendingLayout.current = null;
      setLayout(nextLayout);
    });
  }, [bridge]);
  const readRequestedMode = useEffectEvent(() => pendingLayout.current?.mode ?? mode);
  useEffect(() => {
    requestLayout(readRequestedMode(), pendingLayout.current?.explicit ?? false);
  }, [requestLayout]);
  const finishPeek = useEffectEvent(() => {
    if ((pendingLayout.current?.mode ?? mode) === "preview") requestLayout("compact");
  });
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", pill.dark === true);
    root.style.colorScheme = pill.dark ? "dark" : "light";
    for (const [key, value] of Object.entries(pill.theme ?? {}))
      root.style.setProperty(key, value ?? "");
  }, [pill.dark, pill.theme]);
  const updateAttention = useEffectEvent((nextView: SatellitePillState["actionWing"]) => {
    if (!nextView) return;
    const visible = nextView.items.filter((item) => !item.muted);
    const arrival = visible.findLast(
      (item) => !knownRequests.current.has(pendingRequestKey(item.ref)),
    );
    knownRequests.current = new Set(nextView.items.map((item) => pendingRequestKey(item.ref)));
    if (arrival) {
      setPeek(arrival);
      if (!pendingLayout.current?.explicit && (pendingLayout.current?.mode ?? mode) !== "panel")
        requestLayout("preview");
      clearTimeout(peekTimer.current);
      peekTimer.current = setTimeout(() => finishPeek(), 5_000);
    }
    if (
      !nextView.items.length &&
      !nextView.incompleteEnvironments.length &&
      (pendingLayout.current?.mode ?? mode) !== "compact"
    )
      requestLayout("compact");
  });
  useEffect(() => {
    updateAttention(view);
  }, [view]);
  useEffect(() => () => clearTimeout(peekTimer.current), []);
  const gesture = useRef<{
    pointerId: number;
    x: number;
    y: number;
    handedOff: boolean;
    target: Element;
  } | null>(null);
  const suppressClick = useRef(false);
  useEffect(() => bridge.onPillState(setPill), [bridge]);
  return (
    <>
      <div
        data-satellite="pill"
        style={{
          left: layout.pill.x,
          top: layout.pill.y,
          width: layout.pill.width,
          height: layout.pill.height,
        }}
        data-wing-side={layout.wing ? "right" : undefined}
        data-state={pill.state}
        data-keyboard-focus={keyboardFocus || undefined}
        onKeyDown={(event) => {
          setKeyboardFocus(true);
          if (
            event.altKey &&
            (event.key === "ArrowLeft" ||
              event.key === "ArrowRight" ||
              event.key === "ArrowUp" ||
              event.key === "ArrowDown")
          ) {
            event.preventDefault();
            bridge.movePill(event.key);
          }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          setKeyboardFocus(false);
          suppressClick.current = false;
          const target =
            event.target instanceof Element
              ? (event.target.closest("button") ?? event.currentTarget)
              : event.currentTarget;
          gesture.current = {
            target,
            pointerId: event.pointerId,
            x: event.screenX,
            y: event.screenY,
            handedOff: false,
          };
          target.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const current = gesture.current;
          if (!current || current.pointerId !== event.pointerId || current.handedOff) return;
          if (Math.hypot(event.screenX - current.x, event.screenY - current.y) < 6) return;
          current.handedOff = true;
          suppressClick.current = true;
          event.preventDefault();
          if (current.target.hasPointerCapture(event.pointerId))
            current.target.releasePointerCapture(event.pointerId);
          bridge.beginPillDrag();
        }}
        onPointerUp={() => {
          gesture.current = null;
        }}
        onPointerCancel={() => {
          gesture.current = null;
        }}
        onLostPointerCapture={() => {
          gesture.current = null;
        }}
        onClickCapture={(event) => {
          if (suppressClick.current && event.detail !== 0) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        <button
          type="button"
          data-satellite="pill-content"
          aria-label="Expand SatelliteT3"
          onClick={() => bridge.openMain()}
        >
          <PanelTopIcon data-satellite="pill-icon" aria-hidden="true" />
          <span data-satellite="pill-copy">
            <span data-satellite="pill-title">{view ? "Satellite" : pill.title}</span>
            <span data-satellite="pill-detail">
              {view
                ? `${view.workingCount} working · ${view.completedCount} finished${view.incompleteEnvironments.length ? " · offline" : ""}`
                : pill.detail}
            </span>
          </span>
        </button>
        {pill.attention && !view ? (
          <span data-satellite="pill-attention" aria-label="Needs your attention">
            !
          </span>
        ) : null}
      </div>
      {layout.wing && view ? (
        <button
          ref={wingButton}
          type="button"
          data-satellite="action-wing"
          data-side="right"
          data-preview={mode === "preview" || undefined}
          style={{
            left: layout.wing.x,
            top: layout.wing.y,
            width: layout.wing.width,
            height: layout.wing.height,
          }}
          aria-label={
            visibleCount
              ? `${visibleCount} requests need attention${view.incompleteEnvironments.length ? ", count incomplete" : ""}`
              : view.items.length
                ? `Show ${view.items.length} muted requests`
                : "Request status unavailable"
          }
          aria-haspopup="dialog"
          aria-expanded={mode === "panel"}
          onClick={() => {
            clearTimeout(peekTimer.current);
            requestLayout(
              (pendingLayout.current?.mode ?? mode) === "panel" ? "compact" : "panel",
              true,
            );
          }}
        >
          <span data-satellite="wing-count">
            {visibleCount ? <BellIcon /> : <BellOffIcon />}
            <strong>
              {typeof displayedCount === "number" && displayedCount > 99 ? "99+" : displayedCount}
            </strong>
          </span>
          {mode === "preview" && peek ? (
            <span data-satellite="action-preview">
              <strong>{peek.title}</strong>
              <span>{peek.preview || peek.label}</span>
            </span>
          ) : null}
        </button>
      ) : null}
      {mode === "panel" && layout.panel && view ? (
        <SatelliteActionPanel
          view={view}
          layout={layout}
          dispatch={bridge.dispatchIntent}
          close={closePanel}
        />
      ) : null}
      <span data-satellite="announcement" role="status" aria-live="polite">
        {view
          ? view.incompleteEnvironments.length
            ? `${visibleCount} known requests. Request count is incomplete.`
            : visibleCount
              ? `${visibleCount} requests need your attention.`
              : "No requests need your attention."
          : pill.detail}
      </span>
    </>
  );
}
