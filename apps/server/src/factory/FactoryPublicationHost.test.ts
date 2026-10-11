import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  FactoryAssignmentId,
  FactoryBoundaryId,
  FactorySourceId,
  ProjectId,
  ThreadId,
  type FactoryAssignment,
  type FactoryDeliveryRevision,
  type FactoryDecisionCommand,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as GitHubApi from "../sourceControl/GitHubApi.ts";
import * as GitHubCredentials from "../sourceControl/GitHubCredentials.ts";
import * as SourceControlProvider from "../sourceControl/SourceControlProvider.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as FactoryPublication from "./FactoryPublication.ts";
import * as FactoryPublicationHost from "./FactoryPublicationHost.ts";
import * as FactoryPreviewPublication from "./FactoryPreviewPublication.ts";
import * as FactorySource from "./FactorySource.ts";
import { initialFactorySnapshot } from "./FactoryState.ts";
import { FactoryStore } from "./FactoryStore.ts";

const now = "2026-10-10T12:00:00.000Z";
const projectId = ProjectId.make("host-project");
const boundaryId = FactoryBoundaryId.make("host-boundary");
const source = {
  id: FactorySourceId.make("host-source"),
  projectId,
  revision: "a".repeat(40),
  sourceDigest: "source-digest",
  branch: "main",
  origin: "project" as const,
  capturedAt: now,
  fileCount: 1,
  stagedPaths: [],
  unstagedPaths: [],
  untrackedPaths: [],
  deletedPaths: [],
  excludedPaths: [],
};
const revision: FactoryDeliveryRevision = {
  id: "revision-1",
  operationId: "operation-1",
  selectedPaths: ["source.cjs"],
  commitMessage: "Implement the feature",
  grantEpoch: 2,
  boundaryId,
  workflowRevision: "workflow",
  startingSourceId: source.id,
  status: "capturing",
  reviews: [],
  createdAt: now,
};
const assignment: FactoryAssignment = {
  id: FactoryAssignmentId.make("host-assignment"),
  projectId,
  managerId: ThreadId.make("manager"),
  threadId: ThreadId.make("lead"),
  kind: "implementation",
  startingSource: source,
  workflow: { repositoryRoot: "/skills", revision: "workflow" },
  status: "running",
  threadStatus: "created",
  launchStatus: "delivered",
  qualification: { status: "qualified", profileId: "runtime", checkedAt: now },
  grantedPolicy: initialFactorySnapshot().defaults,
  grant: {
    boundaryId,
    epoch: 2,
    sourcePaths: ["source.cjs"],
    creatableDirectories: [],
    controlChange: null,
  },
  wait: null,
  report: null,
  createdAt: now,
  updatedAt: now,
  delivery: {
    revisions: [revision],
    currentRevisionId: revision.id,
    directionHeld: false,
    readiness: [],
    retroFindings: [],
  },
};
const candidate = FactoryPublication.FactoryPublicationCandidate.make({
  id: "candidate",
  sourceDigest: "candidate-digest",
  files: [],
  deletedPaths: [],
  selectedPaths: ["source.cjs"],
  grant: assignment.grant!,
  configuration: {
    protectedPaths: [],
    writablePaths: ["source.cjs"],
    creatableDirectories: [],
    gates: [],
  },
});
const Metadata = Schema.Struct({ title: Schema.String, body: Schema.String });
const decodeMetadata = Schema.decodeUnknownEffect(Metadata);
const isRequestError = Schema.is(GitHubApi.GitHubApiRequestError);
const isResponseError = Schema.is(GitHubApi.GitHubApiResponseError);
const HostPullRequest = Schema.Struct({
  number: Schema.Int,
  html_url: Schema.String,
  title: Schema.String,
  body: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  merged_at: Schema.Null,
  head: Schema.Struct({
    ref: Schema.String,
    sha: Schema.String,
    repo: Schema.Struct({ full_name: Schema.String }),
  }),
  base: Schema.Struct({ ref: Schema.String, repo: Schema.Struct({ full_name: Schema.String }) }),
});

