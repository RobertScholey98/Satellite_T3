import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  IssueOperationError,
  PositiveInt,
  TrimmedNonEmptyString,
  type IssueDetail,
} from "@t3tools/contracts";
import * as BitbucketApi from "../sourceControl/BitbucketApi.ts";
import {
  ISSUE_RESPONSE_LIMIT_BYTES,
  JsonRecord,
  num,
  obj,
  readRecord,
  remoteIssueError,
  segment,
  str,
  toIssueDetail,
  toIssueSummary,
  validate,
  type IssueHostAdapter,
  type IssueHostScope,
} from "./IssueHostAdapter.ts";

const BitbucketIssue = Schema.Struct({
  id: PositiveInt,
  title: Schema.String,
  state: TrimmedNonEmptyString,
  updated_on: Schema.String,
  links: Schema.Struct({ html: Schema.Struct({ href: TrimmedNonEmptyString }) }),
});
const Page = Schema.Struct({ values: Schema.Array(JsonRecord) });

const actor = (value: unknown) => {
  const user = obj(value);
  const name = str(user.display_name);
  if (!name) return null;
  const avatarUrl = str(obj(obj(user.links).avatar).href);
  return avatarUrl ? { name, avatarUrl } : { name };
};
const toIssue = (scope: IssueHostScope, raw: Record<string, unknown>): IssueDetail => ({
  ref: {
    ...scope.ref,
    id: String(num(raw.id)),
    number: num(raw.id),
    url: str(obj(obj(raw.links).html).href) || scope.ref.url,
  },
  title: str(raw.title),
  state: str(raw.state),
  updatedAt: str(raw.updated_on),
  labels: [],
  body: str(obj(raw.content).raw),
  author: null,
  assignees: [],
  createdAt: str(raw.created_on),
});

export const make = Effect.gen(function* () {
  const bitbucket = yield* BitbucketApi.BitbucketApi;
  const issuesPath = (scope: IssueHostScope) => `repositories/${scope.ref.repository}/issues`;
  const read = (url: string, maxBytes?: number) =>
    bitbucket.request({ method: "GET", url, ...(maxBytes === undefined ? {} : { maxBytes }) });

  const list: IssueHostAdapter["list"] = Effect.fn("BitbucketIssueHost.list")(
    function* (scope, cursor) {
      const page = cursor !== undefined && /^\d+$/.test(cursor) ? Number(cursor) : 1;
      const output = yield* read(
        `${issuesPath(scope)}?pagelen=100&page=${page}`,
        ISSUE_RESPONSE_LIMIT_BYTES,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new IssueOperationError({
              reason: "unavailable",
              message: `Bitbucket's native issue tracker is unavailable or disabled. ${cause.message}`,
            }),
        ),
      );
      const response = yield* readRecord(output.body);
      const entries = (yield* validate(Page, response)).values;
      const issues = yield* Effect.forEach(entries, (entry) =>
        validate(BitbucketIssue, entry).pipe(
          Effect.flatMap(() => toIssueSummary(toIssue(scope, entry))),
        ),
      );
      return { issues, nextCursor: str(response.next) ? String(page + 1) : null };
    },
  );

  const get: IssueHostAdapter["get"] = Effect.fn("BitbucketIssueHost.get")(function* (scope) {
    const issuePath = `${issuesPath(scope)}/${segment(scope.ref.id)}`;
    const record = (url: string, maxBytes?: number) =>
      read(url, maxBytes).pipe(
        Effect.mapError(remoteIssueError),
        Effect.flatMap((output) => readRecord(output.body)),
      );
    const raw = yield* record(issuePath, ISSUE_RESPONSE_LIMIT_BYTES);
    yield* validate(BitbucketIssue, raw);
    const comments: Record<string, unknown>[] = [];
    for (let page = 1; ; page++) {
      const response = yield* record(`${issuePath}/comments?pagelen=100&page=${page}`);
      comments.push(...(yield* validate(Page, response)).values);
      if (!str(response.next)) break;
    }
    return yield* toIssueDetail({
      ...toIssue(scope, raw),
      comments: comments.map((comment) => ({
        id: String(comment.id),
        body: str(obj(comment.content).raw),
        createdAt: str(comment.created_on),
        author: actor(comment.user),
      })),
    });
  });

  return { kind: "bitbucket", list, get } satisfies IssueHostAdapter;
});
