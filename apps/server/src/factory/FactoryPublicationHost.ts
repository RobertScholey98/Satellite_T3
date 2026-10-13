import {
  CommandId,
  FactoryError,
  ProjectId,
  PullRequestRef,
  type FactoryAssignment,
  type FactoryDeliveryRevision,
  type FactoryPublicationDestination,
  isFactoryError,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as GitHubApi from "../sourceControl/GitHubApi.ts";
import * as GitHubCredentials from "../sourceControl/GitHubCredentials.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as FactoryPublication from "./FactoryPublication.ts";
import * as FactoryPreviewPublication from "./FactoryPreviewPublication.ts";
import * as FactorySource from "./FactorySource.ts";
import * as FactoryStore from "./FactoryStore.ts";
import { factoryIncidentBlocked } from "./FactoryCollaboration.ts";
import { factoryExecutionBlocked } from "./FactoryControls.ts";

const ReservationRecord = Schema.Struct({
  projectId: ProjectId,
  revisionId: Schema.String,
  candidateId: Schema.String,
  candidateDigest: Schema.String,
  selectedPaths: Schema.Array(Schema.String),
  reservation: FactoryPublication.FactoryPublicationReservation,
});
const PublishRecord = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  ref: Schema.optionalKey(PullRequestRef),
});
const Repository = Schema.Struct({
  full_name: Schema.String,
  default_branch: Schema.String,
  permissions: Schema.Struct({ push: Schema.Boolean }),
});
const RemoteRepository = Schema.Struct({ full_name: Schema.String });
const PullRequest = Schema.Struct({
  number: Schema.Int,
  html_url: Schema.String,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  state: Schema.Literals(["open", "closed"]),
  merged_at: Schema.NullOr(Schema.String),
  head: Schema.Struct({
    ref: Schema.String,
    sha: Schema.String,
    repo: Schema.NullOr(RemoteRepository),
  }),
  base: Schema.Struct({ ref: Schema.String, repo: RemoteRepository }),
});
const decodeRepository = Schema.decodeUnknownEffect(Schema.fromJsonString(Repository));
const decodePullRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(PullRequest));
const decodePullRequests = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(PullRequest)),
);
const encodeReservation = Schema.encodeEffect(Schema.fromJsonString(ReservationRecord));
const decodeReservation = Schema.decodeUnknownEffect(Schema.fromJsonString(ReservationRecord));
const encodePublish = Schema.encodeEffect(Schema.fromJsonString(PublishRecord));
const decodePublish = Schema.decodeUnknownEffect(Schema.fromJsonString(PublishRecord));
const preserve = (cause: unknown) =>
  isFactoryError(cause)
    ? cause
    : new FactoryError({
        code: "execution-unavailable",
        detail: "The pinned publication destination could not be prepared or reconciled.",
        cause,
      });

/**
 * Turns a delivery revision into a GitHub pull request. `prepare` pins the destination and
 * builds the private commit while the candidate is captured; `publish` pushes it and opens or
 * adopts the PR when the lead publishes. Both are safe to rerun: each records its choices on disk
 * first and reconciles with what the host already shows.
 */
export class FactoryPublicationHost extends Context.Service<
  FactoryPublicationHost,
  {
    /**
     * Pins the destination on the revision's first run and builds its commit. An assignment's
     * first revision targets the project's GitHub remote and default branch on a branch derived
     * from the assignment; later revisions stack onto the last published revision's commit.
     */
    readonly prepare: (input: {
      readonly assignment: FactoryAssignment;
      readonly revision: FactoryDeliveryRevision;
      readonly candidate: FactoryPublication.FactoryPublicationCandidate;
    }) => Effect.Effect<FactoryPublicationDestination, FactoryError>;
    /**
     * Pushes the exact prepared commit, publishes any UX screenshots, and creates or adopts the
     * one open PR carrying this assignment's marker, then links it to the lead's thread. Every
     * host write first rechecks that the revision is still current and unblocked. Fails, rather
     * than guessing, when the push or the PR's identity cannot be confirmed.
     */
    readonly publish: (input: {
      readonly assignment: FactoryAssignment;
      readonly revision: FactoryDeliveryRevision;
      readonly title: string;
      readonly body: string;
    }) => Effect.Effect<PullRequestRef, FactoryError>;
  }
