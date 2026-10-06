import type { SatelliteBridge, SatelliteShellState } from "@t3tools/contracts";
import { LinkIcon, UnlinkIcon, Minimize2Icon, PinIcon, PinOffIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import "./SatelliteDesktopShell.css";

/** Native hiding retains the workspace, its conversation, and its browser sessions. */
export function SatelliteDesktopShell({
  bridge,
  children,
}: {
  bridge: SatelliteBridge;
  children: ReactNode;
}) {
  const [shell, setShell] = useState<SatelliteShellState>({ mode: "pill", pinned: false });
  const positionsLinked = shell.positionsLinked ?? true;
  const linkLabel = positionsLinked
    ? "Unlink pill and window positions"
    : "Link pill and window positions";
  const previousFocus = useRef<HTMLElement | null>(null);
  const previousMode = useRef<SatelliteShellState["mode"]>("pill");
  useEffect(
    () =>
      bridge.onShellState((state) => {
        if (
          previousMode.current === "workspace" &&
          state.mode === "pill" &&
          document.activeElement instanceof HTMLElement
        ) {
          previousFocus.current = document.activeElement;
        }
        previousMode.current = state.mode;
        setShell(state);
      }),
    [bridge],
  );
  useLayoutEffect(() => {
    document.documentElement.dataset.satelliteMode = shell.mode;
    if (shell.mode === "workspace" && previousFocus.current?.isConnected)
      previousFocus.current.focus();
    return () => {
      delete document.documentElement.dataset.satelliteMode;
    };
  }, [shell.mode]);
  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (
        shell.mode !== "workspace" ||
        event.defaultPrevented ||
        event.isComposing ||
        event.key !== "Escape"
      )
        return;
      if (
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [data-slot="popover-popup"]',
        )
      )
        return;
      event.preventDefault();
      bridge.hideMain();
    };
    window.addEventListener("keydown", keyDown);
    return () => window.removeEventListener("keydown", keyDown);
  }, [bridge, shell.mode]);
  return (
    <div data-satellite="shell" data-mode={shell.mode}>
      <div data-satellite="workspace" inert={shell.mode !== "workspace"}>
        {children}
        <div data-satellite="window-controls">
          <Tooltip>
            <TooltipTrigger
              render={<button type="button" />}
              aria-label={linkLabel}
              aria-pressed={positionsLinked}
              onClick={() => bridge.setPositionsLinked(!positionsLinked)}
            >
              {positionsLinked ? <LinkIcon /> : <UnlinkIcon />}
            </TooltipTrigger>
            <TooltipPopup side="bottom">{linkLabel}</TooltipPopup>
          </Tooltip>
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
    </div>
  );
}
