import * as Layer from "effect/Layer";

import * as FactoryService from "./FactoryService.ts";

/** The engineering factory for the server's lifetime. */
export const layer = FactoryService.layer;

/** Handler builds only need the service to exist. */
export const testLayer = Layer.mock(FactoryService.FactoryService)({});
