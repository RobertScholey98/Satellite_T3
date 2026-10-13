import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  EnvironmentId,
  ProjectId,
  IssueOperationError,
  type IssueRef,
  type IssuePublicationRequest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import migration from "../persistence/Migrations/070_IssuePublication.ts";
import * as Publication from "./IssuePublication.ts";
import * as Host from "./IssuePublicationHost.ts";

const projectId = ProjectId.make("project");
const request: IssuePublicationRequest = {
  requestId: "followup-1",
  projectId,
  destination: {
    projectId,
    environmentId: EnvironmentId.make("env"),
    credentialNamespace: "credential",
    board: null,
    validatedAt: "2026-10-10T00:00:00Z",
    destination: {
      kind: "github",
      host: "github.com",
      repository: "owner/repo",
      triage: { kind: "labels", labels: ["triage"] },
    },
  },
  draft: {
    title: "Enforce the existing style rule",
    problem: "Style mismatches recur",
    impact: "Manual rework",
    proposedOutcome: "A targeted lint rule",
    acceptanceCriteria: ["Catches the demonstrated mismatch"],
    evidence: [{ summary: "Observed in the completed task", url: null }],
    owner: "Project manager",
    requiredAuthority: "Project rule",
    suspectedCause: "project",
    origin: { assignmentId: "assignment", findingIds: ["finding"] },
    containmentOf: null,
  },
};
const issue: IssueRef = {
  hostKind: "github",
  host: "github.com",
  repository: "owner/repo",
  id: "42",
  number: 42,
  url: "https://github.com/owner/repo/issues/42",
};
const failure = new IssueOperationError({
  reason: "remote",
  message: "Fixture lost acknowledgement",
});
const setup = Effect.gen(function* () {
  yield* migration;
  const state = {
    creates: 0,
    places: 0,
    reads: 0,
    issues: [] as IssueRef[],
    complete: true,
    loseAck: false,
    placementFails: false,
    triaged: false,
    ignorePlacement: false,
    paused: false,
    pauseBeforeCreate: false,
  };
  const host = Host.IssuePublicationHost.of({
    validate: () => Effect.succeed(request.destination),
    lookup: () => Effect.succeed({ issues: state.issues, complete: state.complete }),
    create: ({ beforeMutation }) =>
      Effect.gen(function* () {
        if (state.pauseBeforeCreate) state.paused = true;
        yield* beforeMutation;
        state.creates++;
        state.issues = [issue];
        if (state.loseAck) return yield* failure;
        return issue;
      }),
    place: ({ beforeMutation }) =>
      Effect.gen(function* () {
        yield* beforeMutation;
        state.places++;
        if (state.placementFails) return yield* failure;
        if (!state.ignorePlacement) state.triaged = true;
      }),
    inspect: () =>
      Effect.sync(() => {
        state.reads++;
        return state.triaged ? { kind: "labels" as const, labels: ["triage"] } : undefined;
      }),
  });
  const createService = Effect.gen(function* () {
    return yield* Publication.IssuePublication;
  }).pipe(
    Effect.provide(Publication.layer),
    Effect.provideService(Host.IssuePublicationHost, host),
  );
  const service = yield* createService;
  const beforeMutation = Effect.suspend(() =>
    state.paused
      ? Effect.fail(new IssueOperationError({ reason: "conflict", message: "Project paused" }))
      : Effect.void,
  );
  return {
    state,
    service,
    createService,
    publish: (target = service) => target.publish({ ...request, beforeMutation }),
  };
});
const database = NodeSqliteClient.layer({ filename: ":memory:" });

