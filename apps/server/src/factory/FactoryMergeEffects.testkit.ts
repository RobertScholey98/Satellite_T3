import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, FactorySnapshot, type PullRequestRef } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Satellite from "../orchestration-v2/testkit/SatelliteTestRuntime.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import type { ProviderMergeEvidence } from "../pullRequest/pullRequestMergeEvidence.ts";
import * as Store from "./FactoryStore.ts";
import { deliverySelection } from "./FactoryDelivery.testkit.ts";
import { makeFakeGitHub } from "./FactoryMergeSignal.testkit.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(FactorySnapshot));
export const mergeEffectsBase = Layer.mergeAll(
  Store.layer,
  Threads.layer,
  makeFakeGitHub().layer,
).pipe(Layer.provideMerge(Satellite.layer), Layer.provideMerge(NodeServices.layer));
export const seedMergeEffects = (state: FactorySnapshot) =>
  Effect.gen(function* () {
    yield* (yield* SqlClient.SqlClient)`INSERT INTO factory_state(id,revision,payload_json) VALUES(1,${state.revision},${encode(state)})`;
    const threads = yield* Threads.ThreadManagementService;
    for (const projectId of new Set(state.assignments.map((entry) => entry.projectId)))
      yield* Satellite.recordProject({
        projectId,
        title: projectId,
        workspaceRoot: `/fixture/${projectId}`,
      });
    for (const assignment of state.assignments)
      yield* threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${assignment.threadId}`),
        threadId: assignment.threadId,
        projectId: assignment.projectId,
        title: assignment.title ?? assignment.threadId,
        modelSelection: assignment.modelSelection ?? deliverySelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "system",
        creationSource: "server",
      });
  });
export const mergeHostEvidence = (
  state: FactorySnapshot,
  ref: PullRequestRef,
): ProviderMergeEvidence => {
  const owner = state.assignments.find(
    (entry) =>
      entry.projectId === ref.projectId &&
      entry.delivery?.revisions.some(
        (revision) => revision.publication?.ref?.number === ref.number,
      ),
  );
  const revision = owner?.delivery?.revisions.find(
    (entry) => entry.id === owner.delivery?.currentRevisionId,
  );
  if (!revision?.publication || !revision.hostEvidence)
    throw new Error("The fake host needs a published current member.");
  return {
    headSha: revision.publication.headSha,
    baseSha: revision.hostEvidence.baseSha,
    baseBranch: revision.publication.baseBranch,
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    mergeState: "CLEAN",
    reviewDecision: "approved",
    autoMergeEnabled: false,
    mergeQueueEnabled: false,
    checks: [
      {
        id: "checks",
        name: "Required checks",
        headSha: revision.publication.headSha,
        required: true,
        status: "success",
      },
    ],
    reviews: [],
    complete: true,
    issues: [],
  };
};
