import * as Schema from "effect/Schema";

/** Resolved workspace colors, shared with the isolated pill renderer. */
export const SatellitePillTheme = Schema.Struct({
  "--background": Schema.String,
  "--foreground": Schema.String,
  "--muted-foreground": Schema.String,
  "--border": Schema.String,
  "--primary": Schema.String,
  "--ring": Schema.String,
  "--warning": Schema.String,
  "--success": Schema.String,
  "--destructive": Schema.String,
  "--font-sans": Schema.String,
});
export type SatellitePillTheme = typeof SatellitePillTheme.Type;

/** A view of the selected conversation; the renderer owns its source of truth. */
export const SatellitePillState = Schema.Struct({
  threadId: Schema.NullOr(Schema.String),
  environmentId: Schema.NullOr(Schema.String),
  title: Schema.String,
  state: Schema.Literals(["working", "awaiting-input", "completed", "idle", "unknown", "error"]),
  detail: Schema.String,
  attention: Schema.Boolean,
  theme: Schema.optionalKey(SatellitePillTheme),
});
export type SatellitePillState = typeof SatellitePillState.Type;

/** The retained workspace and native pill have independent window geometry. */
export interface SatelliteShellState {
  readonly mode: "pill" | "workspace";
  readonly pinned?: boolean;
}

export type SatelliteMoveDirection = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

export interface SatelliteBridge {
  readonly publish: (state: SatellitePillState) => void;
  readonly hideMain: () => void;
  readonly setPinned: (pinned: boolean) => void;
  readonly onShellState: (listener: (state: SatelliteShellState) => void) => () => void;
}

/** Only the standalone pill renderer receives these capabilities. */
export interface SatellitePillBridge {
  readonly openMain: () => void;
  readonly showMenu: () => void;
  readonly movePill: (direction: SatelliteMoveDirection) => void;
  readonly beginPillDrag: () => void;
  readonly onPillState: (listener: (state: SatellitePillState) => void) => () => void;
}