>()("t3/factory/FactoryPublicationHost") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const registry = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const api = yield* GitHubApi.GitHubApi;
  const credentials = yield* GitHubCredentials.GitHubCredentials;
  const publication = yield* FactoryPublication.FactoryPublication;
  const sources = yield* FactorySource.FactorySource;
  const store = yield* FactoryStore.FactoryStore;
  const previews = yield* FactoryPreviewPublication.FactoryPreviewPublication;
  const mutex = yield* Semaphore.make(1);
  const root = path.join(config.stateDir, "factory", "publication-host");
  const hash = (value: string) =>
    crypto
      .digest("SHA-256", Buffer.from(value))
      .pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex")));
  const directoryFor = (id: string) => hash(id).pipe(Effect.map((value) => path.join(root, value)));
  const write = Effect.fn(function* (target: string, content: string) {
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFileString(`${target}.pending`, content);
    yield* fs.rename(`${target}.pending`, target);
  });
  const requireRevision = (assignment: FactoryAssignment, revision: FactoryDeliveryRevision) => {
    const source = assignment.startingSource;
    const grant = assignment.grant;
    if (
      !source ||
      !grant ||
      assignment.kind === "onboarding" ||
      source.projectId !== assignment.projectId ||
      revision.startingSourceId !== source.id ||
      revision.boundaryId !== grant.boundaryId ||
      revision.grantEpoch !== grant.epoch ||
      revision.workflowRevision !== assignment.workflow.revision ||
      !assignment.delivery?.revisions.some(
        (entry) => entry.id === revision.id && entry.operationId === revision.operationId,
      )
    )
      return Effect.fail(
        new FactoryError({
          code: "invalid-state",
          detail: "The delivery revision no longer matches its assignment authority.",
        }),
      );
    return Effect.succeed({ source, grant });
  };
  const endpointFor = (
    destination: typeof FactoryPublication.FactoryPublicationDestination.Type,
  ) => {
    if (destination.kind !== "github")
      return Effect.fail(
        new FactoryError({
          code: "execution-unavailable",
          detail: "Managed pull requests currently require a qualified GitHub destination.",
        }),
      );
    return Effect.succeed({
      ...destination,
      repositoryName: `${destination.owner}/${destination.repository}`,
      endpoint: `repos/${encodeURIComponent(destination.owner)}/${encodeURIComponent(destination.repository)}`,
    });
  };
  // Given `expectedFingerprint`, the call is pinned to the credential the destination was
  // reserved with, so a changed account fails instead of publishing as someone else.
  // `beforeWrite` runs up front and again right before the request is sent.
  const request = Effect.fn(function* (
    input: GitHubApi.GitHubRestInput,
    expectedFingerprint?: string,
    beforeWrite?: Effect.Effect<void, FactoryError>,
    onAdmitted: Effect.Effect<void> = Effect.void,
  ) {
    const credential = yield* credentials.get(input.host);
    if (
      credential.host !== input.host ||
      (expectedFingerprint !== undefined && credential.fingerprint !== expectedFingerprint)
    )
      return yield* new FactoryError({
        code: "execution-unavailable",
        detail: "The publication account changed. Reauthorize the destination before publishing.",
      });
    if (beforeWrite) yield* beforeWrite;
    const response = yield* api.rest(input).pipe(
      Effect.provideService(
        GitHubApi.BeforeGitHubMutation,
        beforeWrite?.pipe(
          // The hook runs after the rate-limit lease, immediately before the request is sent.
          Effect.andThen(onAdmitted),
          Effect.mapError(
            (cause) =>
              new GitHubApi.GitHubApiRequestError({
                host: input.host,
                operation: input.operation,
                cause,
              }),
          ),
        ) ?? null,
      ),
      Effect.provideService(GitHubApi.PinnedGitHubCredential, {
        host: credential.host,
        token: credential.token,
        credentialFingerprint: credential.fingerprint,
      }),
    );
    if (response.truncated || response.invalidUtf8)
      return yield* new FactoryError({
        code: "execution-unavailable",
        detail: "The hosting response was incomplete. Publication remains unconfirmed.",
      });
    return response;
  });
  const requireCredential = Effect.fn(function* (
    destination: typeof FactoryPublication.FactoryPublicationDestination.Type,
  ) {
    const target = yield* endpointFor(destination);
    const credential = yield* credentials.get(target.host);
    if (credential.host !== target.host || credential.fingerprint !== target.credentialFingerprint)
      return yield* new FactoryError({
        code: "execution-unavailable",
        detail: "The publication account changed. Reauthorize the destination before publishing.",
      });
    return target;
  });
  const prepare = Effect.fn("FactoryPublicationHost.prepare")(
    function* (input: {
      readonly assignment: FactoryAssignment;
      readonly revision: FactoryDeliveryRevision;
      readonly candidate: FactoryPublication.FactoryPublicationCandidate;
    }) {
      const { assignment, revision, candidate } = input;
      const { source, grant } = yield* requireRevision(assignment, revision);
      if (
        stableStringify(candidate.grant) !== stableStringify(grant) ||
        stableStringify(candidate.selectedPaths) !== stableStringify(revision.selectedPaths)
      )
        return yield* new FactoryError({
          code: "invalid-state",
          detail: "The frozen candidate does not match the reserved delivery scope.",
        });
      // The first run records the reservation; reruns must describe the same revision and
      // candidate, so the destination never changes after it is chosen.
      const directory = yield* directoryFor(revision.id);
      const reservationPath = path.join(directory, "reservation.json");
      let record: typeof ReservationRecord.Type;
      if (yield* fs.exists(reservationPath)) {
        record = yield* fs.readFileString(reservationPath).pipe(Effect.flatMap(decodeReservation));
        if (
          record.projectId !== assignment.projectId ||
          record.revisionId !== revision.id ||
          record.reservation.assignmentId !== assignment.id ||
          record.candidateId !== candidate.id ||
          record.candidateDigest !== candidate.sourceDigest ||
          record.reservation.sourceId !== source.id ||
          record.reservation.epoch !== grant.epoch ||
          record.reservation.boundaryId !== grant.boundaryId ||
          record.reservation.message !== revision.commitMessage ||
          stableStringify(record.selectedPaths) !== stableStringify(candidate.selectedPaths)
        )
          return yield* new FactoryError({ code: "command-conflict" });
      } else {
        const project = yield* projects.get(assignment.projectId);
        if (Option.isNone(project) || project.value.deletedAt !== null)
          return yield* new FactoryError({
            code: "invalid-state",
            detail: "The assignment project is unavailable.",
          });
        const artifact = yield* sources.read(source.id);
        if (
          artifact.source.projectId !== assignment.projectId ||
          artifact.source.revision !== source.revision ||
          artifact.source.sourceDigest !== source.sourceDigest
        )
          return yield* new FactoryError({
            code: "invalid-state",
            detail: "The adopted starting source does not match this assignment.",
          });
        const revisions = assignment.delivery?.revisions ?? [];
        const position = revisions.findIndex((entry) => entry.id === revision.id);
        const previous = revisions
          .slice(0, position)
          .findLast((entry) => entry.status === "published" && entry.publication !== undefined);
        let reservation: FactoryPublication.FactoryPublicationReservation;
        const timestamp = `${Math.floor(DateTime.toEpochMillis(DateTime.makeUnsafe(revision.createdAt)) / 1000)} +0000`;
        if (previous?.publication) {
          const prior = yield* publication.read(previous.publication.reservationId);
          if (
            prior.reservation.assignmentId !== assignment.id ||
            prior.reservation.sourceId !== source.id ||
            prior.prepared.commitOid !== previous.publication.headSha
          )
            return yield* new FactoryError({
              code: "invalid-state",
              detail: "The previous publication does not belong to this assignment.",
            });
          reservation = {
            ...prior.reservation,
            id: revision.id,
            previousReservationId: prior.reservation.id,
            boundaryId: grant.boundaryId,
            epoch: grant.epoch,
            parentCommit: prior.prepared.commitOid,
            expectedTip: prior.prepared.commitOid,
            message: revision.commitMessage,
            author: { ...prior.reservation.author, timestamp },
            committer: { ...prior.reservation.committer, timestamp },
          };
        } else {
          const handle = yield* registry.resolveHandle({ cwd: project.value.workspaceRoot });
          if (handle.provider.kind !== "github" || handle.context?.provider.kind !== "github")
            return yield* new FactoryError({
              code: "execution-unavailable",
              detail: "Managed publication currently requires a qualified GitHub project remote.",
            });
          const remote = handle.context.remoteUrl;
          const scp = /^git@([^:/]+):([^\s]+)$/.exec(remote);
          const parsed = yield* Effect.try({
            try: () => new URL(scp ? `ssh://git@${scp[1]}/${scp[2]}` : remote),
            catch: preserve,
          });
          const providerUrl = yield* Effect.try({
            try: () => new URL(handle.context!.provider.baseUrl),
            catch: preserve,
          });
          const repositoryMatch = /^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(parsed.pathname);
          if (
            !repositoryMatch ||
            !["ssh:", "https:"].includes(parsed.protocol) ||
            parsed.password ||
            parsed.search ||
            parsed.hash ||
            parsed.port ||
            (parsed.protocol === "https:" && parsed.username) ||
            providerUrl.protocol !== "https:" ||
            parsed.hostname.toLowerCase() !== providerUrl.hostname.toLowerCase()
          )
            return yield* new FactoryError({
              code: "execution-unavailable",
              detail: "The project remote cannot be mapped to an exact supported publication host.",
            });
          const host = parsed.hostname.toLowerCase();
          const repositoryName = `${repositoryMatch[1]}/${repositoryMatch[2]}`;
          const repo = yield* request({
            host,
            operation: "FactoryPublicationHost.repository",
            path: `repos/${repositoryName}`,
          }).pipe(Effect.flatMap((response) => decodeRepository(response.body)));
          if (
            repo.full_name.toLowerCase() !== repositoryName.toLowerCase() ||
            !repo.default_branch ||
            !repo.permissions.push
          )
            return yield* new FactoryError({
              code: "execution-unavailable",
              detail: "The selected account cannot publish to the exact project repository.",
            });
          const [owner, repository] = repo.full_name.split("/");
          if (!owner || !repository) return yield* new FactoryError({ code: "invalid-state" });
          const name = yield* git.readConfigValue(artifact.workspaceRoot, "user.name");
          const email = yield* git.readConfigValue(artifact.workspaceRoot, "user.email");
          if (!name?.trim() || !email?.trim())
            return yield* new FactoryError({
              code: "execution-unavailable",
              detail:
                "Configure a Git author name and email for this project before preparing delivery.",
            });
          const credential = yield* credentials.get(host);
          reservation = {
            id: revision.id,
            assignmentId: assignment.id,
            sourceId: source.id,
            boundaryId: grant.boundaryId,
            epoch: grant.epoch,
            parentCommit: source.revision,
            destination: {
              kind: "github",
              host,
              owner,
              repository,
              credentialFingerprint: credential.fingerprint,
            },
            branch: `satellite/factory/${(yield* hash(assignment.id)).slice(0, 32)}`,
            baseBranch: repo.default_branch,
            expectedTip: null,
            author: { name, email, timestamp },
            committer: { name, email, timestamp },
            message: revision.commitMessage,
          };
        }
        record = {
          projectId: assignment.projectId,
          revisionId: revision.id,
          candidateId: candidate.id,
          candidateDigest: candidate.sourceDigest,
          selectedPaths: candidate.selectedPaths,
          reservation,
        };
        yield* write(reservationPath, yield* encodeReservation(record));
      }
      const prepared = yield* publication.prepare({ reservation: record.reservation, candidate });
      const destination = yield* endpointFor(record.reservation.destination);
      return {
        reservationId: record.reservation.id,
        host: destination.host,
        repository: destination.repositoryName,
        branch: record.reservation.branch,
        baseBranch: record.reservation.baseBranch,
        headSha: prepared.commitOid,
        treeOid: prepared.treeOid,
      } satisfies FactoryPublicationDestination;
    },
    mutex.withPermit,
    Effect.mapError(preserve),
  );
  const publish = Effect.fn("FactoryPublicationHost.publish")(
    function* (input: {
      readonly assignment: FactoryAssignment;
      readonly revision: FactoryDeliveryRevision;
      readonly title: string;
      readonly body: string;
    }) {
      const { assignment, revision } = input;
      yield* requireRevision(assignment, revision);
      // Guards every host write: the revision must still be current with the same candidate,
      // evidence, publication, source and workflow, screenshot publication must still be allowed
      // when there are screenshots, and no control or incident may block delivery.
      const requireLiveWrite = Effect.gen(function* () {
        const state = yield* store.snapshot;
        const current = state.assignments.find((entry) => entry.id === assignment.id);
        const currentRevision = current?.delivery?.revisions.find(
          (entry) => entry.id === current.delivery?.currentRevisionId,
        );
        if (
          !current ||
          current.status === "complete" ||
          current.outcome?.kind === "cancelled" ||
          current.projectId !== assignment.projectId ||
          current.threadId !== assignment.threadId ||
          currentRevision?.id !== revision.id ||
          currentRevision.operationId !== revision.operationId ||
          currentRevision.candidateId !== revision.candidateId ||
          currentRevision.candidateDigest !== revision.candidateDigest ||
          stableStringify(currentRevision.uxEvidence) !== stableStringify(revision.uxEvidence) ||
          (revision.uxEvidence !== undefined &&
            !state.previewPublicationPolicies.some(
              (entry) => entry.projectId === current.projectId && entry.enabled,
            )) ||
          stableStringify(currentRevision.publication) !== stableStringify(revision.publication) ||
          stableStringify(current.startingSource) !== stableStringify(assignment.startingSource) ||
          stableStringify(current.workflow) !== stableStringify(assignment.workflow)
        )
          return yield* new FactoryError({
            code: "invalid-state",
            detail: "The publication revision is no longer current.",
          });
        yield* requireRevision(current, revision);
        const blocked =
          factoryIncidentBlocked(state, assignment.id, "delivery") ??
          factoryExecutionBlocked(state, {
            assignmentId: current.id,
            managerId: current.managerId,
            projectId: current.projectId,
            threadId: current.threadId,
            ancestorThreadIds: [],
          });
        if (blocked) return yield* new FactoryError({ code: "permission-denied", detail: blocked });
      });
      const pinned = revision.publication;
      if (!pinned || !input.title.trim()) return yield* new FactoryError({ code: "invalid-state" });
      const artifact = yield* publication.read(pinned.reservationId);
      const reservation = artifact.reservation;
      const target = yield* requireCredential(reservation.destination);
      const hostRequest = (
        input: GitHubApi.GitHubRestInput,
        onAdmitted: Effect.Effect<void> = Effect.void,
      ) =>
        request(
          input,
          target.credentialFingerprint,
          input.method === "POST" || input.method === "PATCH" ? requireLiveWrite : undefined,
          onAdmitted,
        );
      if (
        reservation.id !== revision.id ||
        reservation.assignmentId !== assignment.id ||
        reservation.sourceId !== revision.startingSourceId ||
        reservation.boundaryId !== revision.boundaryId ||
        reservation.epoch !== revision.grantEpoch ||
        artifact.prepared.candidateId !== revision.candidateId ||
        artifact.prepared.publishedSourceDigest !== revision.candidateDigest ||
        artifact.prepared.commitOid !== pinned.headSha ||
        artifact.prepared.treeOid !== pinned.treeOid ||
        target.host !== pinned.host ||
        target.repositoryName !== pinned.repository ||
        reservation.branch !== pinned.branch ||
        reservation.baseBranch !== pinned.baseBranch
      )
        return yield* new FactoryError({
          code: "invalid-state",
          detail: "Publication does not match the exact captured delivery revision.",
        });
      // The hidden marker is how a later run recognizes this assignment's PR on the host.
      const marker = `<!-- satellite-factory:${yield* hash(`${assignment.projectId}:${assignment.id}`)} -->`;
      const screenshots = revision.uxEvidence
        ? yield* previews.publish({ assignmentId: assignment.id, revisionId: revision.id })
        : undefined;
      const screenshotMarkdown = screenshots
        ? `\n\nPreview screenshots\n\n${screenshots.urls.map((entry, index) => `![Screenshot ${index + 1}](${entry.imageUrl})\n\n[Open screenshot ${index + 1}](${entry.linkUrl})`).join("\n\n")}`
        : "";
      const body = `${input.body}${screenshotMarkdown}\n\n${marker}`;
      const directory = yield* directoryFor(revision.id);
      // A rerun must publish the same title and body; the recorded PR number is checked below.
      const recordPath = path.join(directory, "publish.json");
      let record: typeof PublishRecord.Type = { title: input.title, body };
      if (yield* fs.exists(recordPath)) {
        record = yield* fs.readFileString(recordPath).pipe(Effect.flatMap(decodePublish));
        if (record.title !== input.title || record.body !== body)
          return yield* new FactoryError({ code: "command-conflict" });
      } else yield* write(recordPath, yield* encodePublish(record));
      const pushed = yield* publication.push({
        reservationId: reservation.id,
        beforeWrite: requireLiveWrite.pipe(
          Effect.mapError(
            (cause) =>
              new FactoryPublication.FactoryPublicationError({ reason: "invalid-input", cause }),
          ),
        ),
      });
      if (pushed.status !== "confirmed")
        return yield* new FactoryError({
          code: "execution-unavailable",
          detail:
            pushed.status === "conflict"
              ? "The publication branch moved outside this reservation. No remote work was overwritten."
              : "The push outcome is unknown. Delivery remains unconfirmed until the reserved head is observed.",
        });
      // A PR is adopted only if it is open, carries the marker, and points from the reserved
      // branch at the pushed head to the reserved base in the same repository.
      const validate = (pr: typeof PullRequest.Type) => {
        if (
          pr.number <= 0 ||
          pr.state !== "open" ||
          pr.merged_at !== null ||
          !pr.body?.includes(marker) ||
          pr.head.ref !== reservation.branch ||
          pr.base.ref !== reservation.baseBranch ||
          pr.head.repo?.full_name.toLowerCase() !== target.repositoryName.toLowerCase() ||
          pr.base.repo.full_name.toLowerCase() !== target.repositoryName.toLowerCase() ||
          pr.head.sha !== pinned.headSha ||
          pr.html_url.toLowerCase() !==
            `https://${target.host}/${target.repositoryName}/pull/${pr.number}`.toLowerCase()
        )
          return Effect.fail(
            new FactoryError({
              code: "execution-unavailable",
              detail:
                "An existing pull request does not match the reserved repository, marker, base and exact head.",
            }),
          );
        return Effect.succeed(pr);
      };
      const find = Effect.fn(function* () {
        const response = yield* hostRequest({
          host: target.host,
          operation: "FactoryPublicationHost.reconcile",
          // Only an open PR is adopted. One the human closed stays closed, and the next revision
          // gets a fresh PR from the same branch.
          path: `${target.endpoint}/pulls?state=open&head=${encodeURIComponent(`${target.owner}:${reservation.branch}`)}&base=${encodeURIComponent(reservation.baseBranch)}&per_page=100`,
        });
        const matches = yield* decodePullRequests(response.body);
        if (matches.length > 1 || response.headers.link?.includes('rel="next"'))
          return yield* new FactoryError({
            code: "execution-unavailable",
            detail:
              "The reserved pull request identity is ambiguous. Reconcile it before publishing.",
          });
        return matches[0] === undefined ? undefined : yield* validate(matches[0]);
      });
      let observed = yield* find();
      if (record.ref && observed?.number !== record.ref.number)
        return yield* new FactoryError({
          code: "execution-unavailable",
          detail: "The previously recorded pull request identity could not be reconciled.",
        });
      if (!observed) {
        // Creating again after an unobserved create is safe: GitHub refuses a second open PR for
        // the same head and base, so a create that did land is found by the lookup below.
        let admitted = false;
        const created = yield* hostRequest(
          {
            host: target.host,
            operation: "FactoryPublicationHost.create",
            method: "POST",
            path: `${target.endpoint}/pulls`,
            body: {
              base: reservation.baseBranch,
              head: reservation.branch,
              title: input.title,
              body,
              maintainer_can_modify: false,
            },
          },
          Effect.sync(() => {
            admitted = true;
          }),
        ).pipe(
          Effect.flatMap((response) => decodePullRequest(response.body)),
          Effect.result,
        );
        // A create that failed before reaching the host is a plain failure. Once admitted, the
        // outcome is read back from the host whatever the response said.
        if (!admitted && Result.isFailure(created)) return yield* preserve(created.failure);
        observed = yield* find();
        if (!observed)
          return yield* new FactoryError({
            code: "execution-unavailable",
            detail:
              "The pull request creation result is not yet observable. Retrying looks it up again before creating.",
            ...(Result.isFailure(created) ? { cause: created.failure } : {}),
          });
      }
      // An update failure is ignored here; the verify read below decides.
      if (observed.title !== input.title || observed.body !== body) {
        yield* requireCredential(reservation.destination);
        yield* hostRequest({
          host: target.host,
          operation: "FactoryPublicationHost.update",
          method: "PATCH",
          path: `${target.endpoint}/pulls/${observed.number}`,
          body: { title: input.title, body },
        }).pipe(Effect.result);
      }
      const verified = yield* hostRequest({
        host: target.host,
        operation: "FactoryPublicationHost.verify",
        path: `${target.endpoint}/pulls/${observed.number}`,
      }).pipe(
        Effect.flatMap((response) => decodePullRequest(response.body)),
        Effect.flatMap(validate),
      );
      if (verified.title !== input.title || verified.body !== body)
        return yield* new FactoryError({
          code: "execution-unavailable",
          detail: "Pull request metadata has not reached the requested state.",
        });
      const ref = PullRequestRef.make({
        projectId: assignment.projectId,
        host: target.host,
        repository: target.repositoryName,
        number: verified.number,
      });
      record = { ...record, ref };
      yield* write(recordPath, yield* encodePublish(record));
      yield* requireLiveWrite;
      yield* threads.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make(`factory-publication:${revision.id}:${assignment.threadId}:link`),
        threadId: assignment.threadId,
        host: target.host,
        repository: target.repositoryName,
        number: verified.number,
        url: verified.html_url,
        source: "created",
      });
      if (screenshots) {
        yield* requireLiveWrite;
        yield* store.commit({
          actor: { kind: "system" },
          command: {
            type: "delivery.ux.published",
            commandId: CommandId.make(
              `factory-ux-published:${revision.id}:${screenshots.operationsDigest}`,
            ),
            assignmentId: assignment.id,
            revisionId: revision.id,
            evidence: {
              operationsDigest: screenshots.operationsDigest,
              commitOid: screenshots.commitOid,
              urls: screenshots.urls.map((entry) => entry.imageUrl),
            },
          },
          now: DateTime.formatIso(yield* DateTime.now),
        });
      }
      return ref;
    },
    mutex.withPermit,
    Effect.mapError(preserve),
  );
  return FactoryPublicationHost.of({ prepare, publish });
});

export const layer = Layer.effect(FactoryPublicationHost, make);