const fixture = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  let prepared: FactoryPublication.FactoryPublicationArtifact | undefined;
  let pullRequest: typeof HostPullRequest.Type | undefined;
  let createCount = 0;
  let prepareCount = 0;
  let pushCount = 0;
  let closedPullRequests: Array<typeof HostPullRequest.Type> = [];
  let nextNumber = 17;
  let lostCreateAck = false;
  let invisibleCreate = false;
  let pausedBeforeSend = false;
  let rejectLink = false;
  let remoteConflict = false;
  let configuredEmail: string | null = "factory@example.invalid";
  let credentialFingerprint = "approved-account";
  let currentAssignment = assignment;
  let revokeAfterPush = false;
  let revokeAfterCreate = false;
  let includeScreenshots = false;
  const proofReceipts: Array<FactoryDecisionCommand> = [];
  const screenshotProof = {
    operationsDigest: "d".repeat(64),
    commitOid: "e".repeat(40),
    urls: [
      {
        digest: "f".repeat(64),
        label: "Native screenshot",
        imageUrl: "https://github.example.invalid/Example/Factory/blob/e/image.png?raw=true",
        linkUrl: "https://github.example.invalid/Example/Factory/blob/e/image.png",
      },
    ],
  };
  const revoke = () => {
    currentAssignment = { ...currentAssignment, grant: { ...currentAssignment.grant!, epoch: 3 } };
  };
  const calls: Array<GitHubApi.GitHubRestInput> = [];
  const links: Array<OrchestrationV2ServerCommand> = [];
  const reply = (body: unknown): GitHubApi.GitHubRestResponse => ({
    status: 200,
    body: JSON.stringify(body),
    headers: {},
    truncated: false,
    invalidUtf8: false,
  });
  const dependencies = Layer.mergeAll(
    ServerConfig.layerTest(root, root),
    Layer.mock(FactoryPreviewPublication.FactoryPreviewPublication)({
      publish: () =>
        includeScreenshots
          ? Effect.succeed(screenshotProof)
          : Effect.die("No UX evidence in this fixture"),
    }),
    Layer.mock(FactoryStore)({
      snapshot: Effect.sync(() => ({
        ...initialFactorySnapshot(),
        assignments: [currentAssignment],
        previewPublicationPolicies: includeScreenshots
          ? [
              {
                projectId,
                enabled: true,
                approvedAt: now,
                authorizingCommandId: CommandId.make("opt-in"),
              },
            ]
          : [],
      })),
      commit: (input) =>
        Effect.sync(() => {
          proofReceipts.push(input.command);
          return { revision: 1 };
        }),
    }),
    Layer.mock(ProjectStoreV2)({
      get: () =>
        Effect.succeed(
          Option.some({
            projectId,
            title: "Project",
            workspaceRoot: root,
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            faviconPath: null,
            projectIcon: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          }),
        ),
    }),
    Layer.mock(ThreadManagementService)({
      dispatch: (command) =>
        Effect.gen(function* () {
          links.push(command);
          if (rejectLink)
            return yield* new OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
            });
          return { sequence: 1, storedEvents: [] };
        }),
    }),
    Layer.mock(GitVcsDriver.GitVcsDriver)({
      readConfigValue: (_cwd, key) =>
        Effect.succeed(key === "user.name" ? "Factory Author" : configuredEmail),
    }),
    Layer.mock(FactorySource.FactorySource)({
      read: () =>
        Effect.succeed({
          source,
          request: { requestId: CommandId.make("capture"), projectId },
          workspaceRoot: root,
          files: [],
          indexFiles: [],
          indexData: null,
        }),
    }),
    Layer.mock(GitHubCredentials.GitHubCredentials)({
      get: (host) =>
        Effect.succeed({
          host,
          fingerprint: credentialFingerprint,
          source: "settings",
          token: Redacted.make("fixture-token"),
        }),
    }),
    Layer.mock(GitHubApi.GitHubApi)({
      rest: (input) =>
        Effect.gen(function* () {
          calls.push(input);
          const pinned = yield* GitHubApi.PinnedGitHubCredential;
          assert.equal(pinned?.host, "github.example.invalid");
          assert.equal(pinned?.credentialFingerprint, "approved-account");
          if (input.path === "repos/Example/Factory" && input.method === undefined)
            return reply({
              full_name: "Example/Factory",
              default_branch: "main",
              permissions: { push: true },
            });
          if (input.method === "POST" || input.method === "PATCH") {
            // Like the real client: a paused rate limit refuses before the mutation hook runs.
            if (pausedBeforeSend) {
              pausedBeforeSend = false;
              return yield* new GitHubApi.GitHubApiRequestError({
                host: input.host,
                operation: input.operation,
                cause: "rate limit paused",
              });
            }
            const admit = yield* GitHubApi.BeforeGitHubMutation;
            if (admit) yield* admit;
          }
          if (input.method === "POST") {
            if (revokeAfterCreate) revoke();
            const metadata = yield* decodeMetadata(input.body);
            // GitHub allows one open PR per head and base.
            if (pullRequest)
              return yield* new GitHubApi.GitHubApiResponseError({
                host: input.host,
                operation: input.operation,
                status: 422,
                githubErrors: ["A pull request already exists."],
              });
            createCount += 1;
            pullRequest = {
              number: nextNumber,
              html_url: `https://github.example.invalid/Example/Factory/pull/${nextNumber}`,
              ...metadata,
              state: "open",
              merged_at: null,
              head: {
                ref: prepared!.reservation.branch,
                sha: prepared!.prepared.commitOid,
                repo: { full_name: "Example/Factory" },
              },
              base: { ref: "main", repo: { full_name: "Example/Factory" } },
            };
            nextNumber += 1;
            if (lostCreateAck || invisibleCreate)
              return yield* new GitHubApi.GitHubApiRequestError({
                host: input.host,
                operation: input.operation,
                cause: "lost response",
              });
            return reply(pullRequest);
          }
          if (input.method === "PATCH") {
            const metadata = yield* decodeMetadata(input.body);
            if (pullRequest) pullRequest = { ...pullRequest, ...metadata };
            return reply(pullRequest);
          }
          if (input.path.includes("?"))
            return reply([
              ...(input.path.includes("state=open") ? [] : closedPullRequests),
              ...(pullRequest && !invisibleCreate ? [pullRequest] : []),
            ]);
          return reply(pullRequest);
        }).pipe(
          Effect.mapError((cause) =>
            isRequestError(cause) || isResponseError(cause)
              ? cause
              : new GitHubApi.GitHubApiRequestError({
                  host: input.host,
                  operation: input.operation,
                  cause,
                }),
          ),
        ),
    }),
    Layer.mock(FactoryPublication.FactoryPublication)({
      prepare: (input) =>
        Effect.sync(() => {
          prepareCount += 1;
          prepared = {
            reservation: input.reservation,
            candidate: input.candidate,
            publishedFiles: [],
            prepared: {
              reservationId: input.reservation.id,
              candidateId: input.candidate.id,
              candidateDigest: input.candidate.sourceDigest,
              startingIndexTreeOid: "index",
              startingWorkTreeOid: "work",
              treeOid: "b".repeat(40),
              commitOid: "c".repeat(40),
              publishedSourceDigest: "published-digest",
              selectedPaths: input.candidate.selectedPaths,
            },
          };
          return prepared.prepared;
        }),
      read: () =>
        Effect.sync(() => {
          assert.isDefined(prepared);
          return prepared!;
        }),
      push: (input) =>
        Effect.gen(function* () {
          if (input.beforeWrite) yield* input.beforeWrite;
          pushCount += 1;
          if (revokeAfterPush) revoke();
          return FactoryPublication.FactoryPublicationObservation.make({
            status: remoteConflict ? "conflict" : "confirmed",
            remoteTip: prepared!.prepared.commitOid,
          });
        }),
    }),
  );
  const provider = SourceControlProvider.SourceControlProvider.of({
    kind: "github",
    listChangeRequests: () => Effect.die("REST owns exact destination"),
    getChangeRequest: () => Effect.die("REST owns exact destination"),
    createChangeRequest: () => Effect.die("REST owns exact destination"),
    getDefaultBranch: () => Effect.die("REST owns exact destination"),
    getRepositoryCloneUrls: () => Effect.die("Unused"),
    createRepository: () => Effect.die("Unused"),
    checkoutChangeRequest: () => Effect.die("Unused"),
  });
  const registry = Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => undefined,
    resolveHandle: () =>
      Effect.succeed({
        provider,
        context: {
          provider: { kind: "github", name: "GitHub", baseUrl: "https://github.example.invalid" },
          remoteName: "origin",
          remoteUrl: "git@github.example.invalid:Example/Factory.git",
        },
      }),
  });
  const layer = FactoryPublicationHost.layer.pipe(
    Layer.provide(registry),
    Layer.provide(dependencies),
  );
  const capture = Effect.gen(function* () {
    const host = yield* FactoryPublicationHost.FactoryPublicationHost;
    const destination = yield* host.prepare({ assignment, revision, candidate });
    const captured = {
      ...revision,
      status: "captured" as const,
      publication: destination,
      candidateId: candidate.id,
      candidateDigest: "published-digest",
      ...(includeScreenshots
        ? {
            uxEvidence: {
              instanceId: "preview",
              candidateDigest: "published-digest",
              reviewThreadId: ThreadId.make("reviewer"),
              operationsDigest: screenshotProof.operationsDigest,
              screenshots: [{ label: "Native screenshot", location: "native:png" }],
              journeys: [{ label: "Actual app", location: "native:journey" }],
              observedAt: now,
            },
          }
        : {}),
    };
    currentAssignment = {
      ...assignment,
      delivery: { ...assignment.delivery!, revisions: [captured] },
    };
    return captured;
  });
  return {
    layer,
    capture,
    calls,
    links,
    proofReceipts,
    includeScreenshots: () => {
      includeScreenshots = true;
    },
    revoke,
    revokeAfterPush: () => {
      revokeAfterPush = true;
    },
    revokeAfterCreate: () => {
      revokeAfterCreate = true;
    },
    restore: (captured: FactoryDeliveryRevision) => {
      revokeAfterPush = false;
      currentAssignment = {
        ...assignment,
        delivery: { ...assignment.delivery!, revisions: [captured] },
      };
    },
    prepared: () => prepared!,
    counts: () => ({ createCount, prepareCount, pushCount }),
    loseCreateAck: () => {
      lostCreateAck = true;
    },
    hideCreation: () => {
      invisibleCreate = true;
    },
    revealCreation: () => {
      invisibleCreate = false;
    },
    pauseBeforeSend: () => {
      pausedBeforeSend = true;
    },
    /** An earlier revision's PR on the same branch, closed by the human. */
    closeEarlier: () => {
      closedPullRequests = [
        {
          number: 16,
          html_url: "https://github.example.invalid/Example/Factory/pull/16",
          title: "Earlier",
          body: "Earlier",
          state: "closed",
          merged_at: null,
          head: {
            ref: prepared!.reservation.branch,
            sha: "9".repeat(40),
            repo: { full_name: "Example/Factory" },
          },
          base: { ref: "main", repo: { full_name: "Example/Factory" } },
        },
      ];
    },
    failLink: (value: boolean) => {
      rejectLink = value;
    },
    conflict: () => {
      remoteConflict = true;
    },
    missingIdentity: () => {
      configuredEmail = null;
    },
    changeAccount: () => {
      credentialFingerprint = "changed-account";
    },
    unrelated: () => {
      pullRequest = {
        number: 19,
        html_url: "https://github.example.invalid/Example/Factory/pull/19",
        title: "Unrelated",
        body: "Unrelated",
        state: "open",
        merged_at: null,
        head: {
          ref: prepared!.reservation.branch,
          sha: prepared!.prepared.commitOid,
          repo: { full_name: "Example/Factory" },
        },
        base: { ref: "main", repo: { full_name: "Example/Factory" } },
      };
    },
    moveHead: () => {
      if (pullRequest)
        pullRequest = { ...pullRequest, head: { ...pullRequest.head, sha: "d".repeat(40) } };
    },
  };
});
const run = <A, E, R>(
  body: (input: Effect.Success<ReturnType<typeof fixture>>) => Effect.Effect<A, E, R>,
) => fixture().pipe(Effect.flatMap(body), Effect.scoped, Effect.provide(NodeServices.layer));

