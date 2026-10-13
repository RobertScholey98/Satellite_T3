import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
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

/**
 * Feeds every orchestration event to `FactoryService.observe`, after running factory recovery
 * once, and turns pull request merge notifications into project reconciliation. Built once by
 * `server.ts`; it starts observing as the layer is built.
 *
 * `drain` waits until recovery has run and every event up to the current latest sequence has
 * been observed, then drains the factory's effects. It fails if observation has stopped.
 */
export class FactoryObserver extends Context.Service<
  FactoryObserver,
  { readonly drain: Effect.Effect<void, FactoryObserverError | EventSink.EventSinkV2Error> }
>()("t3/factory/FactoryObserver") {}

const make = Effect.gen(function* () {
  const events = yield* EventSink.EventSinkV2;
  const store = yield* FactoryStore.FactoryStore;
  const factory = yield* FactoryService.FactoryService;
  const pullRequests = yield* Effect.serviceOption(PullRequestService.PullRequestService);
  // Without managers nothing needs observing, and a missing cursor means the history predates
  // the factory. Either way start at the current high-water mark rather than replaying it.
  const cursor = yield* store.observationCursor;
  const afterSequence =
    cursor === 0 || (yield* store.latest).managers.length === 0
      ? yield* events.latestSequence()
      : cursor;
  const progress = yield* SubscriptionRef.make<{
    readonly sequence: number;
    readonly recovered: boolean;
    readonly failure: FactoryObserverError | null;
  }>({ sequence: afterSequence, recovered: false, failure: null });

  if (Option.isSome(pullRequests)) {
    const merges = yield* pullRequests.value.subscribeMerges;
    yield* merges.pipe(
      Stream.runForEach((event) =>
        factory
          .reconcileProject(
            event.projectId,
            `merge:${event.host ?? "github.com"}:${event.repository}:${event.number}:${event.mergedAt}`,
          )
          .pipe(
            Effect.catch((cause) =>
              Effect.logError(
                "Factory merge hint could not be recorded; startup reconciliation remains available",
                { projectId: event.projectId, cause },
              ),
            ),
          ),
      ),
      forkParked,
    );
  }

  // The sink subscribes before replaying its high-water mark. Internal consumers
  // must keep every event, including the events the factory merely checkpoints.
  yield* events.stream({ afterSequence, bounded: false }).pipe(
    Stream.runForEach((event) =>
      store.latest.pipe(
        Effect.flatMap((state) =>
          state.managers.length === 0 ? Effect.void : factory.observe(event),
        ),
        // One unprocessable event must not stop observation for the rest of the session.
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logError("Factory could not observe an orchestration event", {
              sequence: event.sequence,
              cause,
            }),
        ),
        Effect.andThen(
          SubscriptionRef.set(progress, {
            sequence: event.sequence,
            recovered: true,
            failure: null,
          }),
        ),
      ),
    ),
    (observe) =>
      factory.recover.pipe(
        Effect.andThen(
          SubscriptionRef.update(progress, (state) => ({ ...state, recovered: true })),
        ),
        Effect.andThen(observe),
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
        Stream.filter(
          (state) => (state.recovered && state.sequence >= target) || state.failure !== null,
        ),
        Stream.take(1),
        Stream.runForEach((state) =>
          state.failure === null ? factory.drain : Effect.fail(state.failure),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(FactoryObserver, make);
