import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { FactoryBoundaryExecution } from "./FactoryBoundaryExecution.ts";

const unexpected = () => Effect.die("This fixture cannot run managed delivery operations.");

export const layerUnavailable = Layer.succeed(FactoryBoundaryExecution, {
  setIncidentHold: unexpected,
  setDeliveryHold: unexpected,
  captureCandidate: unexpected,
  captureMigration: unexpected,
  readCandidate: unexpected,
  finalizeCandidate: unexpected,
  verifyCandidate: unexpected,
  inspectCandidate: unexpected,
  approve: unexpected,
  approveShared: unexpected,
  prepare: unexpected,
  inspect: unexpected,
  rebind: unexpected,
  mutate: unexpected,
  verify: unexpected,
  exportArtifact: unexpected,
  stop: unexpected,
  suspend: unexpected,
  resume: unexpected,
});
