import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  FactorySnapshot,
  IssueOperationError,
  type FactoryFollowup,
  type IssuePublicationRequest,
  type IssueRef,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as IssuePublication from "../issues/IssuePublication.ts";
import * as IssuePublicationHost from "../issues/IssuePublicationHost.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import migration from "../persistence/Migrations/067_EngineeringFactory.ts";
import issueMigration from "../persistence/Migrations/070_IssuePublication.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as FactoryControlAccess from "./FactoryControlAccess.ts";
import * as FactoryExecution from "./FactoryExecution.ts";
import * as FactoryHandover from "./FactoryHandover.ts";
import * as FactoryRetroEvidence from "./FactoryRetroEvidence.ts";
import * as FactoryRetroEffects from "./FactoryRetroEffects.ts";
import * as FactoryRetroExecution from "./FactoryRetroExecution.ts";
import * as FactoryStore from "./FactoryStore.ts";
import { deliveryFixture, deliveryIds, deliveryNow } from "./FactoryDelivery.testkit.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(FactorySnapshot));
const issue: IssueRef = {
  hostKind: "github",
  host: "github.com",
  repository: "owner/repo",
  id: "42",
  number: 42,
  url: "https://github.com/owner/repo/issues/42",
};
const request: IssuePublicationRequest = {
  requestId: "factory-followup:followup",
  projectId: deliveryIds.project,
  destination: {
    projectId: deliveryIds.project,
    environmentId: EnvironmentId.make("env"),
    credentialNamespace: "namespace",
    board: null,
    validatedAt: deliveryNow,
    destination: {
      kind: "github",
      host: "github.com",
      repository: "owner/repo",
      triage: { kind: "labels", labels: ["triage"] },
    },
  },
  draft: {
    title: "Improve lint",
    problem: "Missing lint rule",
    impact: "Rework",
    proposedOutcome: "Enforce the convention",
    acceptanceCriteria: ["The repeated violation is caught"],
    evidence: [],
    owner: "Project manager",
    requiredAuthority: "Project rule",
    suspectedCause: "project",
    origin: { assignmentId: deliveryIds.assignment, findingIds: ["finding"] },
    containmentOf: null,
  },
};

