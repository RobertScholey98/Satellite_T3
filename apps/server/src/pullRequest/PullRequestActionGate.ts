import type {
  FactoryError,
  PullRequestActionInput,
  PullRequestDetail,
  PullRequestRef,
  PullRequestStack,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Decides whether a pull-request action may change a pull request that an owner, such as managed
 * delivery, controls. `PullRequestService` asks before every action and supplies uncached host
 * reads. It runs `beforeMutation` at the host's mutation boundary, after any queueing, so the
 * decision is repeated against current state.
 */
export class PullRequestActionGate extends Context.Service<
  PullRequestActionGate,
  {
    readonly authorize: <E>(input: {
      readonly request: PullRequestActionInput;
      readonly ref: PullRequestRef & { readonly host: string };
      readonly readDetail: (ref: PullRequestRef) => Effect.Effect<PullRequestDetail, E>;
      readonly readStack: (ref: PullRequestRef) => Effect.Effect<PullRequestStack | null, E>;
    }) => Effect.Effect<
      {
        readonly requireConditionalMerge: boolean;
        readonly beforeMutation: Effect.Effect<void, FactoryError>;
      },
      FactoryError | E
    >;
  }
>()("t3/pullRequest/PullRequestActionGate") {}

/**
 * No owner: every action is admitted. For tests and compositions without engineering managers;
 * the server provides the factory's implementation instead.
 */
export const layerUnmanaged = Layer.succeed(
  PullRequestActionGate,
  PullRequestActionGate.of({
    authorize: () =>
      Effect.succeed({ requireConditionalMerge: false, beforeMutation: Effect.void }),
  }),
);
