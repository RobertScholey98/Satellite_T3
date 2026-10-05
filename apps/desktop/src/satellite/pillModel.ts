import type {
  SatellitePillLayout,
  SatellitePillLayoutRequest,
  SatellitePillState,
} from "@t3tools/contracts";

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
  const width = Math.min(PILL_SIZE.width, area.width);
  const height = Math.min(PILL_SIZE.height, area.height);
  return {
    width,
    height,
    x: Math.round(Math.max(area.x, Math.min(target.x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(target.y, area.y + area.height - height))),
  };
}

function nearestWorkArea(
  bounds: PillRectangle,
  workAreas: readonly PillRectangle[],
): PillRectangle {
  const primary = workAreas[0] ?? { x: 0, y: 0, width: 1920, height: 1080 };
  const distance = (area: PillRectangle) => {
    const x = Math.max(area.x, Math.min(bounds.x, area.x + Math.max(0, area.width - bounds.width)));
    const y = Math.max(
      area.y,
      Math.min(bounds.y, area.y + Math.max(0, area.height - bounds.height)),
    );
    return (x - bounds.x) ** 2 + (y - bounds.y) ** 2;
  };
  return workAreas.reduce(
    (nearest, candidate) => (distance(candidate) < distance(nearest) ? candidate : nearest),
    primary,
  );
}

export function resolvePillLayout(
  anchor: PillRectangle,
  request: SatellitePillLayoutRequest,
  workAreas: readonly PillRectangle[],
) {
  const pill = clampPillBounds(anchor, workAreas);
  const area = nearestWorkArea(pill, workAreas);
  const right = area.x + area.width;
  const bottom = area.y + area.height;
  const leftSpace = pill.x - area.x;
  const rightSpace = right - pill.x - pill.width;
  const wingOnRight = rightSpace >= leftSpace;
  const wingSpace = Math.max(leftSpace, rightSpace);
  const wingWidth = Math.min(request.mode === "preview" ? 320 : 90, Math.max(0, wingSpace));
  let wing: PillRectangle | null = null;
  if (request.wing && wingWidth > 0) {
    wing = {
      x: wingOnRight ? pill.x + pill.width : pill.x - wingWidth,
      y: pill.y,
      width: wingWidth,
      height: pill.height,
    };
  } else if (request.wing) {
    const below = bottom - pill.y - pill.height;
    const above = pill.y - area.y;
    const height = Math.min(pill.height, Math.max(above, below));
    if (height > 0) {
      wing = {
        x: pill.x,
        y: below >= above ? pill.y + pill.height : pill.y - height,
        width: Math.min(request.mode === "preview" ? 320 : 90, pill.width),
        height,
      };
    }
  }
  const rowTop = Math.min(pill.y, wing?.y ?? pill.y);
  const rowBottom = Math.max(pill.y + pill.height, wing ? wing.y + wing.height : 0);
  const rowRight = Math.max(pill.x + pill.width, wing ? wing.x + wing.width : pill.x);
  const above = rowTop - area.y - 12;
  const below = bottom - rowBottom - 12;
  const panelBelow = below >= above;
  const panelHeight = Math.min(request.panelHeight ?? 500, Math.max(above, below));
  let panel: PillRectangle | null = null;
  if (request.mode === "panel" && panelHeight > 0) {
    const width = Math.min(440, area.width);
    panel = {
      x: Math.round(Math.max(area.x, Math.min(rowRight - width, right - width))),
      y: panelBelow ? rowBottom + 12 : rowTop - panelHeight - 12,
      width,
      height: panelHeight,
    };
  }
  const regions = [pill, ...(wing ? [wing] : []), ...(panel ? [panel] : [])];
  const x = Math.min(...regions.map((rect) => rect.x));
  const y = Math.min(...regions.map((rect) => rect.y));
  const width = Math.max(...regions.map((rect) => rect.x + rect.width)) - x;
  const height = Math.max(...regions.map((rect) => rect.y + rect.height)) - y;
  const local = (rect: PillRectangle): PillRectangle => ({ ...rect, x: rect.x - x, y: rect.y - y });
  const layout: SatellitePillLayout = {
    mode: request.mode === "panel" && !panel ? "compact" : request.mode,
    width,
    height,
    pill: local(pill),
    wing: wing ? local(wing) : null,
    panel: panel ? local(panel) : null,
  };
  return { bounds: { x, y, width, height }, layout, shape: regions.map(local) };
}

