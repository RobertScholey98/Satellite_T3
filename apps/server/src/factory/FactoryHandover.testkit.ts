import * as Layer from "effect/Layer";

import { FactoryHandover } from "./FactoryHandover.ts";

export const layerUnused = Layer.mock(FactoryHandover)({});
