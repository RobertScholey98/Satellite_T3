// @effect-diagnostics globalTimers:off -- The native transition owns and cancels its one frame timer.
// @effect-diagnostics globalConsole:off -- Native compositor failure falls back to the retained window.
import * as Electron from "electron";
import type { WindowsDwmApi } from "../electron/WindowsDwm.ts";
import {
  hideWithoutAnimation,
  showInactiveWithoutAnimation,
} from "../electron/WindowsWindowVisibility.ts";

interface TransitionOverlay {
  window: Electron.BaseWindow;
  workspaceThumbnail: bigint;
  scale: number;
}

export interface SatelliteTransitionFrame {
  bounds: Electron.Rectangle;
  widgetBlend: number;
}

export function createSatelliteWindowTransition(
  workspace: Electron.BrowserWindow,
  dwm: WindowsDwmApi,
) {
  const overlays = new Map<number, TransitionOverlay>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let current: SatelliteTransitionFrame | undefined;
  const cancel = () => {
    generation++;
    clearTimeout(timer);
    timer = undefined;
    const previous = current;
    current = undefined;
    for (const overlay of overlays.values())
      if (!overlay.window.isDestroyed()) hideWithoutAnimation(overlay.window);
    return previous;
  };
  const releaseThumbnail = (thumbnail: bigint) => {
    try {
      dwm.unregisterThumbnail(thumbnail);
    } catch (error) {
      console.warn("SatelliteT3 could not release a window thumbnail", error);
    }
  };
  const dispose = () => {
    cancel();
    for (const overlay of overlays.values()) {
      releaseThumbnail(overlay.workspaceThumbnail);
      if (!overlay.window.isDestroyed()) overlay.window.destroy();
    }
    overlays.clear();
  };
  const play = ({
    from,
    to,
    onFrame,
    onComplete,
  }: {
    from: SatelliteTransitionFrame;
    to: SatelliteTransitionFrame;
    onFrame?: (widgetBlend: number) => void;
    onComplete: () => void;
  }): boolean => {
    cancel();
    const id = generation;
    const left = Math.min(from.bounds.x, to.bounds.x);
    const top = Math.min(from.bounds.y, to.bounds.y);
    const right = Math.max(from.bounds.x + from.bounds.width, to.bounds.x + to.bounds.width);
    const bottom = Math.max(from.bounds.y + from.bounds.height, to.bounds.y + to.bounds.height);
    const active: TransitionOverlay[] = [];
    try {
      for (const display of Electron.screen.getAllDisplays()) {
        const area = display.bounds;
        if (
          area.x >= right ||
          area.y >= bottom ||
          area.x + area.width <= left ||
          area.y + area.height <= top
        )
          continue;
        let overlay = overlays.get(display.id);
        if (!overlay) {
          const window = new Electron.BaseWindow({
            title: "Satellite workspace transition",
            ...area,
            show: false,
            frame: false,
            thickFrame: false,
            transparent: true,
            backgroundColor: "#00000000",
            focusable: false,
            skipTaskbar: true,
            alwaysOnTop: true,
            resizable: false,
            hasShadow: false,
          });
          let workspaceThumbnail: bigint | undefined;
          try {
            window.setIgnoreMouseEvents(true);
            dwm.disableTransitions(window.getNativeWindowHandle());
            workspaceThumbnail = dwm.registerThumbnail(
              window.getNativeWindowHandle(),
              workspace.getNativeWindowHandle(),
            );
            overlay = { window, workspaceThumbnail, scale: display.scaleFactor };
            overlays.set(display.id, overlay);
          } catch (error) {
            if (workspaceThumbnail !== undefined) releaseThumbnail(workspaceThumbnail);
            window.destroy();
            throw error;
          }
        }
        active.push(overlay);
      }
      if (active.length === 0) return false;
      const draw = (frame: SatelliteTransitionFrame) => {
        current = frame;
        const { bounds, widgetBlend } = frame;
        for (const overlay of active) {
          const origin = overlay.window.getBounds();
          const destination = {
            x: Math.round((bounds.x - origin.x) * overlay.scale),
            y: Math.round((bounds.y - origin.y) * overlay.scale),
            width: Math.round(bounds.width * overlay.scale),
            height: Math.round(bounds.height * overlay.scale),
          };
          dwm.updateThumbnail(
            overlay.workspaceThumbnail,
            destination,
            Math.round(255 * (1 - widgetBlend)),
          );
        }
        onFrame?.(widgetBlend);
      };
      draw(from);
      for (const overlay of active) showInactiveWithoutAnimation(overlay.window);
      const started = performance.now();
      const frame = () => {
        if (id !== generation) return;
        const progress = Math.min(1, (performance.now() - started) / 220);
        const eased = 1 - (1 - progress) ** 3;
        try {
          draw({
            bounds: {
              x: from.bounds.x + (to.bounds.x - from.bounds.x) * eased,
              y: from.bounds.y + (to.bounds.y - from.bounds.y) * eased,
              width: from.bounds.width + (to.bounds.width - from.bounds.width) * eased,
              height: from.bounds.height + (to.bounds.height - from.bounds.height) * eased,
            },
            widgetBlend: from.widgetBlend + (to.widgetBlend - from.widgetBlend) * eased,
          });
        } catch (error) {
          console.warn("SatelliteT3 could not animate the workspace", error);
          dispose();
          onComplete();
          return;
        }
        if (progress < 1) timer = setTimeout(frame, 16);
        else {
          timer = undefined;
          onComplete();
          if (id === generation) cancel();
        }
      };
      timer = setTimeout(frame, 16);
      return true;
    } catch (error) {
      console.warn("SatelliteT3 could not prepare the workspace animation", error);
      dispose();
      return false;
    }
  };
  return { play, cancel, dispose };
}
