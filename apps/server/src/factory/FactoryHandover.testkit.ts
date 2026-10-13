import * as Layer from "effect/Layer";

import * as FactoryHandover from "./FactoryHandover.ts";

export const layerUnused = Layer.mock(FactoryHandover.FactoryHandover)({});
