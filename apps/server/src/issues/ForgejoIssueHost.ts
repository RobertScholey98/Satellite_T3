import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString, type IssueDetail } from "@t3tools/contracts";
import * as ForgejoCli from "../sourceControl/ForgejoCli.ts";
import {
  JsonRecord,
  arr,
  decodeHostJson,
  labelNames,
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

const ForgejoIssue = Schema.Struct({
  number: PositiveInt,
  title: Schema.String,
  state: TrimmedNonEmptyString,
  updated_at: Schema.String,
  html_url: TrimmedNonEmptyString,
  body: Schema.optional(Schema.NullOr(Schema.String)),
});

const actor = (value: unknown) => {
  const user = obj(value);
  const name = str(user.login);
  if (!name) return null;
  const avatarUrl = str(user.avatar_url);
  return avatarUrl ? { name, avatarUrl } : { name };
};
const toIssue = (scope: IssueHostScope, raw: Record<string, unknown>): IssueDetail => ({
  ref: {
    ...scope.ref,
    id: String(num(raw.number)),
    number: num(raw.number),
    url: str(raw.html_url) || scope.ref.url,
  },
  title: str(raw.title),
  state: str(raw.state),
  updatedAt: str(raw.updated_at),
  labels: labelNames(raw.labels),
  body: str(raw.body),
  author: actor(raw.user),
  assignees: arr(raw.assignees)
    .map(actor)
    .filter((value) => value !== null),
  createdAt: str(raw.created_at),
});

export const make = Effect.gen(function* () {
  const forgejo = yield* ForgejoCli.ForgejoCli;
  const api = (scope: IssueHostScope, path: string) =>
    forgejo
      .api({ cwd: scope.cwd, host: scope.ref.host, repository: scope.ref.repository, path })
      .pipe(
        Effect.map((output) => output.stdout),
        Effect.mapError(remoteIssueError),
      );

  const list: IssueHostAdapter["list"] = Effect.fn("ForgejoIssueHost.list")(
    function* (scope, cursor) {
      const page = cursor !== undefined && /^\d+$/.test(cursor) ? Number(cursor) : 1;
      const entries = yield* decodeHostJson(
        Schema.Array(JsonRecord),
        yield* api(
          scope,
          `repos/${scope.ref.repository}/issues?state=all&type=issues&limit=100&page=${page}`,
        ),
      );
      const issues = yield* Effect.forEach(
        entries.filter((entry) => entry.pull_request === undefined),
        (entry) =>
          validate(ForgejoIssue, entry).pipe(
            Effect.flatMap(() => toIssueSummary(toIssue(scope, entry))),
          ),
      );
      return { issues, nextCursor: entries.length === 100 ? String(page + 1) : null };
    },
  );

  const get: IssueHostAdapter["get"] = Effect.fn("ForgejoIssueHost.get")(function* (scope) {
    const issuePath = `repos/${scope.ref.repository}/issues/${segment(scope.ref.id)}`;
    const raw = yield* readRecord(yield* api(scope, issuePath));
    yield* validate(ForgejoIssue, raw);
    const comments: Record<string, unknown>[] = [];
    for (let page = 1; ; page++) {
      const entries = yield* decodeHostJson(
        Schema.Array(JsonRecord),
        yield* api(scope, `${issuePath}/comments?limit=100&page=${page}`),
      );
      comments.push(...entries);
      if (entries.length !== 100) break;
    }
    return yield* toIssueDetail({
      ...toIssue(scope, raw),
      comments: comments.map((comment) => ({
        id: String(comment.id),
        body: str(comment.body),
        createdAt: str(comment.created_at),
        author: actor(comment.user),
      })),
    });
  });

  return { kind: "forgejo", list, get } satisfies IssueHostAdapter;
});
