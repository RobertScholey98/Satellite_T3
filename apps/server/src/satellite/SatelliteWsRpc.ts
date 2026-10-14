import {
  IdeaOperationError,
  SATELLITE_WS_METHODS,
  ThreadId,
  WsSatelliteRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { IdeaNotebookStore } from "../ideas/IdeaNotebookStore.ts";
import { OrchestrationEngineService } from "../orchestration-v2/SatelliteOrchestration.ts";

// Satellite's handlers get their own layer; `WsSatelliteRpcGroup` explains why.
const layer = (_session: EnvironmentAuth.AuthenticatedSession) =>
  WsSatelliteRpcGroup.toLayer(
    Effect.gen(function* () {
      const ideaStore = yield* IdeaNotebookStore;
      const satelliteEngine = yield* OrchestrationEngineService;
      return WsSatelliteRpcGroup.of({
        [SATELLITE_WS_METHODS.ideasList]: (input) =>
          ideaStore.list(input.projectId).pipe(
            Effect.map((ideas) => ({ ideas })),
            Effect.mapError((error) => new IdeaOperationError({ message: error.message })),
          ),
        [SATELLITE_WS_METHODS.ideasGet]: (input) =>
          ideaStore.get(input.threadId).pipe(
            Effect.map((notebook) => ({ notebook })),
            Effect.mapError((error) => new IdeaOperationError({ message: error.message })),
          ),
        [SATELLITE_WS_METHODS.ideasSubscribeChanges]: () =>
          Effect.gen(function* () {
            const events = yield* satelliteEngine.subscribeDomainEvents;
            return events.pipe(
              Stream.filter(
                (event) =>
                  event.type === "idea.changed" ||
                  event.type === "idea.purged" ||
                  event.type === "thread.meta-updated" ||
                  (event.type === "thread.activity-appended" &&
                    event.payload.activity.kind === "user-input.resolved") ||
                  (event.type === "thread.session-set" && event.payload.turnSettled === true) ||
                  (event.type === "thread.message-sent" && event.payload.role === "user") ||
                  (event.type === "thread.created" && event.payload.purpose === "idea"),
              ),
              Stream.mapEffect((event) =>
                Effect.gen(function* () {
                  const threadId = ThreadId.make(event.aggregateId);
                  const notebook = yield* ideaStore.get(threadId);
                  return notebook || event.type === "idea.purged"
                    ? Option.some({
                        threadId,
                        revision: notebook?.revision ?? 0,
                        purged: event.type === "idea.purged",
                      })
                    : Option.none();
                }),
              ),
              Stream.filter(Option.isSome),
              Stream.map((change) => change.value),
              Stream.mapError((error) => new IdeaOperationError({ message: error.message })),
            );
          }).pipe(Stream.unwrap),
      });
    }),
  );

type SatelliteWsRpcServices = Layer.Services<ReturnType<typeof layer>>;

/**
 * Captures the server-lifetime services Satellite's handlers use, once, and returns the
 * per-connection handler layer. Every connection shares those services, so clients share caches
 * and subscriptions.
 */
export const makeConnectionLayer = Effect.map(
  Effect.context<SatelliteWsRpcServices>(),
  (services) => (session: EnvironmentAuth.AuthenticatedSession) =>
    layer(session).pipe(Layer.provide(Layer.succeedContext(services))),
);