function normalizedAnchor(position: number, origin: number, span: number, fallback = 0.5) {
  return span > 0 ? Math.max(0, Math.min(1, (position - origin) / span)) : fallback;
}

function collapseAnchor(position: number, origin: number, span: number, savedAnchor: number) {
  // Reuse an unchanged anchor so repeated open/close cycles cannot accumulate pixel rounding.
  return span <= 0 || Math.round(origin + savedAnchor * span) === position
    ? savedAnchor
    : normalizedAnchor(position, origin, span);
}

/** Expand around the pill's relative position within its monitor's work area. */
export function resolveWorkspaceBounds(
  pillBounds: PillRectangle,
  workspaceSize: { readonly width: number; readonly height: number },
  workAreas: readonly PillRectangle[],
): PillRectangle {
  const area = nearestWorkArea(pillBounds, workAreas);
  const width = Math.min(workspaceSize.width, area.width);
  const height = Math.min(workspaceSize.height, area.height);
  const x = normalizedAnchor(pillBounds.x, area.x, area.width - pillBounds.width);
  const y = normalizedAnchor(pillBounds.y, area.y, area.height - pillBounds.height);
  return {
    x: Math.round(area.x + x * (area.width - width)),
    y: Math.round(area.y + y * (area.height - height)),
    width,
    height,
  };
}

/** Collapse at the workspace's anchor, retaining the saved anchor on axes filled by the workspace. */
export function resolvePillBounds(
  workspaceBounds: PillRectangle,
  workAreas: readonly PillRectangle[],
  previousPillBounds?: PillRectangle,
): PillRectangle {
  const area = nearestWorkArea(workspaceBounds, workAreas);
  const width = Math.min(PILL_SIZE.width, area.width);
  const height = Math.min(PILL_SIZE.height, area.height);
  const previousX = previousPillBounds
    ? normalizedAnchor(previousPillBounds.x, area.x, area.width - previousPillBounds.width)
    : 0.5;
  const previousY = previousPillBounds
    ? normalizedAnchor(previousPillBounds.y, area.y, area.height - previousPillBounds.height)
    : 0.5;
  const x = collapseAnchor(
    workspaceBounds.x,
    area.x,
    area.width - workspaceBounds.width,
    previousX,
  );
  const y = collapseAnchor(
    workspaceBounds.y,
    area.y,
    area.height - workspaceBounds.height,
    previousY,
  );
  return {
    x: Math.round(area.x + x * (area.width - width)),
    y: Math.round(area.y + y * (area.height - height)),
    width,
    height,
  };
}

export function unavailablePillState(previous?: SatellitePillState): SatellitePillState {
  return {
    ...(previous?.theme ? { theme: previous.theme } : {}),
    ...(previous?.dark !== undefined ? { dark: previous.dark } : {}),
    threadId: previous?.threadId ?? null,
    environmentId: previous?.environmentId ?? null,
    title: previous?.title ?? "SatelliteT3",
    state: "unknown",
    detail: previous ? "Status unavailable — reconnecting" : "Waiting for conversation state",
    attention: false,
    ...(previous?.actionWing
      ? {
          actionWing: {
            ...previous.actionWing,
            items: previous.actionWing.items.map((item) => ({ ...item, available: false })),
            selected: previous.actionWing.selected
              ? { ...previous.actionWing.selected, status: "unavailable" as const }
              : null,
            incompleteEnvironments: [
              ...new Set([
                ...previous.actionWing.incompleteEnvironments,
                ...previous.actionWing.items.map((item) => item.environmentName),
              ]),
            ],
          },
        }
      : {}),
  };
}

/** Native close returns to the pill, preserving subscriptions and active work. */
export function handleMainClose(
  event: { preventDefault: () => void },
  quitting: boolean,
  hide: () => void,
): void {
  if (quitting) return;
  event.preventDefault();
  hide();
}
