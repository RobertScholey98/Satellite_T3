import { assert, it } from "@effect/vitest";
import {
  FactoryControlId,
  FactoryError,
  PullRequestOperationError,
  type FactorySnapshot,
  type ProjectId,
  type PullRequestRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { PullRequestProviderError } from "../pullRequest/PullRequestProvider.ts";
import {
  fakeProvider,
  hostedChangeRequest,
  makeService as makePullRequestService,
  project,
} from "../pullRequest/PullRequestService.testkit.ts";
import { BeforeGitHubMutation } from "../sourceControl/GitHubApi.ts";
import * as Gate from "./FactoryPullRequestGate.ts";
import * as FactoryStore from "./FactoryStore.ts";
import { initialFactorySnapshot } from "./FactoryState.ts";
import { ready } from "./FactoryIntegration.testkit.ts";
import { factoryMergeGroupForAssignment } from "./FactoryMergeOwnership.ts";
import {
  applyDelivery,
  deliveryActors,
  deliveryIds,
  deliveryRevisionCommand,
  reviewedDeliveryFixture,
} from "./FactoryDelivery.testkit.ts";

it.effect(
  "holds canonical historical and reserved-branch group ownership across all ordinary mutation routes",
  () => {
    const fixture = ready().state;
    const ref: PullRequestRef = {
      projectId: deliveryIds.project,
      repository: "OWNER/Repo",
      number: 20,
    };
    let state: FactorySnapshot = {
      ...fixture,
      mergeGroups: [],
      assignments: fixture.assignments.map((assignment) =>
        assignment.id === deliveryIds.assignment
          ? {
              ...assignment,
              delivery: {
                ...assignment.delivery!,
                revisions: assignment.delivery!.revisions.map((revision) => ({
                  ...revision,
                  publication: {
                    reservationId: "reserved",
                    host: "GITHUB.COM",
                    repository: "owner/repo",
                    branch: "factory/pending",
                    baseBranch: "main",
                    headSha: "head",
                    treeOid: "tree",
                    ref,
                  },
                })),
              },
            }
          : assignment,
      ),
    };
    return Effect.gen(function* () {
      const gate = yield* Gate.FactoryPullRequestGate;
      const target = {
        ref: { ...ref, host: "github.com", repository: "owner/repo" },
        headSha: "head",
        headBranch: "different-branch",
      };
      for (const action of ["merge", "enable-auto-merge", "close-as-delivered"]) {
        const error = yield* gate
          .authorizeMutation({ action, targets: [target], expectedHeadSha: "head" })
          .pipe(
            Effect.provideService(Gate.FactoryDeliveryPermit, {
              assignmentId: deliveryIds.assignment,
              revisionId: state.assignments[0]!.delivery!.currentRevisionId!,
              operationId: "forged-individual-permit",
            }),
            Effect.flip,
          );
        assert.equal(error.code, "permission-denied");
        assert.include(error.detail!, "merge group");
      }
      // Closing, reopening or withdrawing auto-merge merges nothing, and hosts accept a head
      // condition only on merges.
      for (const action of ["close", "reopen", "disable-auto-merge"])
        assert.deepEqual(
          yield* gate.authorizeMutation({ action, targets: [target], expectedHeadSha: "head" }),
          { managed: true, requireConditionalMerge: false },
        );
      assert.equal(
        (yield* gate
          .authorizeMutation({ action: "merge", targets: [target], stack: true })
          .pipe(Effect.flip)).code,
        "permission-denied",
      );
      assert.equal(
        (yield* gate
          .authorizeMutation({
            action: "merge",
            targets: [
              { ...target, ref: { ...target.ref, number: 99 }, headBranch: "factory/pending" },
            ],
          })
          .pipe(Effect.flip)).code,
        "permission-denied",
      );
      const group = factoryMergeGroupForAssignment(state, deliveryIds.assignment)!;
      state = {
        ...state,
        mergeGroups: [
          group,
          { ...group, id: "duplicate-owner", integrationId: "duplicate-integration" },
        ],
        assignments: [],
        integrations: [],
      };
      assert.isTrue(yield* gate.appliesToRepository("GitHub.Com", "OWNER/REPO"));
      assert.equal(
        (yield* gate.authorizeMutation({ action: "merge", targets: [target] }).pipe(Effect.flip))
          .code,
        "permission-denied",
      );
      assert.deepEqual(
        yield* gate.authorizeMutation({
          action: "merge",
          targets: [{ ...target, ref: { ...target.ref, number: 21 } }],
        }),
        { managed: false, requireConditionalMerge: false },
      );
    }).pipe(
      Effect.provide(
        Gate.layer.pipe(
          Layer.provide(
            Layer.mock(FactoryStore.FactoryStore)({ snapshot: Effect.sync(() => state) }),
          ),
        ),
      ),
    );
  },
);

/** The pull-request service with managed delivery as its action gate, over a fixed snapshot. */
const makeService = ({
  factorySnapshot,
  ...input
}: Omit<Parameters<typeof makePullRequestService>[0], "actionGate"> & {
  readonly factorySnapshot?: FactorySnapshot | (() => FactorySnapshot);
}) =>
  makePullRequestService({
    ...input,
    actionGate: Gate.layerActionGate.pipe(
      Layer.provide(
        Layer.mock(FactoryStore.FactoryStore)({
          snapshot:
            typeof factorySnapshot === "function"
              ? Effect.sync(factorySnapshot)
              : Effect.succeed(factorySnapshot ?? initialFactorySnapshot()),
        }),
      ),
    ),
  });

const factoryProject = () =>
  project({
    id: "project-alias",
    title: "Same repository alias",
    workspaceRoot: "/factory",
    repository: "owner/repo",
  });
const factoryRef = {
  projectId: "project-alias" as ProjectId,
  host: "github.com",
  repository: "owner/repo",
  number: 20,
};
const managedDetail = (number = 20) => ({
  ...hostedChangeRequest("Managed work"),
  number,
  headBranch: number === 20 ? "factory/work" : "unmanaged",
  headSha: number === 20 ? "head" : "other-head",
});
const approvedFactoryMerge = () => {
  const approved = applyDelivery(
    reviewedDeliveryFixture(),
    {
      ...deliveryRevisionCommand,
      type: "delivery.approve",
      expectedHeadSha: "head",
      bundleDigest: "bundle",
    },
    deliveryActors.human,
  ).state;
  return applyDelivery(approved, { ...deliveryRevisionCommand, type: "delivery.merge" }).state;
};
const factoryPermit = {
  assignmentId: deliveryIds.assignment,
  revisionId: deliveryRevisionCommand.revisionId,
  operationId: "merge:command",
};

it.effect.each([
  "pause",
  "cancel",
  "grant",
  "wait",
  "group",
  "new-group",
  "new-repository",
  "ordinary",
] as const)("rechecks %s after provider staging and before an actual merge write", (scenario) =>
  Effect.gen(function* () {
    let state = approvedFactoryMerge();
    if (scenario === "new-repository") state = { ...state, assignments: [] };
    let staged = 0;
    let mutations = 0;
    let hadGuard = false;
    const base = fakeProvider("github");
    const service = yield* makeService({
      factorySnapshot: () => state,
      projects: [factoryProject()],
      providers: [
        {
          ...base,
          capabilities: { ...base.capabilities, conditionalMerge: true },
          getChangeRequest: ({ number }) => Effect.succeed(managedDetail(number)),
          runAction: () =>
            Effect.gen(function* () {
              staged++;
              if (scenario === "new-repository")
                state = {
                  ...approvedFactoryMerge(),
                  integrations: ready().state.integrations,
                  mergeGroups: [],
                };
              else if (scenario === "new-group") {
                const integration = ready().state.integrations[0]!;
                state = {
                  ...state,
                  mergeGroups: [
                    {
                      id: "late-group",
                      integrationId: integration.id,
                      integrationAssignmentId: integration.assignmentId,
                      memberAssignmentIds: integration.participantAssignmentIds,
                      knownPullRequests: [
                        {
                          assignmentId: deliveryIds.assignment,
                          ref: { ...factoryRef, number: 21 },
                        },
                      ],
                      currentReviewId: null,
                      createdAt: integration.createdAt,
                      updatedAt: integration.updatedAt,
                    },
                  ],
                };
              } else if (scenario === "group")
                state = {
                  ...state,
                  integrations: ready().state.integrations,
                  mergeGroups: [],
                };
              else if (scenario === "pause" || scenario === "ordinary")
                state = {
                  ...state,
                  controls: [
                    {
                      id: FactoryControlId.make("queued-pause"),
                      kind: "project-pause",
                      projectId: deliveryIds.project,
                      status: "active",
                      generation: 1,
                      requestedAt: "2026-10-10T21:00:00.000Z",
                      updatedAt: "2026-10-10T21:00:00.000Z",
                      stop: { status: "pending" },
                    },
                  ],
                };
              else
                state = {
                  ...state,
                  assignments: state.assignments.map((assignment) => ({
                    ...assignment,
                    ...(scenario === "cancel"
                      ? {
                          outcome: {
                            kind: "cancelled" as const,
                            controlId: FactoryControlId.make("queued-cancel"),
                          },
                        }
                      : {}),
                    ...(scenario === "grant"
                      ? { grant: { ...assignment.grant!, epoch: assignment.grant!.epoch + 1 } }
                      : {}),
                    ...(scenario === "wait"
                      ? {
                          wait: {
                            kind: "human-decision" as const,
                            reason: "Resolve the integration contract first",
                          },
                        }
                      : {}),
                  })),
                };
              const guard = yield* BeforeGitHubMutation;
              hadGuard = guard !== null;
              if (guard) yield* guard;
              mutations++;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new PullRequestProviderError({
                    provider: "github",
                    operation: "merge",
                    reason: "failed",
                    detail: "Merge was not admitted",
                    cause,
                  }),
              ),
            ),
        },
      ],
    });
    const action = service
      .runAction({
        ...factoryRef,
        number: scenario === "ordinary" || scenario === "new-group" ? 21 : 20,
        action: "merge",
        expectedHeadSha:
          scenario === "ordinary" || scenario === "new-group" ? "other-head" : "head",
      })
      .pipe(Effect.provideService(Gate.FactoryDeliveryPermit, factoryPermit));
    if (scenario === "ordinary") yield* action;
    else yield* action.pipe(Effect.flip);
    assert.equal(staged, 1);
    assert.isTrue(hadGuard);
    assert.equal(mutations, scenario === "ordinary" ? 1 : 0);
  }),
);

it.effect(
  "blocks a generic managed merge through a different project alias despite a supplied expected head",
  () =>
    Effect.gen(function* () {
      let mutations = 0;
      const base = fakeProvider("github");
      const service = yield* makeService({
        factorySnapshot: approvedFactoryMerge(),
        projects: [factoryProject()],
        providers: [
          {
            ...base,
            capabilities: { ...base.capabilities, conditionalMerge: true },
            getChangeRequest: () => Effect.succeed(managedDetail()),
            runAction: () =>
              Effect.sync(() => {
                mutations++;
              }),
          },
        ],
      });
      const error = yield* service
        .runAction({ ...factoryRef, action: "merge", expectedHeadSha: "head" })
        .pipe(Effect.flip);
      assert.instanceOf(error, PullRequestOperationError);
      if (error._tag !== "PullRequestOperationError") return;
      assert.include(error.detail, "belongs to a managed team");
      assert.instanceOf(error.cause, FactoryError);
      assert.strictEqual(mutations, 0);
    }),
);

it.effect("reports a mutation-boundary refusal with the factory's reason", () =>
  Effect.gen(function* () {
    let state = approvedFactoryMerge();
    let mutations = 0;
    const base = fakeProvider("github");
    const service = yield* makeService({
      factorySnapshot: () => state,
      projects: [factoryProject()],
      providers: [
        {
          ...base,
          capabilities: { ...base.capabilities, conditionalMerge: true },
          getChangeRequest: ({ number }) => Effect.succeed(managedDetail(number)),
          runAction: () =>
            Effect.gen(function* () {
              // The assignment is cancelled while the authorized merge is queued.
              state = {
                ...state,
                assignments: state.assignments.map((assignment) => ({
                  ...assignment,
                  outcome: {
                    kind: "cancelled" as const,
                    controlId: FactoryControlId.make("queued-cancel"),
                  },
                })),
              };
              const guard = yield* BeforeGitHubMutation;
              if (guard) yield* guard;
              mutations++;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new PullRequestProviderError({
                    provider: "github",
                    operation: "merge",
                    reason: "failed",
                    detail: "Could not reach GitHub at github.com.",
                    cause,
                  }),
              ),
            ),
        },
      ],
    });
    const error = yield* service
      .runAction({ ...factoryRef, action: "merge", expectedHeadSha: "head" })
      .pipe(Effect.provideService(Gate.FactoryDeliveryPermit, factoryPermit), Effect.flip);
    assert.strictEqual(mutations, 0);
    assert.instanceOf(error, PullRequestOperationError);
    if (error._tag !== "PullRequestOperationError") return;
    assert.include(error.detail, "belongs to a managed team");
    assert.instanceOf(error.cause, FactoryError);
  }),
);

it.effect(
  "forwards an exact internally authorized managed merge with the host-only conditional requirement",
  () =>
    Effect.gen(function* () {
      const mutations: unknown[] = [];
      const base = fakeProvider("github");
      const service = yield* makeService({
        factorySnapshot: approvedFactoryMerge(),
        projects: [factoryProject()],
        providers: [
          {
            ...base,
            capabilities: { ...base.capabilities, conditionalMerge: true },
            getChangeRequest: () => Effect.succeed(managedDetail()),
            runAction: (input) =>
              Effect.sync(() => {
                mutations.push(input);
              }),
          },
        ],
      });
      yield* service
        .runAction({ ...factoryRef, action: "merge", expectedHeadSha: "head" })
        .pipe(Effect.provideService(Gate.FactoryDeliveryPermit, factoryPermit));
      assert.deepStrictEqual(mutations, [
        {
          cwd: "/factory",
          repository: "owner/repo",
          host: "github.com",
          number: 20,
          action: "merge",
          expectedHeadSha: "head",
          requireConditionalMerge: true,
        },
      ]);
    }),
);

it.effect("blocks a pending publication by reserved branch before its PR number is recorded", () =>
  Effect.gen(function* () {
    let mutations = 0;
    const initial = reviewedDeliveryFixture();
    const state: FactorySnapshot = {
      ...initial,
      assignments: initial.assignments.map((assignment) => ({
        ...assignment,
        delivery: {
          ...assignment.delivery!,
          revisions: assignment.delivery!.revisions.map((revision) => {
            const { ref: _ref, ...publication } = revision.publication!;
            return { ...revision, publication };
          }),
        },
      })),
    };
    const service = yield* makeService({
      factorySnapshot: state,
      projects: [factoryProject()],
      providers: [
        fakeProvider("github", {
          getChangeRequest: () => Effect.succeed({ ...managedDetail(), number: 99 }),
          runAction: () =>
            Effect.sync(() => {
              mutations++;
            }),
        }),
      ],
    });
    const error = yield* service
      .runAction({ ...factoryRef, number: 99, action: "merge" })
      .pipe(Effect.flip);
    assert.strictEqual(error._tag, "PullRequestOperationError");
    assert.strictEqual(mutations, 0);
  }),
);

it.effect(
  "inspects every stack member and refuses a managed layer behind an unmanaged anchor",
  () =>
    Effect.gen(function* () {
      const reads: number[] = [];
      let mutations = 0;
      const base = fakeProvider("github");
      const service = yield* makeService({
        factorySnapshot: reviewedDeliveryFixture(),
        projects: [factoryProject()],
        providers: [
          {
            ...base,
            capabilities: { ...base.capabilities, stackActions: true },
            getChangeRequest: ({ number }) =>
              Effect.sync(() => {
                reads.push(number);
                return managedDetail(number);
              }),
            getChangeRequestStack: () =>
              Effect.succeed({
                id: "stack-3",
                number: 3,
                url: "https://github.com/owner/repo/stacks/3",
                base: "main",
                layers: [
                  { number: 21, headBranch: "unmanaged", state: "open" },
                  { number: 20, headBranch: "factory/work", state: "open" },
                ],
              }),
            runAction: () =>
              Effect.sync(() => {
                mutations++;
              }),
          },
        ],
      });
      const error = yield* service
        .runAction({
          ...factoryRef,
          number: 21,
          action: "merge",
          stackNumber: 3,
          expectedStackHeads: [
            { number: 21, headSha: "other-head" },
            { number: 20, headSha: "head" },
          ],
        })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "PullRequestOperationError");
      assert.deepStrictEqual(reads, [21, 20]);
      assert.strictEqual(mutations, 0);
    }),
);

