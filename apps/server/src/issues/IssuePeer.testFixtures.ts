import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as IssuePeerKeys from "./IssuePeerKeys.ts";

/** A secret store that lives in memory; `values` shows what was stored. */
export const memorySecretStore = () => {
  const values = new Map<string, Uint8Array>();
  const store = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.succeed(Option.fromNullishOr(values.get(name))),
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
    create: (name, value) => Effect.sync(() => void values.set(name, value)),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: (name) => Effect.sync(() => void values.delete(name)),
  });
  return { store, values };
};

/** A fresh identity key, as a new environment would mint it. */
export const freshPeerKeys = () =>
  Layer.build(
    IssuePeerKeys.layer.pipe(
      Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, memorySecretStore().store)),
    ),
  ).pipe(Effect.map((context) => Context.get(context, IssuePeerKeys.IssuePeerKeys)));
