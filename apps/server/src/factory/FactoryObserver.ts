import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import { forkParked } from "../serverActivation.ts";
import * as FactoryService from "./FactoryService.ts";
import * as FactoryStore from "./FactoryStore.ts";

export class FactoryObserverError extends Schema.TaggedError<FactoryObserverError>()(
  "FactoryObserverError",
  { afterSequence: Schema.Number, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "Factory event observation stopped before pending events could be processed.";
  }
}

export class FactoryObserver extends Context.Service<
  FactoryObserver,
  { readonly drain: Effect.Effect<void, FactoryObserverError | EventSink.EventSinkV2Error> }
>()("t3/factory/FactoryObserver") {}

const make = Effect.gen(function* () {
  const events = yield* EventSink.EventSinkV2;
  const store = yield* FactoryStore.FactoryStore;
  const factory = yield* FactoryService.FactoryService;
  const afterSequence = yield* store.observationCursor;
  const progress = yield* SubscriptionRef.make<{
    readonly sequence: number;
    readonly failure: FactoryObserverError | null;
  }>({ sequence: afterSequence, failure: null });

  // The sink subscribes before replaying its high-water mark. Internal consumers
  // must keep every event, including the events the factory merely checkpoints.
  yield* events.stream({ afterSequence, bounded: false }).pipe(
    Stream.runForEach((event) =>
      factory
        .observe(event)
        .pipe(
          Effect.andThen(
            SubscriptionRef.set(progress, { sequence: event.sequence, failure: null }),
          ),
        ),
    ),
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return;
        const current = yield* SubscriptionRef.get(progress);
        const failure = new FactoryObserverError({
          afterSequence: current.sequence,
          ...(Exit.isFailure(exit) ? { cause: exit.cause } : {}),
        });
        yield* SubscriptionRef.set(progress, { ...current, failure });
        yield* Effect.logError("Factory event observation stopped", {
          afterSequence: current.sequence,
        });
      }),
    ),
    Effect.ignoreCause,
    forkParked,
  );

  return FactoryObserver.of({
    drain: Effect.gen(function* () {
      const target = yield* events.latestSequence();
      yield* SubscriptionRef.changes(progress).pipe(
        Stream.filter((state) => state.sequence >= target || state.failure !== null),
        Stream.take(1),
        Stream.runForEach((state) =>
          state.failure === null ? factory.drain : Effect.fail(state.failure),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(FactoryObserver, make);