it.effect(
  "records uploaded screenshot proof only after exact PR body and thread link succeed",
  () =>
    run((f) =>
      Effect.gen(function* () {
        f.includeScreenshots();
        const captured = yield* f.capture;
        const host = yield* FactoryPublicationHost.FactoryPublicationHost;
        const input = { assignment, revision: captured, title: "UI feature", body: "Completed" };
        f.failLink(true);
        yield* host.publish(input).pipe(Effect.flip);
        assert.equal(f.proofReceipts.length, 0);
        const create = f.calls.find((call) => call.method === "POST")!;
        const metadata = yield* decodeMetadata(create.body);
        assert.include(
          metadata.body,
          "![Screenshot 1](https://github.example.invalid/Example/Factory/blob/e/image.png?raw=true)",
        );
        assert.include(metadata.body, "[Open screenshot 1]");
        f.failLink(false);
        yield* host.publish(input);
        assert.equal(f.proofReceipts.length, 1);
        assert.equal(f.proofReceipts[0]!.type, "delivery.ux.published");
        assert.equal(f.counts().createCount, 1);
      }).pipe(Effect.provide(f.layer)),
    ),
);

it.effect(
  "rechecks current authority before push, PR creation and thread linking",
  () =>
    Effect.forEach(["before-push", "after-push", "after-create"] as const, (phase) =>
      run((f) =>
        Effect.gen(function* () {
          const captured = yield* f.capture;
          if (phase === "before-push") f.revoke();
          if (phase === "after-push") f.revokeAfterPush();
          if (phase === "after-create") f.revokeAfterCreate();
          const host = yield* FactoryPublicationHost.FactoryPublicationHost;
          yield* host
            .publish({ assignment, revision: captured, title: "Feature", body: "Ready" })
            .pipe(Effect.flip);
          assert.equal(f.counts().pushCount, phase === "before-push" ? 0 : 1);
          assert.equal(f.counts().createCount, phase === "after-create" ? 1 : 0);
          assert.equal(f.links.length, 0);
          if (phase === "after-push") {
            f.restore(captured);
            assert.equal(
              (yield* host.publish({
                assignment,
                revision: captured,
                title: "Feature",
                body: "Ready",
              })).number,
              17,
            );
            assert.equal(f.counts().createCount, 1);
          }
        }).pipe(Effect.provide(f.layer)),
      ),
    ),
  15_000,
);

