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

export interface SatelliteNavigation {
  readonly threadId: string | null;
  readonly environmentId: string | null;
}

export interface SatelliteBridge {
  readonly publish: (state: SatellitePillState) => void;
  readonly onNavigate: (listener: (target: SatelliteNavigation) => void) => () => void;
  readonly hideMain: () => void;
}
