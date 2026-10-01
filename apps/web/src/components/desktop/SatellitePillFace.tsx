import type { SatellitePillBridge, SatellitePillState } from "@t3tools/contracts";
import { MoreVerticalIcon } from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";

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
    <div
      data-satellite="pill"
      style={pill.theme as CSSProperties | undefined}
      data-state={pill.state}
      data-keyboard-focus={keyboardFocus || undefined}
      aria-live="polite"
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
      <span data-satellite="pill-dot" aria-hidden="true" />
      <button
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
  );
}
