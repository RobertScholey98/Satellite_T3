import {
  FACTORY_MERGE_GROUP_LABEL,
  FACTORY_MERGE_GROUP_STATUS_CONTEXT,
  FactoryError,
  type PullRequestRef,
  isFactoryError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as GitHubApi from "../sourceControl/GitHubApi.ts";

const decodeLabels = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ name: Schema.String }))),
);
const decodeCombinedStatus = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      statuses: Schema.Array(
        Schema.Struct({
          context: Schema.String,
          state: Schema.String,
          description: Schema.NullOr(Schema.String),
        }),
      ),
    }),
  ),
);
const failure = (cause: unknown) =>
  isFactoryError(cause) ? cause : new FactoryError({ code: "execution-unavailable", cause });

/**
 * Writes Group deployment readiness to GitHub: the merge group label on member PRs and the
 * `satellite/merge-group` commit status on member heads and merge commits. Every write reads
 * GitHub first, so replaying one after a crash or restart never repeats it.
 */
export class FactoryMergeSignal extends Context.Service<
  FactoryMergeSignal,
  {
    /**
     * Labels the PR, creating the label in its repository when missing. Fails unless GitHub then
     * shows the label, because the deployment gate treats an unlabeled merge as ungrouped.
     */
    readonly label: (ref: PullRequestRef) => Effect.Effect<void, FactoryError>;
    /** Removes the label from a PR that left its group, so its own deployment passes the gate. */
    readonly unlabel: (ref: PullRequestRef) => Effect.Effect<void, FactoryError>;
    /** Sets the merge group status on `sha` unless GitHub already shows the same one. */
    readonly publish: (input: {
      readonly ref: PullRequestRef;
      readonly sha: string;
      readonly state: "pending" | "success" | "failure";
      readonly description: string;
    }) => Effect.Effect<void, FactoryError>;
  }
>()("t3/factory/FactoryMergeSignal") {}

const make = Effect.gen(function* () {
  const api = yield* GitHubApi.GitHubApi;
  const target = (ref: PullRequestRef) => {
    const [owner, name, ...rest] = ref.repository.split("/");
    return ref.host && owner && name && rest.length === 0
      ? Effect.succeed({
          host: ref.host,
          repo: `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
        })
      : Effect.fail(
          new FactoryError({
            code: "execution-unavailable",
            detail: "Group deployment readiness needs a GitHub pull request.",
          }),
        );
  };
  const request = (
    host: string,
    operation: string,
    path: string,
    body?: Record<string, unknown>,
    method: "GET" | "POST" | "DELETE" = body ? "POST" : "GET",
  ) =>
    api.rest({
      host,
      operation: `FactoryMergeSignal.${operation}`,
      path,
      method,
      ...(body ? { body } : {}),
    });
  const labeled = (host: string, path: string) =>
    request(host, "labels", path).pipe(
      Effect.flatMap((response) => decodeLabels(response.body)),
      Effect.map((labels) => labels.some((entry) => entry.name === FACTORY_MERGE_GROUP_LABEL)),
    );

  const label = Effect.fn("FactoryMergeSignal.label")(function* (ref: PullRequestRef) {
    const { host, repo } = yield* target(ref);
    const issue = `${repo}/issues/${ref.number}/labels`;
    if (yield* labeled(host, issue)) return;
    const exists = yield* request(
      host,
      "label",
      `${repo}/labels/${encodeURIComponent(FACTORY_MERGE_GROUP_LABEL)}`,
    ).pipe(
      Effect.as(true),
      Effect.catchTags({ GitHubApiNotFoundError: () => Effect.succeed(false) }),
    );
    if (!exists)
      yield* request(host, "createLabel", `${repo}/labels`, {
        name: FACTORY_MERGE_GROUP_LABEL,
        color: "5319e7",
        description: `Merged by a Satellite merge group. Deploy after ${FACTORY_MERGE_GROUP_STATUS_CONTEXT} succeeds.`,
      }).pipe(
        // Another writer created it first.
        Effect.catchIf(
          (error) => error._tag === "GitHubApiResponseError" && error.status === 422,
          () => Effect.void,
        ),
      );
    yield* request(host, "addLabel", issue, { labels: [FACTORY_MERGE_GROUP_LABEL] });
    if (!(yield* labeled(host, issue)))
      return yield* new FactoryError({
        code: "execution-unavailable",
        detail: `GitHub did not confirm the ${FACTORY_MERGE_GROUP_LABEL} label on ${ref.repository}#${ref.number}.`,
      });
  }, Effect.mapError(failure));

  const unlabel = Effect.fn("FactoryMergeSignal.unlabel")(function* (ref: PullRequestRef) {
    const { host, repo } = yield* target(ref);
    const issue = `${repo}/issues/${ref.number}/labels`;
    if (!(yield* labeled(host, issue))) return;
    yield* request(
      host,
      "removeLabel",
      `${issue}/${encodeURIComponent(FACTORY_MERGE_GROUP_LABEL)}`,
      undefined,
      "DELETE",
    ).pipe(
      // Someone removed it first.
      Effect.catchTags({ GitHubApiNotFoundError: () => Effect.void }),
    );
  }, Effect.mapError(failure));

  const publish = Effect.fn("FactoryMergeSignal.publish")(function* (input: {
    readonly ref: PullRequestRef;
    readonly sha: string;
    readonly state: "pending" | "success" | "failure";
    readonly description: string;
  }) {
    const { host, repo } = yield* target(input.ref);
    const sha = encodeURIComponent(input.sha);
    // GitHub keeps the latest status per context; posting the same one again only adds noise.
    const current = yield* request(
      host,
      "status",
      `${repo}/commits/${sha}/status?per_page=100`,
    ).pipe(
      Effect.flatMap((response) => decodeCombinedStatus(response.body)),
      Effect.map((combined) =>
        combined.statuses.find((entry) => entry.context === FACTORY_MERGE_GROUP_STATUS_CONTEXT),
      ),
    );
    if (current?.state === input.state && current.description === input.description) return;
    yield* request(host, "publishStatus", `${repo}/statuses/${sha}`, {
      state: input.state,
      context: FACTORY_MERGE_GROUP_STATUS_CONTEXT,
      description: input.description,
    });
  }, Effect.mapError(failure));

  return FactoryMergeSignal.of({ label, unlabel, publish });
});

export const layer = Layer.effect(FactoryMergeSignal, make);
