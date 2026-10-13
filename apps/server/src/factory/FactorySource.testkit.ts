import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";

import * as FactorySource from "./FactorySource.ts";

export const layerUnused = Layer.mock(FactorySource.FactorySource)({
  readRevision: () => Effect.die("Unexpected source snapshot in this test"),
});
