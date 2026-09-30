import * as Schema from "effect/Schema";

/** A view of the selected conversation; the renderer owns its source of truth. */
export const SatellitePillState = Schema.Struct({
  threadId: Schema.NullOr(Schema.String),
  environmentId: Schema.NullOr(Schema.String),
  title: Schema.String,
  state: Schema.Literals(["working", "awaiting-input", "completed", "idle", "unknown", "error"]),
  detail: Schema.String,
  attention: Schema.Boolean,
});
export type SatellitePillState = typeof SatellitePillState.Type;

/** Geometry is in native device-independent pixels relative to the current window canvas. */
export interface SatelliteShellState {
  readonly mode: "pill" | "workspace";
  readonly phase: "settled" | "expanding" | "collapsing";
  readonly transitionId: number;
  readonly pillBounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly workspaceSize: { readonly width: number; readonly height: number };
  readonly pinned?: boolean;
}

export type SatelliteMoveDirection = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

export interface SatelliteBridge {
  readonly getZoomFactor: () => number;
  readonly publish: (state: SatellitePillState) => void;
  readonly hideMain: () => void;
  readonly openMain: () => void;
  readonly showMenu: () => void;
  readonly movePill: (direction: SatelliteMoveDirection) => void;
  readonly beginPillDrag: () => void;
  readonly updatePillDrag: () => void;
  readonly endPillDrag: () => void;
  readonly finishTransition: (transitionId: number) => void;
  readonly setPinned: (pinned: boolean) => void;
  readonly onShellState: (listener: (state: SatelliteShellState) => void) => () => void;
  readonly onPillState: (listener: (state: SatellitePillState) => void) => () => void;
}
