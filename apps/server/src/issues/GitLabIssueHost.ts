import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString, type IssueDetail } from "@t3tools/contracts";
import * as GitLabCli from "../sourceControl/GitLabCli.ts";
import {
  ISSUE_RESPONSE_LIMIT_BYTES,
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

const GitLabIssue = Schema.Struct({
  iid: PositiveInt,
  title: Schema.String,
  state: TrimmedNonEmptyString,
  updated_at: Schema.String,
  web_url: TrimmedNonEmptyString,
  description: Schema.optional(Schema.NullOr(Schema.String)),
});

const actor = (value: unknown) => {
  const user = obj(value);
  const name = str(user.name);
  if (!name) return null;
  const avatarUrl = str(user.avatar_url);
  return avatarUrl ? { name, avatarUrl } : { name };
};
const toIssue = (scope: IssueHostScope, raw: Record<string, unknown>): IssueDetail => ({
  ref: {
    ...scope.ref,
    id: String(num(raw.iid)),
    number: num(raw.iid),
    url: str(raw.web_url) || scope.ref.url,
  },
  title: str(raw.title),
  state: str(raw.state),
  updatedAt: str(raw.updated_at),
  labels: labelNames(raw.labels),
  body: str(raw.description),
  author: actor(raw.author),
  assignees: arr(raw.assignees)
    .map(actor)
    .filter((value) => value !== null),
  createdAt: str(raw.created_at),
});

export const make = Effect.gen(function* () {
  const gitlab = yield* GitLabCli.GitLabCli;
  const api = (scope: IssueHostScope, endpoint: string) =>
    gitlab
      .execute({
        cwd: scope.cwd,
        args: ["api", "--hostname", scope.ref.host, endpoint],
        maxOutputBytes: ISSUE_RESPONSE_LIMIT_BYTES,
      })
      .pipe(
        Effect.map((output) => output.stdout),
        Effect.mapError(remoteIssueError),
      );
  const issuesPath = (scope: IssueHostScope) => `projects/${segment(scope.ref.repository)}/issues`;

  const list: IssueHostAdapter["list"] = Effect.fn("GitLabIssueHost.list")(
    function* (scope, cursor) {
      const page = cursor !== undefined && /^\d+$/.test(cursor) ? Number(cursor) : 1;
      const entries = yield* decodeHostJson(
        Schema.Array(JsonRecord),
        yield* api(scope, `${issuesPath(scope)}?per_page=100&page=${page}`),
      );
      const issues = yield* Effect.forEach(entries, (entry) =>
        validate(GitLabIssue, entry).pipe(
          Effect.flatMap(() => toIssueSummary(toIssue(scope, entry))),
        ),
      );
      return { issues, nextCursor: entries.length === 100 ? String(page + 1) : null };
    },
  );

  const get: IssueHostAdapter["get"] = Effect.fn("GitLabIssueHost.get")(function* (scope) {
    const issuePath = `${issuesPath(scope)}/${segment(scope.ref.id)}`;
    const raw = yield* readRecord(yield* api(scope, issuePath));
    yield* validate(GitLabIssue, raw);
    const notes: Record<string, unknown>[] = [];
    for (let page = 1; ; page++) {
      const entries = yield* decodeHostJson(
        Schema.Array(JsonRecord),
        yield* api(scope, `${issuePath}/notes?per_page=100&page=${page}`),
      );
      notes.push(...entries);
      if (entries.length !== 100) break;
    }
    return yield* toIssueDetail({
      ...toIssue(scope, raw),
      comments: notes.map((note) => ({
        id: String(note.id),
        body: str(note.body),
        createdAt: str(note.created_at),
        author: actor(note.author),
      })),
    });
  });

  return { kind: "gitlab", list, get } satisfies IssueHostAdapter;
});
