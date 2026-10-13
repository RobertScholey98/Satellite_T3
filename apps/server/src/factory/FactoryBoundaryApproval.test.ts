import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  FactoryBoundaryId,
  FactoryError,
  ProjectId,
  ProviderInstanceId,
  type FactoryAssignment,
  type FactoryBoundary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SatelliteTestRuntime from "../orchestration-v2/testkit/SatelliteTestRuntime.ts";
import * as FactoryBoundaryExecution from "./FactoryBoundaryExecution.ts";
import * as FactoryExecution from "./FactoryExecution.ts";
import * as FactoryService from "./FactoryService.ts";
import * as FactoryStore from "./FactoryStore.ts";
import * as FactorySourceTestkit from "./FactorySource.testkit.ts";
import * as FactoryHandoverTestkit from "./FactoryHandover.testkit.ts";
import * as FactoryServiceTestkit from "./FactoryService.testkit.ts";

const projectId = ProjectId.make("boundary-service-web");
const human = { kind: "human" } as const;
const workflow = FactoryServiceTestkit.testSkills;
const configuration = {
  protectedPaths: ["AGENTS.md", "eslint.config.js"],
  writablePaths: ["src/app.ts"],
  creatableDirectories: ["src/features"],
  gates: [
    {
      id: "lint",
      label: "Lint",
      executable: "node",
      args: ["scripts/lint.mjs"],
      cwd: ".",
      timeoutMs: 30000,
      protectedInputs: ["scripts/lint.mjs", "eslint.config.js"],
    },
  ],
};
const boundary = {
  ...configuration,
  id: FactoryBoundaryId.make("approved-web-boundary"),
  projectId,
  sourceRevision: "approved-project-commit",
  workflow,
  profileId: "qualified-profile",
  approvedAt: "2026-10-10T12:00:00.000Z",
} satisfies FactoryBoundary;
const providerExecution = Layer.succeed(FactoryExecution.FactoryExecution, {
  assertSelectionFor: () => Effect.void,
  assertDelegationFor: () => Effect.void,
  qualify: () =>
    Effect.succeed({
      status: "qualified",
      profileId: "qualified-profile",
      checkedAt: "2026-10-10T12:00:00.000Z",
    }),
  runtimePolicyFor: () =>
    Effect.succeed({
      boundaryId: "qualified-profile",
      dockerContext: "default",
      imageId: "sha256:approved-image",
      projectSnapshotPath: "/state/factory/project",
      workflowSnapshotPath: "/state/factory/workflow",
      runtimePath: "/state/factory/runtime",
    }),
});
const runtime = Layer.mergeAll(FactoryStore.layer, ThreadManagement.layer).pipe(
  Layer.provideMerge(SatelliteTestRuntime.layer),
);
const layer = FactoryService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      FactorySourceTestkit.layerUnused,
      FactoryHandoverTestkit.layerUnused,
      FactoryServiceTestkit.layerTestDependencies,
    ),
  ),
  Layer.provideMerge(runtime),
  Layer.provide(providerExecution),
);
const start = Effect.gen(function* () {
  yield* SatelliteTestRuntime.recordProject({ projectId, title: "Web", workspaceRoot: "/project" });
  const factory = yield* FactoryService.FactoryService;
  yield* factory.drain;
  yield* factory.dispatch(human, {
    type: "manager.create",
    commandId: CommandId.make("create-web"),
    projectId,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "approved-model" },
  });
  yield* factory.drain;
  const snapshot = yield* factory.snapshot({ projectId });
  return { factory, manager: snapshot.managers[0]!, assignment: snapshot.assignments[0]! };
});
const recordReport = (
  factory: FactoryService.FactoryService["Service"],
  assignment: FactoryAssignment,
) =>
  factory.dispatch(
    { kind: "thread", threadId: assignment.threadId },
    {
      type: "onboarding.report",
      commandId: CommandId.make("onboarding-report"),
      assignmentId: assignment.id,
      report: {
        summary: "Discovery identified the required project controls.",
        instructions: [],
        checks: [],
        verificationTools: [],
        protectedControls: [],
        unresolvedDecisions: [],
        tracker: { description: "Use repository issues.", evidence: [] },
        proposedBoundary: configuration,
      },
    },
  );

