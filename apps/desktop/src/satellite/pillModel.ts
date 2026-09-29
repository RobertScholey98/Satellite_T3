import type { SatellitePillState } from "@t3tools/contracts";

export const PILL_SIZE = { width: 320, height: 70 } as const;
export interface PillRectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Keep the entire pill in the nearest work area after display or scale changes. */
export function clampPillBounds(
  position: { readonly x: number; readonly y: number } | null,
  workAreas: readonly PillRectangle[],
): PillRectangle {
  const primary = workAreas[0] ?? { x: 0, y: 0, width: 1920, height: 1080 };
  const target = position ?? {
    x: primary.x + primary.width - PILL_SIZE.width - 24,
    y: primary.y + primary.height - PILL_SIZE.height - 24,
  };
  const distance = (area: PillRectangle) => {
    const x = Math.max(area.x, Math.min(target.x, area.x + area.width - PILL_SIZE.width));
    const y = Math.max(area.y, Math.min(target.y, area.y + area.height - PILL_SIZE.height));
    return (x - target.x) ** 2 + (y - target.y) ** 2;
  };
  const area = workAreas.reduce(
    (nearest, candidate) => (distance(candidate) < distance(nearest) ? candidate : nearest),
    primary,
  );
  return {
    ...PILL_SIZE,
    x: Math.round(Math.max(area.x, Math.min(target.x, area.x + area.width - PILL_SIZE.width))),
    y: Math.round(Math.max(area.y, Math.min(target.y, area.y + area.height - PILL_SIZE.height))),
  };
}

export function unavailablePillState(previous?: SatellitePillState): SatellitePillState {
  return {
    threadId: previous?.threadId ?? null,
    environmentId: previous?.environmentId ?? null,
    title: previous?.title ?? "SatelliteT3",
    state: "unknown",
    detail: previous ? "Status unavailable — reconnecting" : "Waiting for conversation state",
    attention: false,
  };
}

/** Closing the workspace hides its renderer, preserving subscriptions and active work. */
export function handleMainClose(
  event: { preventDefault: () => void },
  quitting: boolean,
  hide: () => void,
): void {
  if (quitting) return;
  event.preventDefault();
  hide();
}