describe("IssuePublication journal", () => {
  it.effect("persists a receipt across closing and reopening an actual SQLite file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const filename = path.join(directory, "publications.sqlite");
      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const test = yield* setup;
          return yield* test.publish();
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename }))),
      );
      const reopened = yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Publication.IssuePublication;
          return yield* service.read(request.requestId);
        }).pipe(
          Effect.provide(
            Publication.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.mock(Host.IssuePublicationHost)({}),
                  NodeSqliteClient.layer({ filename }),
                ),
              ),
            ),
          ),
        ),
      );
      assert.deepEqual(reopened, first);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("recreates the service against SQLite without repeating a successful publication", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      const first = yield* test.publish();
      assert.equal(first.progress.status, "triaged");
      const reopened = yield* test.createService;
      assert.deepEqual(yield* reopened.read(request.requestId), first);
      assert.deepEqual(yield* test.publish(reopened), first);
      assert.equal(test.state.creates, 1);
      const sql = yield* SqlClient.SqlClient;
      assert.equal((yield* sql`SELECT * FROM issue_publications`).length, 1);
      assert.equal(
        (yield* sql`SELECT name FROM sqlite_master WHERE name='issue_attempts'`).length,
        0,
      );
    }).pipe(Effect.provide(database)),
  );

  it.effect("reconciles a lost create acknowledgement by marker after restart", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      test.state.loseAck = true;
      assert.equal((yield* test.publish()).progress.status, "outcome-unknown");
      const reopened = yield* test.createService;
      assert.equal((yield* test.publish(reopened)).progress.status, "triaged");
      assert.equal(test.state.creates, 1);
    }).pipe(Effect.provide(database)),
  );

  it.effect("never repeats an ambiguous POST even when a later complete lookup has no match", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      test.state.loseAck = true;
      yield* test.publish();
      test.state.issues = [];
      test.state.loseAck = false;
      assert.equal((yield* test.publish()).progress.status, "outcome-unknown");
      assert.equal(test.state.creates, 1);
    }).pipe(Effect.provide(database)),
  );

  it.effect("requires complete unique lookup before any create or identity adoption", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      test.state.complete = false;
      assert.equal((yield* test.publish()).progress.status, "outcome-unknown");
      test.state.complete = true;
      test.state.issues = [issue, { ...issue, id: "43", number: 43 }];
      assert.equal((yield* test.publish()).progress.status, "outcome-unknown");
      assert.equal(test.state.creates, 0);
      assert.equal(test.state.places, 0);
    }).pipe(Effect.provide(database)),
  );

  it.effect("conflicts changed immutable request bytes before any new host writes", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      yield* test.publish();
      const result = yield* test.service
        .publish({
          ...request,
          draft: { ...request.draft, title: "Different ticket" },
          beforeMutation: Effect.void,
        })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.reason, "conflict");
      assert.equal(test.state.creates, 1);
    }).pipe(Effect.provide(database)),
  );

  it.effect("retries placement on the recorded issue and requires actual triage readback", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      test.state.placementFails = true;
      assert.equal((yield* test.publish()).progress.status, "placement-pending");
      test.state.placementFails = false;
      test.state.ignorePlacement = true;
      assert.equal((yield* test.publish()).progress.status, "placement-pending");
      test.state.ignorePlacement = false;
      assert.equal((yield* test.publish()).progress.status, "triaged");
      assert.equal(test.state.creates, 1);
      assert.equal(test.state.places, 3);
    }).pipe(Effect.provide(database)),
  );

  it.effect("a late pause denies the queued create without consuming its create reservation", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      test.state.pauseBeforeCreate = true;
      assert.equal((yield* test.publish()).progress.status, "blocked");
      assert.equal(test.state.creates, 0);
      test.state.pauseBeforeCreate = false;
      test.state.paused = false;
      assert.equal((yield* test.publish()).progress.status, "triaged");
      assert.equal(test.state.creates, 1);
    }).pipe(Effect.provide(database)),
  );

  it.effect("records already completed triage facts while paused without more writes", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      test.state.loseAck = true;
      yield* test.publish();
      test.state.triaged = true;
      test.state.paused = true;
      assert.equal((yield* test.publish()).progress.status, "triaged");
      assert.equal(test.state.places, 0);
      assert.equal(test.state.creates, 1);
    }).pipe(Effect.provide(database)),
  );

  it.effect("linking an existing issue performs no content or placement writes", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      const linked = yield* test.service.linkExisting({ ...request, issue });
      assert.equal(linked.progress.status, "placement-pending");
      assert.equal(test.state.creates, 0);
      assert.equal(test.state.places, 0);
      test.state.triaged = true;
      assert.equal(
        (yield* test.service.linkExisting({ ...request, issue })).progress.status,
        "triaged",
      );
    }).pipe(Effect.provide(database)),
  );
});