describe("factory boundary approval service", () => {
  it.effect(
    "preflights authority and discovery before capture and scopes successful retries to the original caller and payload",
    () =>
      Effect.gen(function* () {
        const captures = yield* Ref.make<
          ReadonlyArray<
            Parameters<FactoryBoundaryExecution.FactoryBoundaryExecution["Service"]["approve"]>[0]
          >
        >([]);
        yield* Effect.gen(function* () {
          const { factory, manager, assignment } = yield* start;
          const approval = {
            type: "manager.approve-onboarding" as const,
            commandId: CommandId.make("approve-web"),
            managerId: manager.id,
            configuration,
          };
          const premature = yield* factory.dispatch(human, approval).pipe(Effect.result);
          assert.isTrue(Result.isFailure(premature));
          if (Result.isFailure(premature)) assert.equal(premature.failure.code, "invalid-state");
          yield* recordReport(factory, assignment);
          for (const threadId of [manager.threadId, assignment.threadId]) {
            const unauthorized = yield* factory
              .dispatch({ kind: "thread", threadId }, approval)
              .pipe(Effect.result);
            assert.isTrue(Result.isFailure(unauthorized));
            if (Result.isFailure(unauthorized))
              assert.equal(unauthorized.failure.code, "permission-denied");
          }
          const accepted = yield* factory.dispatch(human, approval);
          yield* factory.drain;
          assert.deepStrictEqual(yield* factory.dispatch(human, approval), accepted);
          const changed = yield* factory
            .dispatch(human, {
              ...approval,
              configuration: { ...configuration, writablePaths: ["src/other.ts"] },
            })
            .pipe(Effect.result);
          assert.isTrue(Result.isFailure(changed));
          if (Result.isFailure(changed)) assert.equal(changed.failure.code, "command-conflict");
          const aliased = yield* factory
            .dispatch({ kind: "thread", threadId: manager.threadId }, approval)
            .pipe(Effect.result);
          assert.isTrue(Result.isFailure(aliased));
          if (Result.isFailure(aliased)) assert.equal(aliased.failure.code, "command-conflict");
          assert.deepStrictEqual(yield* Ref.get(captures), [
            { managerId: manager.id, configuration },
          ]);
          const reopened = yield* FactoryStore.FactoryStore.pipe(
            Effect.provide(Layer.fresh(FactoryStore.layer)),
          );
          const persisted = yield* reopened.snapshot;
          assert.equal(persisted.revision, accepted.revision);
          assert.equal(persisted.managers[0]!.status, "active");
          assert.equal(persisted.managers[0]!.boundaryId, boundary.id);
          assert.equal(persisted.managers[0]!.wait, null);
          assert.deepStrictEqual(persisted.boundaries, [boundary]);
          assert.equal(
            persisted.assignments[0]!.report?.summary,
            "Discovery identified the required project controls.",
          );
        }).pipe(
          Effect.provide(
            layer.pipe(
              Layer.provide(
                Layer.mock(FactoryBoundaryExecution.FactoryBoundaryExecution)({
                  approve: (input) =>
                    Ref.update(captures, (previous) => [...previous, input]).pipe(
                      Effect.as(boundary),
                    ),
                }),
              ),
            ),
          ),
        );
      }),
  );

  it.effect(
    "preserves an actionable runtime failure and blocked state until the same request succeeds",
    () =>
      Effect.gen(function* () {
        const available = yield* Ref.make(false);
        const captures = yield* Ref.make(0);
        const detail = "The approved image is unavailable in the local Docker engine.";
        yield* Effect.gen(function* () {
          const { factory, manager, assignment } = yield* start;
          yield* recordReport(factory, assignment);
          const before = yield* factory.snapshot({ projectId });
          const approval = {
            type: "manager.approve-onboarding" as const,
            commandId: CommandId.make("approve-web"),
            managerId: manager.id,
            configuration,
          };
          const failed = yield* factory.dispatch(human, approval).pipe(Effect.result);
          assert.isTrue(Result.isFailure(failed));
          if (Result.isFailure(failed)) {
            assert.equal(failed.failure.code, "execution-unavailable");
            assert.equal(failed.failure.detail, detail);
            assert.equal(failed.failure.message, detail);
          }
          const blocked = yield* factory.snapshot({ projectId });
          assert.equal(blocked.revision, before.revision);
          assert.equal(blocked.managers[0]!.status, "blocked");
          assert.equal(blocked.managers[0]!.boundaryId, undefined);
          assert.deepStrictEqual(blocked.managers[0]!.wait, before.managers[0]!.wait);
          assert.equal(blocked.boundaries.length, 0);
          yield* Ref.set(available, true);
          const accepted = yield* factory.dispatch(human, approval);
          yield* factory.drain;
          assert.deepStrictEqual(yield* factory.dispatch(human, approval), accepted);
          const active = yield* factory.snapshot({ projectId });
          assert.equal(active.managers[0]!.status, "active");
          assert.equal(active.managers[0]!.boundaryId, boundary.id);
          assert.deepStrictEqual(active.boundaries, [boundary]);
          assert.equal(yield* Ref.get(captures), 2);
        }).pipe(
          Effect.provide(
            layer.pipe(
              Layer.provide(
                Layer.mock(FactoryBoundaryExecution.FactoryBoundaryExecution)({
                  approve: () =>
                    Ref.update(captures, (count) => count + 1).pipe(
                      Effect.andThen(Ref.get(available)),
                      Effect.flatMap((ready) =>
                        ready
                          ? Effect.succeed(boundary)
                          : Effect.fail(
                              new FactoryError({ code: "execution-unavailable", detail }),
                            ),
                      ),
                    ),
                }),
              ),
            ),
          ),
        );
      }),
  );
});
