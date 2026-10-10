import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";

import { FactorySource } from "./FactorySource.ts";

export const layerUnused = Layer.mock(FactorySource)({
  readRevision: () => Effect.die("Unexpected source snapshot in this test"),
});