const fixture = Effect.gen(function* () {
  yield* migration;
  yield* issueMigration;
  const sql = yield* SqlClient.SqlClient;
  const followup: FactoryFollowup = {
    id: "followup",
    assignmentId: deliveryIds.assignment,
    projectId: deliveryIds.project,
    findingIds: ["finding"],
    draft: request.draft,
    publication: { status: "requested", trackerId: "tracker", requestId: request.requestId },
    existingIssue: null,
    error: null,
    createdAt: deliveryNow,
    updatedAt: deliveryNow,
  };
  const seed: FactorySnapshot = {
    ...deliveryFixture(),
    followups: [followup],
    projectTrackers: [
      {
        id: "tracker",
        projectId: deliveryIds.project,
        destination: request.destination,
        approvedBy: CommandId.make("configure"),
        approvedAt: deliveryNow,
      },
    ],
  };
  yield* sql`INSERT INTO factory_state (id,revision,payload_json) VALUES (1,${seed.revision},${encode(seed)})`;
  const store = yield* FactoryStore.FactoryStore.pipe(Effect.provide(FactoryStore.layer));
  const state = {
    creates: 0,
    places: 0,
    triaged: false,
    beforeCreate: Effect.void as Effect.Effect<void>,
    beforePlace: Effect.void as Effect.Effect<void>,
  };
  const host = IssuePublicationHost.IssuePublicationHost.of({
    validate: () => Effect.succeed(request.destination),
    lookup: () => Effect.succeed({ issues: [], complete: true }),
    inspect: () =>
      Effect.sync(() =>
        state.triaged ? { kind: "labels" as const, labels: ["triage"] } : undefined,
      ),
    create: ({ beforeMutation }) =>
      Effect.gen(function* () {
        yield* state.beforeCreate;
        yield* beforeMutation;
        state.creates++;
        return issue;
      }),
    place: ({ beforeMutation }) =>
      Effect.gen(function* () {
        yield* state.beforePlace;
        yield* beforeMutation;
        state.places++;
        state.triaged = true;
      }),
  });
  const issues = yield* IssuePublication.IssuePublication.pipe(
    Effect.provide(
      IssuePublication.layer.pipe(
        Layer.provide(Layer.succeed(IssuePublicationHost.IssuePublicationHost, host)),
      ),
    ),
  );
  const blocked = yield* issues.publish({
    ...request,
    beforeMutation: Effect.fail(
      new IssueOperationError({ reason: "unavailable", message: "Fixture initial hold" }),
    ),
  });
  yield* store.commit({
    actor: { kind: "system" },
    now: deliveryNow,
    command: {
      type: "followup.publication.recorded",
      commandId: CommandId.make("blocked"),
      followupId: followup.id,
      receipt: blocked,
    },
  });
  const layer = FactoryRetroEffects.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(FactoryStore.FactoryStore, store),
        Layer.succeed(IssuePublication.IssuePublication, issues),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        Layer.mock(FactoryControlAccess.FactoryControlAccess)({}),
        Layer.mock(FactoryExecution.FactoryExecution)({}),
        Layer.mock(FactoryHandover.FactoryHandover)({}),
        Layer.mock(FactoryRetroEvidence.FactoryRetroEvidence)({}),
        Layer.mock(FactoryRetroExecution.FactoryRetroExecution)({}),
        Layer.mock(PullRequestService.PullRequestService)({}),
      ),
    ),
  );
  const select = (commandId = "select") =>
    store
      .commit({
        actor: { kind: "human" },
        now: deliveryNow,
        command: {
          type: "followup.link-existing",
          commandId: CommandId.make(commandId),
          followupId: followup.id,
          issue,
        },
      })
      .pipe(Effect.asVoid, Effect.orDie);
  const retry = store.commit({
    actor: { kind: "human" },
    now: deliveryNow,
    command: {
      type: "followup.retry",
      commandId: CommandId.make("retry"),
      followupId: followup.id,
    },
  });
  const pending = (type: "followup.publish" | "followup.link") =>
    store.pending.pipe(
      Effect.map((entries) => {
        const entry = entries.find((item) => item.intent.type === type);
        assert.isDefined(entry);
        return entry!;
      }),
    );
  return { state, store, issues, layer, select, retry, pending };
});
const database = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect(
  "supersedes a queued create with the human's existing issue and places that same issue",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.retry;
      const obsolete = yield* f.pending("followup.publish");
      yield* f.select();
      yield* Effect.gen(function* () {
        const effects = yield* FactoryRetroEffects.FactoryRetroEffects;
        yield* effects.handle(obsolete);
        assert.equal(f.state.creates, 0);
        assert.equal(
          (yield* f.store.pending).filter((entry) => entry.intent.type === "followup.publish")
            .length,
          0,
        );
        yield* effects.handle(yield* f.pending("followup.link"));
        const publication = (yield* f.store.snapshot).followups[0]!.publication;
        assert.equal(publication.status, "recorded");
        if (publication.status !== "recorded")
          return assert.fail("Expected recorded triage receipt");
        assert.equal(publication.receipt.progress.status, "triaged");
        assert.equal(f.state.creates, 0);
        assert.equal(f.state.places, 1);
        assert.isEmpty(yield* f.store.pending);
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(database)),
);

it.effect(
  "rechecks selection at the actual create boundary and preserves the new link intent",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.retry;
      f.state.beforeCreate = f.select();
      yield* Effect.gen(function* () {
        const effects = yield* FactoryRetroEffects.FactoryRetroEffects;
        yield* effects.handle(yield* f.pending("followup.publish"));
        assert.equal(f.state.creates, 0);
        assert.equal(f.state.places, 0);
        const followup = (yield* f.store.snapshot).followups[0]!;
        assert.deepEqual(followup.existingIssue, issue);
        assert.equal(followup.error, null);
        f.state.beforeCreate = Effect.void;
        yield* effects.handle(yield* f.pending("followup.link"));
        assert.equal(f.state.places, 1);
        assert.equal(f.state.creates, 0);
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(database)),
);

it.effect("holds existing-issue placement if the project pauses after link verification", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.select();
    f.state.beforePlace = f.store
      .commit({
        actor: { kind: "human" },
        now: deliveryNow,
        command: {
          type: "project.pause",
          commandId: CommandId.make("pause"),
          projectId: deliveryIds.project,
        },
      })
      .pipe(Effect.asVoid, Effect.orDie);
    yield* Effect.gen(function* () {
      const effects = yield* FactoryRetroEffects.FactoryRetroEffects;
      yield* effects.handle(yield* f.pending("followup.link"));
      assert.equal(f.state.creates, 0);
      assert.equal(f.state.places, 0);
      assert.equal((yield* f.issues.read(request.requestId))?.progress.status, "placement-pending");
      assert.isDefined(
        (yield* f.store.pending).find((entry) => entry.intent.type === "followup.link"),
      );
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(database)),
);

it.effect("does not place the linked issue after its tracker configuration is superseded", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.select();
    const changed = {
      ...request.destination,
      destination: {
        kind: "github" as const,
        host: "github.com",
        repository: "owner/repo",
        triage: { kind: "labels" as const, labels: ["new-triage"] },
      },
    };
    f.state.beforePlace = f.store
      .commit({
        actor: { kind: "human" },
        now: deliveryNow,
        qualifiedTracker: changed,
        command: {
          type: "project.tracker.configure",
          commandId: CommandId.make("configure-new"),
          projectId: deliveryIds.project,
          expectedTrackerId: "tracker",
          destination: changed.destination,
        },
      })
      .pipe(Effect.asVoid, Effect.orDie);
    yield* Effect.gen(function* () {
      const effects = yield* FactoryRetroEffects.FactoryRetroEffects;
      yield* effects.handle(yield* f.pending("followup.link"));
      assert.equal(f.state.creates, 0);
      assert.equal(f.state.places, 0);
      const publication = (yield* f.store.snapshot).followups[0]!.publication;
      assert.equal(publication.status, "recorded");
      if (publication.status !== "recorded") return assert.fail("Expected held placement receipt");
      assert.equal(publication.receipt.progress.status, "placement-pending");
      assert.equal(publication.trackerId, "tracker");
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(database)),
);