it.effect("preserves an unrelated stack merge inside a repository that also has managed work", () =>
  Effect.gen(function* () {
    const mutations: unknown[] = [];
    const base = fakeProvider("github");
    const service = yield* makeService({
      factorySnapshot: reviewedDeliveryFixture(),
      projects: [factoryProject()],
      providers: [
        {
          ...base,
          capabilities: { ...base.capabilities, stackActions: true },
          getChangeRequest: ({ number }) => Effect.succeed(managedDetail(number)),
          getChangeRequestStack: () =>
            Effect.succeed({
              id: "stack-3",
              number: 3,
              url: "https://github.com/owner/repo/stacks/3",
              base: "main",
              layers: [
                { number: 21, headBranch: "unmanaged", state: "open" },
                { number: 22, headBranch: "unmanaged", state: "closed" },
              ],
            }),
          runAction: (input) =>
            Effect.sync(() => {
              mutations.push(input);
            }),
        },
      ],
    });
    yield* service.runAction({
      ...factoryRef,
      number: 21,
      action: "merge",
      stackNumber: 3,
      expectedStackHeads: [{ number: 21, headSha: "other-head" }],
    });
    assert.lengthOf(mutations, 1);
    assert.deepStrictEqual(mutations[0], {
      cwd: "/factory",
      host: "github.com",
      repository: "owner/repo",
      number: 21,
      action: "merge",
      stackNumber: 3,
      expectedStackHeads: [{ number: 21, headSha: "other-head" }],
    });
  }),
);