it.effect(
  "pins destination and identity before writes and reuses that reservation after restart",
  () =>
    run((f) =>
      Effect.gen(function* () {
        const captured = yield* f.capture.pipe(Effect.provide(f.layer));
        assert.equal(f.counts().pushCount, 0);
        assert.equal(f.counts().createCount, 0);
        assert.equal(f.prepared().reservation.destination.kind, "github");
        assert.equal(f.prepared().reservation.author.email, "factory@example.invalid");
        assert.equal(f.prepared().reservation.author.timestamp, "1791633600 +0000");
        assert.equal(f.prepared().reservation.baseBranch, "main");
        f.missingIdentity();
        assert.deepEqual(yield* f.capture.pipe(Effect.provide(f.layer)), captured);
        assert.equal(
          f.calls.filter((call) => call.operation === "FactoryPublicationHost.repository").length,
          1,
        );
      }),
    ),
  10_000,
);

it.effect(
  "reconciles lost create acknowledgement and retries mandatory link receipt without creating another PR",
  () =>
    run((f) =>
      Effect.gen(function* () {
        const captured = yield* f.capture.pipe(Effect.provide(f.layer));
        f.loseCreateAck();
        f.failLink(true);
        const input = {
          assignment,
          revision: captured,
          title: "Implement feature",
          body: "Verified candidate",
        };
        const failure = yield* Effect.gen(function* () {
          return yield* (yield* FactoryPublicationHost.FactoryPublicationHost)
            .publish(input)
            .pipe(Effect.flip);
        }).pipe(Effect.provide(f.layer));
        assert.equal(failure.code, "execution-unavailable");
        assert.equal(f.counts().createCount, 1);
        f.failLink(false);
        const ref = yield* Effect.gen(function* () {
          return yield* (yield* FactoryPublicationHost.FactoryPublicationHost).publish(input);
        }).pipe(Effect.provide(f.layer));
        assert.deepEqual(ref, {
          projectId,
          host: "github.example.invalid",
          repository: "Example/Factory",
          number: 17,
        });
        assert.equal(f.counts().createCount, 1);
        assert.equal(f.links.length, 2);
        assert.deepEqual(f.links[0], f.links[1]);
        assert.equal(f.links[0]!.type, "thread.pull-request.link");
        f.moveHead();
        const moved = yield* Effect.gen(function* () {
          return yield* (yield* FactoryPublicationHost.FactoryPublicationHost)
            .publish(input)
            .pipe(Effect.flip);
        }).pipe(Effect.provide(f.layer));
        assert.include(moved.detail!, "exact head");
        assert.equal(f.links.length, 2);
      }),
    ),
  10_000,
);

