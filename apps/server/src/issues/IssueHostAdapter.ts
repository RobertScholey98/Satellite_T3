import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  IssueDetail,
  IssueOperationError,
  IssueSummary,
  type IssueBoardColumn,
  type IssueBoardItem,
  type IssueBoardLocator,
  type IssueRef,
  type IssuesListResult,
  type SourceControlProviderKind,
} from "@t3tools/contracts";

export interface IssueHostScope {
  readonly cwd: string;
  readonly ref: IssueRef;
}
export interface RemoteIssueBoard {
  readonly title: string;
  readonly locator: IssueBoardLocator;
  readonly columns: ReadonlyArray<IssueBoardColumn>;
  readonly items: ReadonlyArray<IssueBoardItem>;
}
export interface DiscoveredIssueBoard {
  readonly title: string;
  readonly locator: IssueBoardLocator;
}
type BoardLocator<K extends IssueBoardLocator["kind"]> = Extract<IssueBoardLocator, { kind: K }>;

export interface IssueHostBoards<K extends IssueBoardLocator["kind"] = IssueBoardLocator["kind"]> {
  readonly locatorKind: K;
  readonly list: (
    scope: IssueHostScope,
  ) => Effect.Effect<ReadonlyArray<DiscoveredIssueBoard>, IssueOperationError>;
  readonly read: (
    cwd: string,
    locator: BoardLocator<K>,
  ) => Effect.Effect<RemoteIssueBoard, IssueOperationError>;
  readonly move: (
    cwd: string,
    locator: BoardLocator<K>,
    item: IssueBoardItem,
    columnId: string,
  ) => Effect.Effect<void, IssueOperationError>;
}

/**
 * One repository host's issue I/O. A host that cannot do something omits that group; the issue
 * service turns the absence into its "unavailable" error, so there are no stub methods.
 */
export interface IssueHostAdapter {
  readonly kind: SourceControlProviderKind;
  readonly list: (
    scope: IssueHostScope,
    cursor?: string,
  ) => Effect.Effect<IssuesListResult, IssueOperationError>;
  /** One issue with every page of its comments. */
  readonly get: (scope: IssueHostScope) => Effect.Effect<IssueDetail, IssueOperationError>;
  readonly boards?: {
    [K in IssueBoardLocator["kind"]]: IssueHostBoards<K>;
  }[IssueBoardLocator["kind"]];
}

export const ISSUE_RESPONSE_LIMIT_BYTES = 4 * 1024 * 1024;
const invalidIssueData = () =>
  new IssueOperationError({
    reason: "remote",
    message: "The repository host returned invalid issue data.",
  });
export const remoteIssueError = (cause: unknown) =>
  new IssueOperationError({
    reason: "remote",
    message: cause instanceof Error ? cause.message : "The repository host request failed.",
  });

export const JsonRecord = Schema.Record(Schema.String, Schema.Unknown);
const decodeRecordJson = Schema.decodeEffect(Schema.fromJsonString(JsonRecord));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const isRecord = Schema.is(JsonRecord);
const isArray = Schema.is(Schema.Array(Schema.Unknown));

export const readRecord = (text: string) =>
  decodeRecordJson(text).pipe(Effect.mapError(invalidIssueData));
export const readJson = (text: string) => decodeJson(text).pipe(Effect.mapError(invalidIssueData));
export const decodeHostJson = <S extends Schema.Top>(schema: S, text: string) =>
  Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(Effect.mapError(invalidIssueData));
export const validate = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(invalidIssueData));
const decodeIssueDetail = Schema.decodeEffect(IssueDetail);
const decodeIssueSummary = Schema.decodeEffect(IssueSummary);
export const toIssueDetail = (value: IssueDetail) =>
  decodeIssueDetail(value).pipe(Effect.mapError(invalidIssueData));
export const toIssueSummary = (value: IssueSummary) =>
  decodeIssueSummary(value).pipe(Effect.mapError(invalidIssueData));

export const str = (value: unknown): string => (typeof value === "string" ? value : "");
export const num = (value: unknown): number => (typeof value === "number" ? value : 0);
export const obj = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
export const arr = (value: unknown): ReadonlyArray<unknown> => (isArray(value) ? value : []);
export const labelNames = (value: unknown) =>
  arr(value)
    .map((label) => (typeof label === "string" ? label : str(obj(label).name)))
    .filter(Boolean);
export const segment = encodeURIComponent;