it.effect.each(["different-stack", "new-member", "missing-head"] as const)(
  "refuses factory stack authorization against %s",
  (scenario) =>
    Effect.gen(function* () {
      let mutations = 0;
      const base = fakeProvider("github");
      const service = yield* makeService({
        factorySnapshot: reviewedDeliveryFixture(),
        projects: [factoryProject()],
        providers: [
          {
            ...base,
            capabilities: { ...base.capabilities, stackActions: true },
            getChangeRequest: ({ number }) => {
              const { headSha, ...detail } = managedDetail(number);
              return Effect.succeed(scenario === "missing-head" ? detail : { ...detail, headSha });
            },
            getChangeRequestStack: () =>
              Effect.succeed({
                id: "stack-3",
                number: 3,
                url: "https://github.com/owner/repo/stacks/3",
                base: "main",
                layers: [{ number: 21, headBranch: "unmanaged", state: "open" }],
              }),
            runAction: () =>
              Effect.sync(() => {
                mutations++;
              }),
          },
        ],
      });
      const error = yield* service
        .runAction({
          ...factoryRef,
          number: 21,
          action: "merge",
          stackNumber: scenario === "different-stack" ? 4 : 3,
          expectedStackHeads: [
            { number: 21, headSha: "other-head" },
            ...(scenario === "new-member" ? [{ number: 20, headSha: "head" }] : []),
          ],
        })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "PullRequestOperationError");
      assert.strictEqual(mutations, 0);
    }),
);