it.effect(
  "refuses unrelated PRs, remote branch conflicts and changed exact heads",
  () =>
    run((f) =>
      Effect.gen(function* () {
        const captured = yield* f.capture;
        const host = yield* FactoryPublicationHost.FactoryPublicationHost;
        const input = { assignment, revision: captured, title: "Feature", body: "Ready" };
        f.unrelated();
        assert.include(
          (yield* host.publish(input).pipe(Effect.flip)).detail!,
          "existing pull request",
        );
        assert.equal(f.counts().createCount, 0);
        assert.equal(f.links.length, 0);
        f.conflict();
        assert.include((yield* host.publish(input).pipe(Effect.flip)).detail!, "branch moved");
      }).pipe(Effect.provide(f.layer)),
    ),
  10_000,
);

it.effect(
  "retries an unobservable create without opening a second PR and adopts it once visible",
  () =>
    run((f) =>
      Effect.gen(function* () {
        const captured = yield* f.capture;
        const host = yield* FactoryPublicationHost.FactoryPublicationHost;
        f.hideCreation();
        const input = { assignment, revision: captured, title: "Feature", body: "Ready" };
        assert.include(
          (yield* host.publish(input).pipe(Effect.flip)).detail!,
          "not yet observable",
        );
        assert.include(
          (yield* host.publish(input).pipe(Effect.flip)).detail!,
          "not yet observable",
        );
        assert.equal(f.counts().createCount, 1);
        assert.equal(f.links.length, 0);
        f.revealCreation();
        assert.equal((yield* host.publish(input)).number, 17);
        assert.equal(f.counts().createCount, 1);
        assert.equal(f.links.length, 1);
      }).pipe(Effect.provide(f.layer)),
    ),
  10_000,
);

it.effect(
  "creates the PR on retry when an earlier create was refused before it was sent",
  () =>
    run((f) =>
      Effect.gen(function* () {
        const captured = yield* f.capture;
        const host = yield* FactoryPublicationHost.FactoryPublicationHost;
        const input = { assignment, revision: captured, title: "Feature", body: "Ready" };
        f.pauseBeforeSend();
        yield* host.publish(input).pipe(Effect.flip);
        assert.equal(f.counts().createCount, 0);
        assert.equal((yield* host.publish(input)).number, 17);
        assert.equal(f.counts().createCount, 1);
        assert.equal(f.links.length, 1);
      }).pipe(Effect.provide(f.layer)),
    ),
  10_000,
);

it.effect(
  "opens a new PR instead of adopting one the human closed on the same branch",
  () =>
    run((f) =>
      Effect.gen(function* () {
        const captured = yield* f.capture;
        const host = yield* FactoryPublicationHost.FactoryPublicationHost;
        f.closeEarlier();
        const ref = yield* host.publish({
          assignment,
          revision: captured,
          title: "Feature",
          body: "Ready",
        });
        assert.equal(ref.number, 17);
        assert.equal(f.counts().createCount, 1);
      }).pipe(Effect.provide(f.layer)),
    ),
  10_000,
);

it.effect(
  "requires configured authors and rejects changed credentials or a different revision head",
  () =>
    run((f) =>
      Effect.gen(function* () {
        const captured = yield* f.capture;
        const host = yield* FactoryPublicationHost.FactoryPublicationHost;
        const altered = {
          ...captured,
          publication: { ...captured.publication, headSha: "d".repeat(40) },
        };
        assert.equal(
          (yield* host
            .publish({ assignment, revision: altered, title: "Feature", body: "Ready" })
            .pipe(Effect.flip)).code,
          "invalid-state",
        );
        f.changeAccount();
        assert.include(
          (yield* host
            .publish({ assignment, revision: captured, title: "Feature", body: "Ready" })
            .pipe(Effect.flip)).detail!,
          "account changed",
        );
        assert.equal(f.counts().pushCount, 0);
      }).pipe(Effect.provide(f.layer)),
    ),
  10_000,
);

it.effect(
  "does not reserve or publish work when configured Git author identity is missing",
  () =>
    run((f) =>
      Effect.gen(function* () {
        f.missingIdentity();
        const failure = yield* f.capture.pipe(Effect.flip);
        assert.include(failure.detail!, "Git author name and email");
        assert.deepEqual(f.counts(), { prepareCount: 0, pushCount: 0, createCount: 0 });
      }).pipe(Effect.provide(f.layer)),
    ),
  10_000,
);
