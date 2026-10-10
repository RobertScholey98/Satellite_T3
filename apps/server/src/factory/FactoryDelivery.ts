import {
  FactoryError,
  MessageId,
  type FactoryAssignment,
  type FactoryAssignmentDelivery,
  type FactoryDecisionCommand,
  type FactoryDeliveryRevision,
  type FactoryEffectIntent,
  type FactoryProjectMergeRule,
  type FactorySnapshot,
  type ModelSelection,
  type ThreadId,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { factoryExecutionBlocked } from "./FactoryControls.ts";
import { factoryPathWithin, factoryRelativePath } from "./FactoryBoundaryPaths.ts";
import { constrainAssignmentPolicy, resolveManagerPolicy } from "./FactoryPolicy.ts";
import {
  constrainFactoryModelPolicy,
  isFactoryModelApproved,
  resolveFactoryModelPolicy,
} from "./FactoryModelPolicy.ts";
import type { FactoryActor, FactoryDecision } from "./FactoryState.ts";

export interface FactoryDeliveryContext {
  readonly deliveryReviewAllocation?: {
    readonly threadId: ThreadId;
    readonly modelSelection: ModelSelection;
  };
}

export const initialFactoryDelivery = (): FactoryAssignmentDelivery => ({
  revisions: [],
  directionHeld: false,
  readiness: [],
  retroFindings: [],
});

export const currentFactoryDeliveryRevision = (assignment: FactoryAssignment) =>
  assignment.delivery?.revisions.find(
    (entry) => entry.id === assignment.delivery?.currentRevisionId,
  );

export function factoryDeliveryWaitReason(assignment: FactoryAssignment): string | undefined {
  const delivery = assignment.delivery;
  const revision = currentFactoryDeliveryRevision(assignment);
  if (delivery?.flow && delivery.flow.status !== "released")
    return "Implementation is held for the concrete UI flow decision.";
  if (
    revision?.reviews.some((review) => review.status === "pending" || review.status === "running")
  )
    return "The independent team review is in progress.";
  if (revision?.merge?.status === "requested" || revision?.merge?.status === "unknown")
    return "The host is reconciling the requested merge.";
  if (
    delivery?.directionHeld &&
    !revision?.approval &&
    delivery.readiness.length === 1 &&
    delivery.readiness[0]?.startsWith("Human approval")
  )
    return "The human is reviewing the verified revision with its implementation lead.";
}

export const currentFactoryMergeRule = (state: FactorySnapshot, assignment: FactoryAssignment) =>
  state.mergeRules
    .filter((entry) => entry.projectId === assignment.projectId)
    .sort((a, b) => b.version - a.version)[0];

const matchesRule = (
  rule: FactoryProjectMergeRule | undefined,
  assignment: FactoryAssignment,
  revision: FactoryDeliveryRevision,
) =>
  rule?.enabled === true &&
  rule.kinds.some((kind) => kind === assignment.kind) &&
  revision.selectedPaths.length > 0 &&
  revision.selectedPaths.every(
    (path) =>
      rule.allowedPaths.some((allowed) => path === allowed || factoryPathWithin(path, allowed)) &&
      !rule.excludedPaths.some(
        (excluded) => path === excluded || factoryPathWithin(path, excluded),
      ),
  ) &&
  (assignment.delivery?.impact?.classification === "none" ||
    (assignment.delivery?.impact?.classification === "established-pattern" &&
      rule.allowEstablishedPatterns));

export function factoryDeliveryReadiness(
  state: FactorySnapshot,
  assignment: FactoryAssignment,
  revision: FactoryDeliveryRevision,
) {
  const reasons: string[] = [];
  const manager = state.managers.find((entry) => entry.id === assignment.managerId);
  const grant = assignment.grant;
  if (!manager || !grant || assignment.outcome !== undefined || assignment.status === "complete")
    reasons.push("The assignment no longer has active delivery authority.");
  if (
    grant?.epoch !== revision.grantEpoch ||
    grant.boundaryId !== revision.boundaryId ||
    assignment.workflow.revision !== revision.workflowRevision ||
    assignment.startingSource?.id !== revision.startingSourceId
  )
    reasons.push(
      "The candidate was prepared under a different source, boundary, workflow, or grant.",
    );
  const blocked = factoryExecutionBlocked(state, {
    threadId: assignment.threadId,
    managerId: assignment.managerId,
    projectId: assignment.projectId,
    assignmentId: assignment.id,
    ancestorThreadIds: [],
  });
  if (blocked) reasons.push(blocked);
  if (assignment.wait && assignment.wait.kind !== "review")
    reasons.push(`The assignment is waiting on ${assignment.wait.kind} before delivery.`);
  const delivery = assignment.delivery;
  const impact = delivery?.impact;
  if (!impact)
    reasons.push("Declare the journey, navigation, layout, and shared-component impact.");
  if (
    impact?.changedFlows &&
    (delivery?.flow?.status !== "released" ||
      delivery.flow.decision?.approved !== true ||
      delivery.flow.decision.artifactDigest !== delivery.flow.artifactDigest)
  )
    reasons.push("The concrete UI flow needs human approval before implementation continues.");
  if (delivery?.flow && delivery.flow.status !== "released")
    reasons.push("Implementation is held for a flow decision.");
  if (!revision.candidateDigest || !revision.publication?.ref || revision.status !== "published")
    reasons.push("Publish the exact candidate and link its pull request.");
  if (
    !revision.verification?.passed ||
    revision.verification.sourceDigest !== revision.candidateDigest
  )
    reasons.push("The immutable candidate must pass its protected verification gates.");
  const latestReview = revision.reviews.at(-1);
  if (
    latestReview?.status !== "passed" ||
    latestReview.confirmsImpact !== true ||
    latestReview.candidateDigest !== revision.candidateDigest
  )
    reasons.push(
      "An independent team reviewer must approve this candidate and its impact assessment.",
    );
  if (latestReview?.status === "changes-requested")
    reasons.push("Resolve the team's requested changes and obtain a fresh review.");
  if (impact && ["substantial-ui", "major-ui"].includes(impact.classification)) {
    const ux = revision.uxEvidence;
    if (
      !ux ||
      ux.candidateDigest !== revision.candidateDigest ||
      ux.screenshots.length === 0 ||
      ux.journeys.length === 0 ||
      !revision.reviews.some(
        (review) => review.threadId === ux.reviewThreadId && review.status === "passed",
      )
    )
      reasons.push(
        "An independent reviewer must exercise this candidate in the actual app and record journey evidence and screenshots.",
      );
    if (
      !revision.publishedUxEvidence ||
      revision.publishedUxEvidence.operationsDigest !== ux?.operationsDigest
    )
      reasons.push(
        "Publish the verified screenshots with this pull request under the project's screenshot-publication permission.",
      );
  }
  const evidence = revision.hostEvidence;
  if (
    !evidence ||
    evidence.headSha !== revision.publication?.headSha ||
    !evidence.complete ||
    evidence.checks !== "passed" ||
    evidence.reviews !== "passed" ||
    !evidence.mergeable ||
    !evidence.conditionalMerge
  )
    reasons.push(
      ...(evidence?.reasons.length
        ? evidence.reasons
        : ["Fresh, revision-bound hosting checks and review requirements must pass."]),
    );
  if (!revision.bundleDigest)
    reasons.push("The host has not sealed this revision's evidence bundle.");
  const rule = currentFactoryMergeRule(state, assignment);
  const policy = manager
    ? constrainAssignmentPolicy(
        assignment.grantedPolicy,
        resolveManagerPolicy(state.defaults, manager.overrides),
      )
    : undefined;
  const ruleEligible =
    policy?.delivery === "project-rule" && matchesRule(rule, assignment, revision);
  const approval = revision.approval;
  const humanApproved =
    approval?.authority === "human" &&
    approval.expectedHeadSha === revision.publication?.headSha &&
    approval.bundleDigest === revision.bundleDigest;
  const needsHuman =
    !ruleEligible || impact?.classification === "major-ui" || impact?.classification === "unclear";
  return {
    reasons: [...new Set(reasons)],
    needsHuman,
    humanApproved,
    ruleEligible,
    ruleVersion: rule?.version ?? null,
  };
}

export function decideFactoryDelivery(
  input: FactoryDeliveryContext & {
    readonly state: FactorySnapshot;
    readonly actor: FactoryActor;
    readonly command: FactoryDecisionCommand;
    readonly now: string;
  },
): Result.Result<FactoryDecision, FactoryError> | undefined {
  const { state, actor, command, now } = input;
  if (!command.type.startsWith("delivery.")) return undefined;
  const fail = (detail: string, code: FactoryError["code"] = "invalid-state") =>
    Result.fail(new FactoryError({ code, detail }));
  const accept = (
    patch: Partial<FactorySnapshot>,
    effects: ReadonlyArray<FactoryEffectIntent> = [],
    revisionId?: string,
  ): Result.Result<FactoryDecision, FactoryError> => {
    const revision = state.revision + 1;
    return Result.succeed({
      state: { ...state, ...patch, revision },
      effects,
      result: {
        revision,
        ...("assignmentId" in command ? { assignmentId: command.assignmentId } : {}),
        ...(revisionId ? { deliveryRevisionId: revisionId } : {}),
      },
    });
  };
  if (command.type === "delivery.preview.configure") {
    if (actor.kind !== "human")
      return fail(
        "Only the human can approve a project's app preview runtime.",
        "permission-denied",
      );
    const config = command.configuration;
    if (
      !state.managers.some((entry) => entry.projectId === command.projectId) ||
      !/^sha256:[a-f0-9]{64}$/.test(config.imageId) ||
      config.port < 1024 ||
      config.port > 65535 ||
      !config.args[0]?.startsWith("/workspace/") ||
      !factoryRelativePath(config.args[0].slice("/workspace/".length)) ||
      config.args.length > 32 ||
      config.args.some((arg) => arg.length > 4096 || arg.includes("\0"))
    )
      return fail("Approve a pinned image, a repository Node entry point, and a valid app port.");
    return accept({
      previewConfigurations: [
        ...state.previewConfigurations,
        {
          id: `preview-config:${command.commandId}`,
          projectId: command.projectId,
          configuration: config,
          approvedAt: now,
          authorizingCommandId: command.commandId,
        },
      ],
    });
  }
  if (command.type === "delivery.preview.publication.configure") {
    if (actor.kind !== "human")
      return fail(
        "Only the human can authorize publishing project screenshots.",
        "permission-denied",
      );
    if (!state.managers.some((entry) => entry.projectId === command.projectId))
      return fail("This project has no engineering manager.");
    return accept({
      previewPublicationPolicies: [
        ...state.previewPublicationPolicies.filter(
          (entry) => entry.projectId !== command.projectId,
        ),
        {
          projectId: command.projectId,
          enabled: command.enabled,
          approvedAt: now,
          authorizingCommandId: command.commandId,
        },
      ],
    });
  }
  if (command.type === "delivery.rules.configure") {
    if (actor.kind !== "human")
      return fail("Only the human can adopt a project merge rule.", "permission-denied");
    if (!state.managers.some((entry) => entry.projectId === command.projectId))
      return fail("This project has no engineering manager.");
    if (
      [...command.allowedPaths, ...command.excludedPaths].some((path) => !factoryRelativePath(path))
    )
      return fail("Merge rules need normalized repository-relative paths.");
    const previous = state.mergeRules.filter((entry) => entry.projectId === command.projectId);
    return accept({
      mergeRules: [
        ...state.mergeRules,
        {
          projectId: command.projectId,
          version: Math.max(0, ...previous.map((entry) => entry.version)) + 1,
          enabled: command.enabled,
          kinds: command.kinds,
          allowedPaths: command.allowedPaths,
          excludedPaths: command.excludedPaths,
          allowEstablishedPatterns: command.allowEstablishedPatterns,
          approvedAt: now,
          authorizingCommandId: command.commandId,
        },
      ],
    });
  }
  if (!("assignmentId" in command)) return fail("Delivery command has no assignment.");
  const assignment = state.assignments.find((entry) => entry.id === command.assignmentId);
  if (!assignment || assignment.kind === "onboarding")
    return fail("Implementation assignment not found.", "assignment-not-found");
  const delivery = assignment.delivery ?? initialFactoryDelivery();
  const save = (
    next: FactoryAssignmentDelivery,
    effects: ReadonlyArray<FactoryEffectIntent> = [],
    extra: Partial<FactorySnapshot> = {},
    assignmentChanges: Partial<FactoryAssignment> = {},
  ) =>
    accept(
      {
        ...extra,
        assignments: state.assignments.map((entry) =>
          entry.id === assignment.id
            ? { ...assignment, ...assignmentChanges, delivery: next, updatedAt: now }
            : entry,
        ),
      },
      effects,
      next.currentRevisionId,
    );
  const lead =
    actor.kind === "human" || (actor.kind === "thread" && actor.threadId === assignment.threadId);
  const host = actor.kind === "system";
  const active = assignment.outcome === undefined && assignment.status !== "complete";
  const effectFields = { assignmentId: assignment.id };
  const notice = (
    text: string,
    purpose: NonNullable<Extract<FactoryEffectIntent, { type: "thread.deliver" }>["purpose"]>,
  ): FactoryEffectIntent => ({
    type: "thread.deliver",
    threadId: assignment.threadId,
    sourceThreadId: assignment.threadId,
    messageId: MessageId.make(`factory-delivery:${command.commandId}`),
    kind: "continuation",
    purpose,
    text,
  });
  const revision =
    "revisionId" in command
      ? delivery.revisions.find((entry) => entry.id === command.revisionId)
      : undefined;
  const updateRevision = (
    next: FactoryDeliveryRevision,
    effects: ReadonlyArray<FactoryEffectIntent> = [],
    changes: Partial<FactoryAssignmentDelivery> = {},
    extra: Partial<FactorySnapshot> = {},
    assignmentChanges: Partial<FactoryAssignment> = {},
  ) =>
    save(
      {
        ...delivery,
        ...changes,
        revisions: delivery.revisions.map((entry) => (entry.id === next.id ? next : entry)),
      },
      effects,
      extra,
      assignmentChanges,
    );
  const ownsFlowWait =
    assignment.wait?.kind === "flow-review" &&
    assignment.wait.holdId === delivery.flow?.holdId &&
    assignment.wait.artifactId === (delivery.flow.pendingArtifactId ?? delivery.flow.artifactId);
  if (command.type === "delivery.impact.declare") {
    if (!lead || !active)
      return fail("Only the active implementation lead can declare impact.", "permission-denied");
    if (command.impact.evidence.length === 0) return fail("Impact needs concrete evidence.");
    if (stableStringify(delivery.impact) === stableStringify(command.impact)) return save(delivery);
    if (delivery.flow?.status === "releasing")
      return fail("Wait for the accepted flow release before changing its impact.");
    const activeFlow =
      delivery.flow && delivery.flow.status !== "released" ? delivery.flow : undefined;
    const hold = command.impact.changedFlows || activeFlow !== undefined;
    const retainedFlow =
      activeFlow === undefined
        ? undefined
        : {
            holdId: activeFlow.holdId,
            status: activeFlow.status,
            ...(activeFlow.qualification ? { qualification: activeFlow.qualification } : {}),
            ...(activeFlow.sourceDigest ? { sourceDigest: activeFlow.sourceDigest } : {}),
          };
    return save(
      {
        ...delivery,
        impact: command.impact,
        revisions: delivery.revisions.map(
          ({ approval: _approval, bundleDigest: _bundle, ...entry }) => ({ ...entry, reviews: [] }),
        ),
        ...(hold
          ? {
              flow: retainedFlow ?? {
                holdId: `flow:${command.commandId}`,
                status: "stopping" as const,
              },
            }
          : {}),
        readiness: hold ? ["Approve a concrete UI flow before implementation continues."] : [],
      },
      hold && !activeFlow
        ? [
            {
              type: "delivery.flow.hold",
              ...effectFields,
              holdId: `flow:${command.commandId}`,
              held: true,
            },
          ]
        : [],
      {},
      ownsFlowWait ? { wait: null, status: "running" } : {},
    );
  }
  if (command.type === "delivery.flow.failed") {
    if (!host || delivery.flow?.holdId !== command.holdId) return fail("The flow hold changed.");
    return save({
      ...delivery,
      flow: { ...delivery.flow, error: command.reason },
      readiness: [command.reason],
    });
  }
  if (command.type === "delivery.flow.retry") {
    if (!lead || !active || !delivery.flow)
      return fail("Only the active lead can retry this flow operation.", "permission-denied");
    const { error: _error, ...flow } = delivery.flow;
    return save({ ...delivery, flow, readiness: [] });
  }
  if (command.type === "delivery.flow.recorded") {
    if (!host || delivery.flow?.holdId !== command.holdId)
      return fail("This flow receipt is not current.");
    if (command.held ? delivery.flow.status !== "stopping" : delivery.flow.status !== "releasing")
      return fail("The flow hold changed while execution was being reconciled.");
    return save(
      {
        ...delivery,
        flow: {
          ...delivery.flow,
          status: command.held ? "held" : "released",
          ...(command.qualification ? { qualification: command.qualification } : {}),
          ...(command.sourceDigest ? { sourceDigest: command.sourceDigest } : {}),
        },
      },
      [
        notice(
          command.held
            ? "Implementation is stopped. Continue in the read-only planning context and submit a concrete flow document with delivery.flow.submit; wait for the human's artifact-bound decision."
            : "The human approved the concrete flow and the implementation hold was released. Resume the authorized work under the existing grant.",
          { kind: "delivery-flow", holdId: command.holdId },
        ),
      ],
      {},
      !command.held && ownsFlowWait ? { wait: null, status: "running" } : {},
    );
  }
  if (command.type === "delivery.flow.submit") {
    if (!lead || !active || delivery.flow?.status !== "held")
      return fail("Submit the concrete flow while implementation is held.");
    if (command.content.length > 200_000)
      return fail("Keep the concrete flow document below 200,000 characters.");
    const { decision: _decision, ...flow } = delivery.flow;
    return save(
      {
        ...delivery,
        flow: { ...flow, pendingArtifactId: `flow-artifact:${command.commandId}` },
      },
      [
        {
          type: "delivery.flow.capture",
          ...effectFields,
          holdId: delivery.flow.holdId,
          artifactId: `flow-artifact:${command.commandId}`,
          title: command.title,
          content: command.content,
          format: command.format,
        },
      ],
      {},
      assignment.wait === null || ownsFlowWait
        ? {
            status: "waiting",
            wait: {
              kind: "flow-review",
              holdId: delivery.flow.holdId,
              artifactId: `flow-artifact:${command.commandId}`,
              reason: "Waiting for the human's decision on the concrete UI flow.",
            },
          }
        : {},
    );
  }
  if (command.type === "delivery.flow.artifact") {
    if (
      !host ||
      delivery.flow?.holdId !== command.holdId ||
      delivery.flow.status !== "held" ||
      delivery.flow.pendingArtifactId !== command.artifactId
    )
      return fail("The flow artifact is no longer current.");
    const { pendingArtifactId: _pendingArtifactId, decision: _decision, ...flow } = delivery.flow;
    return save({
      ...delivery,
      flow: {
        ...flow,
        holdId: command.holdId,
        status: "held",
        artifactId: command.artifactId,
        artifactDigest: command.artifactDigest,
        ...(command.artifact ? { artifact: command.artifact } : {}),
      },
    });
  }
  if (command.type === "delivery.flow.decide") {
    if (actor.kind !== "human")
      return fail("Only the human can approve a UI flow.", "permission-denied");
    if (
      !active ||
      delivery.flow?.status !== "held" ||
      delivery.flow.pendingArtifactId !== undefined ||
      delivery.flow.artifactDigest !== command.artifactDigest
    )
      return fail("Review the current concrete flow artifact.");
    return save(
      {
        ...delivery,
        flow: {
          ...delivery.flow,
          status: command.approved ? "releasing" : "held",
          decision: {
            artifactDigest: command.artifactDigest,
            approved: command.approved,
            commandId: command.commandId,
          },
        },
      },
      command.approved
        ? [
            {
              type: "delivery.flow.hold",
              ...effectFields,
              holdId: delivery.flow.holdId,
              held: false,
            },
          ]
        : [
            notice(
              "The human requested changes to the concrete flow. Revise and resubmit it in the read-only planning context; implementation remains held.",
              { kind: "delivery-flow", holdId: delivery.flow.holdId },
            ),
          ],
      {},
      !command.approved && ownsFlowWait ? { wait: null, status: "running" } : {},
    );
  }
  if (command.type === "delivery.review.handback") {
    if (actor.kind !== "human")
      return fail("Only the human can hand the review back.", "permission-denied");
    return save({ ...delivery, directionHeld: false });
  }
  if (command.type === "delivery.capture") {
    if (!lead || !active || !assignment.grant || !assignment.startingSource)
      return fail("The active lead needs a prepared source and grant.", "permission-denied");
    if (assignment.grant.epoch !== command.expectedEpoch)
      return fail("The assignment grant changed.");
    if (!delivery.impact) return fail("Declare UI impact before preparing a delivery candidate.");
    if (
      delivery.revisions.some(
        (entry) =>
          entry.merge?.status === "requested" ||
          entry.merge?.status === "unknown" ||
          entry.status === "publishing",
      )
    )
      return fail("Reconcile the previous publication or merge before changing its revision.");
    if (
      command.selectedPaths.length === 0 ||
      new Set(command.selectedPaths).size !== command.selectedPaths.length ||
      command.selectedPaths.some((path) => !factoryRelativePath(path))
    )
      return fail("Select distinct normalized repository-relative paths.");
    const id = `revision:${command.commandId}`;
    const next: FactoryDeliveryRevision = {
      id,
      operationId: command.commandId,
      selectedPaths: command.selectedPaths,
      commitMessage: command.commitMessage,
      grantEpoch: assignment.grant.epoch,
      boundaryId: assignment.grant.boundaryId,
      workflowRevision: assignment.workflow.revision,
      startingSourceId: assignment.startingSource.id,
      status: "capturing",
      reviews: [],
      createdAt: now,
    };
    return save(
      {
        ...delivery,
        currentRevisionId: id,
        revisions: [...delivery.revisions, next],
        readiness: ["Preparing an immutable candidate."],
      },
      [{ type: "delivery.capture", ...effectFields, revisionId: id }],
    );
  }
  if (!revision) return fail("Delivery revision not found.");
  const isCurrent = delivery.currentRevisionId === revision.id;
  const revisionEffect = { ...effectFields, revisionId: revision.id };
  switch (command.type) {
    case "delivery.preview.start": {
      const review = revision.reviews.find((entry) => entry.id === command.reviewId);
      if (
        !active ||
        !isCurrent ||
        !revision.candidateId ||
        !review ||
        (actor.kind !== "human" &&
          !(actor.kind === "thread" && actor.threadId === review.threadId)) ||
        (review.status !== "pending" && review.status !== "running")
      )
        return fail(
          "Only this candidate's current independent reviewer can start its actual-app verification.",
          "permission-denied",
        );
      if (
        !state.previewConfigurations.some(
          (entry) =>
            entry.id === command.configurationId && entry.projectId === assignment.projectId,
        )
      )
        return fail("This project needs a human-approved app preview configuration.");
      if (revision.preview && ["starting", "ready", "stopping"].includes(revision.preview.status))
        return fail("Stop the current candidate preview before starting another.");
      const instanceId = `preview:${command.commandId}`;
      return updateRevision(
        {
          ...revision,
          preview: {
            instanceId,
            configurationId: command.configurationId,
            reviewId: review.id,
            threadId: review.threadId,
            status: "starting",
          },
        },
        [{ type: "delivery.preview.start", ...revisionEffect, instanceId }],
      );
    }
    case "delivery.preview.stop":
      if (
        !revision.preview ||
        revision.preview.instanceId !== command.instanceId ||
        (actor.kind !== "human" &&
          !(actor.kind === "thread" && actor.threadId === revision.preview.threadId))
      )
        return fail("Only this preview's reviewer or the human can stop it.", "permission-denied");
      return updateRevision({ ...revision, preview: { ...revision.preview, status: "stopping" } }, [
        { type: "delivery.preview.stop", ...revisionEffect, instanceId: command.instanceId },
      ]);
    case "delivery.preview.recorded":
      if (!host || revision.preview?.instanceId !== command.instanceId)
        return fail("This preview receipt is not current.");
      if (
        command.status === "ready" &&
        (!active ||
          !isCurrent ||
          !["starting", "ready"].includes(revision.preview.status) ||
          assignment.grant?.epoch !== revision.grantEpoch ||
          (delivery.flow && delivery.flow.status !== "released") ||
          !revision.reviews.some(
            (review) =>
              review.id === revision.preview?.reviewId &&
              ["pending", "running"].includes(review.status),
          ) ||
          factoryExecutionBlocked(state, {
            threadId: revision.preview.threadId,
            assignmentId: assignment.id,
            managerId: assignment.managerId,
            projectId: assignment.projectId,
            ancestorThreadIds: [],
          }))
      )
        return fail(
          "The preview was stopped or its authority changed before startup completed.",
          "stale-revision",
        );
      return updateRevision(
        {
          ...revision,
          preview: {
            ...revision.preview,
            status: command.status,
            ...(command.origin ? { origin: command.origin } : {}),
            ...(command.error ? { error: command.error } : {}),
          },
        },
        command.status === "ready" || command.status === "failed"
          ? [
              {
                type: "thread.deliver",
                threadId: revision.preview.threadId,
                sourceThreadId: assignment.threadId,
                purpose: {
                  kind: "delivery-review",
                  revisionId: revision.id,
                  reviewId: revision.preview.reviewId,
                  instanceId: revision.preview.instanceId,
                },
                messageId: MessageId.make(`factory-preview:${command.commandId}`),
                kind: "continuation",
                text:
                  command.status === "ready"
                    ? `Candidate app instance ${command.instanceId} is ready. Exercise relevant journeys with factory_preview_action and factory_preview_snapshot, seal evidence with factory_preview_finish, then report the independent review.`
                    : `The candidate app could not start: ${command.error ?? "Inspect the approved runtime requirements."} Record the limitation; do not claim UX verification passed.`,
              },
            ]
          : [],
      );
    case "delivery.captured":
      if (
        !host ||
        revision.status !== "capturing" ||
        command.verification.sourceDigest !== command.candidateDigest
      )
        return fail("Candidate capture receipt does not match its reservation.");
      return updateRevision(
        {
          ...revision,
          candidateId: command.candidateId,
          candidateDigest: command.candidateDigest,
          publication: command.publication,
          verification: command.verification,
          status: "captured",
        },
        [
          notice(
            `Delivery candidate ${revision.id} is frozen. Protected checks ${command.verification.passed ? "passed" : "failed"}. Request independent review with delivery.review.request; fix failed checks by preparing a new candidate.`,
            { kind: "delivery", revisionId: revision.id },
          ),
        ],
      );
    case "delivery.publish":
      if (!lead || !active || !isCurrent)
        return fail("Only the active lead can publish the current candidate.", "permission-denied");
      if (revision.status !== "captured" || !revision.publication)
        return fail("Prepare the candidate before publication.");
      if (
        delivery.impact &&
        ["substantial-ui", "major-ui"].includes(delivery.impact.classification) &&
        (!revision.uxEvidence ||
          revision.uxEvidence.candidateDigest !== revision.candidateDigest ||
          revision.uxEvidence.screenshots.length === 0 ||
          revision.uxEvidence.journeys.length === 0)
      )
        return fail(
          "The independent reviewer must record actual app journeys and screenshots before this UI pull request is published.",
        );
      if (
        !revision.verification?.passed ||
        revision.verification.sourceDigest !== revision.candidateDigest ||
        revision.reviews.at(-1)?.status !== "passed" ||
        revision.reviews.at(-1)?.confirmsImpact !== true
      )
        return fail(
          "Complete protected verification and independent team review before publishing the pull request.",
        );
      return updateRevision({ ...revision, status: "publishing" }, [
        { type: "delivery.publish", ...revisionEffect, title: command.title, body: command.body },
      ]);
    case "delivery.published":
      if (
        !host ||
        revision.status !== "publishing" ||
        !revision.publication ||
        command.ref.projectId !== assignment.projectId ||
        (command.ref.host ?? "github.com") !== revision.publication.host ||
        command.ref.repository.toLowerCase() !== revision.publication.repository.toLowerCase()
      )
        return fail("The published pull request does not match its reserved destination.");
      return updateRevision(
        {
          ...revision,
          status: "published",
          publication: { ...revision.publication, ref: command.ref },
        },
        [
          notice(
            `The exact candidate was published and linked as pull request #${command.ref.number}. Use delivery.ready after required hosting checks to prepare the revision for its merge decision.`,
            { kind: "delivery", revisionId: revision.id },
          ),
        ],
        {},
        {},
        {
          oversight: {
            ...(assignment.oversight ?? { recovery: { cyclesUsed: 0, history: [] } }),
            deliveryClaim: { kind: "pull-request", ref: command.ref },
          },
        },
      );
    case "delivery.review.request": {
      if (!lead || !active || !isCurrent || !revision.candidateDigest)
        return fail(
          "Only the active lead can request review of a captured candidate.",
          "permission-denied",
        );
      if (
        revision.reviews.some((entry) => entry.status === "pending" || entry.status === "running")
      )
        return fail("An independent review is already in progress.");
      const allocation = input.deliveryReviewAllocation;
      const manager = state.managers.find((entry) => entry.id === assignment.managerId);
      if (
        !allocation ||
        !manager ||
        !assignment.modelPolicy ||
        allocation.threadId === assignment.threadId ||
        !isFactoryModelApproved(
          constrainFactoryModelPolicy(
            assignment.modelPolicy,
            resolveFactoryModelPolicy(
              state.modelDefaults,
              manager.modelOverrides,
              manager.modelSelection,
            ),
          ),
          allocation.modelSelection,
        )
      )
        return fail("A reviewer from the current approved model pool is required.");
      const reviewId = `review:${command.commandId}`;
      return updateRevision(
        {
          ...revision,
          reviews: [
            ...revision.reviews,
            {
              id: reviewId,
              threadId: allocation.threadId,
              candidateDigest: revision.candidateDigest,
              status: "pending",
              evidence: [],
            },
          ],
        },
        [
          {
            type: "delivery.review.launch",
            ...revisionEffect,
            reviewId,
            threadId: allocation.threadId,
          },
        ],
        {},
        {
          auxiliaryThreads: [
            ...state.auxiliaryThreads,
            {
              threadId: allocation.threadId,
              assignmentId: assignment.id,
              managerId: assignment.managerId,
              projectId: assignment.projectId,
              kind: "delivery-review",
              incidentId: reviewId,
              revisionId: revision.id,
              cycle: 0,
              status: "pending",
              modelSelection: allocation.modelSelection,
              sourceDigest: revision.candidateDigest,
              createdAt: now,
              updatedAt: now,
            },
          ],
        },
      );
    }
    case "delivery.review.prepared":
    case "delivery.review.started": {
      if (!host) return fail("Only the host can record review launch.", "permission-denied");
      const review = revision.reviews.find((entry) => entry.id === command.reviewId);
      if (!review || !isCurrent) return fail("This review was superseded.");
      return updateRevision(
        {
          ...revision,
          reviews: revision.reviews.map((entry) =>
            command.type === "delivery.review.started" &&
            entry.id === review.id &&
            entry.status === "pending"
              ? { ...entry, status: "running" }
              : entry,
          ),
        },
        command.type === "delivery.review.started"
          ? [
              {
                type: "auxiliary.reconcile",
                threadId: review.threadId,
                triggerId: `review-started:${command.commandId}`,
              },
            ]
          : [],
        {},
        {
          auxiliaryThreads: state.auxiliaryThreads.map((entry) =>
            entry.threadId === review.threadId
              ? {
                  ...entry,
                  status:
                    command.type === "delivery.review.started" && entry.status === "pending"
                      ? "running"
                      : entry.status,
                  qualification: {
                    status: "qualified",
                    profileId: command.profileId,
                    checkedAt: now,
                  },
                  updatedAt: now,
                }
              : entry,
          ),
        },
      );
    }
    case "delivery.review.report": {
      const review = revision.reviews.find((entry) => entry.id === command.reviewId);
      const worker = state.auxiliaryThreads.find((entry) => entry.threadId === review?.threadId);
      if (
        actor.kind !== "thread" ||
        review?.threadId !== actor.threadId ||
        worker?.qualification === undefined ||
        !isCurrent ||
        !active ||
        !["pending", "running"].includes(review.status)
      )
        return fail(
          "Only this candidate's independent reviewer can report its findings.",
          "permission-denied",
        );
      if (command.evidence.length === 0) return fail("Review findings need concrete evidence.");
      const { approval: _approval, bundleDigest: _bundle, ...rest } = revision;
      return updateRevision(
        {
          ...rest,
          reviews: revision.reviews.map((entry) =>
            entry.id === review.id
              ? {
                  ...entry,
                  status: command.verdict,
                  confirmsImpact: command.confirmsImpact,
                  findings: command.findings,
                  evidence: command.evidence,
                }
              : entry,
          ),
        },
        [
          notice(
            `Independent team review ${command.verdict}: ${command.findings}. Read the recorded evidence and continue the PR workflow within your grant.`,
            { kind: "delivery", revisionId: revision.id },
          ),
        ],
        {},
        {
          auxiliaryThreads: state.auxiliaryThreads.map((entry) =>
            entry.threadId === review.threadId
              ? {
                  ...entry,
                  status: "complete",
                  findings: { summary: command.findings, evidence: command.evidence },
                  updatedAt: now,
                }
              : entry,
          ),
        },
      );
    }
    case "delivery.ready":
      if (!lead || !active || !isCurrent || revision.status !== "published")
        return fail("Reconcile the current published revision.");
      return updateRevision(revision, [{ type: "delivery.inspect", ...revisionEffect }]);
    case "delivery.inspected": {
      if (!host || !isCurrent || !revision.publication)
        return fail("Inspection is not for the current publication.");
      if (command.expectedStateRevision !== state.revision)
        return fail(
          "The evidence changed while the host sealed its bundle. Reconcile again.",
          "stale-revision",
        );
      const { approval: oldApproval, ...rest } = revision;
      const next = {
        ...rest,
        hostEvidence: command.evidence,
        bundleDigest: command.bundleDigest,
        ...(oldApproval?.bundleDigest === command.bundleDigest &&
        oldApproval.expectedHeadSha === command.evidence.headSha
          ? { approval: oldApproval }
          : {}),
      };
      const readiness = factoryDeliveryReadiness(state, assignment, next);
      const reasons = readiness.reasons.length
        ? readiness.reasons
        : readiness.needsHuman && !readiness.humanApproved
          ? ["Human approval is required for this exact revision."]
          : [];
      const changed =
        revision.bundleDigest !== next.bundleDigest ||
        stableStringify(delivery.readiness) !== stableStringify(reasons) ||
        stableStringify(oldApproval) !== stableStringify(next.approval);
      const ambiguity =
        delivery.impact?.classification === "unclear"
          ? "Merge-rule eligibility was unclear; the verified revision was routed to the human."
          : undefined;
      return updateRevision(
        next,
        changed
          ? [
              notice(
                readiness.reasons.length
                  ? `Delivery is not ready: ${readiness.reasons.join(" ")} Resolve the cause and use delivery.ready to reconcile fresh evidence.`
                  : readiness.needsHuman && !readiness.humanApproved
                    ? "The verified revision is ready for human review. Wait for the human's exact-revision decision; they can give feedback directly in this thread."
                    : "The exact revision is ready under its current delivery authority. Use delivery.merge to request the host's conditional merge.",
                { kind: "delivery", revisionId: revision.id },
              ),
            ]
          : [],
        {
          readiness: reasons,
          directionHeld:
            delivery.directionHeld || (readiness.reasons.length === 0 && readiness.needsHuman),
          retroFindings: ambiguity
            ? [...new Set([...delivery.retroFindings, ambiguity])]
            : delivery.retroFindings,
        },
      );
    }
    case "delivery.ux.recorded": {
      if (
        !host ||
        !active ||
        !isCurrent ||
        command.evidence.candidateDigest !== revision.candidateDigest ||
        revision.preview?.instanceId !== command.evidence.instanceId ||
        !revision.reviews.some(
          (entry) =>
            entry.threadId === command.evidence.reviewThreadId &&
            ["pending", "running"].includes(entry.status),
        )
      )
        return fail("UX evidence belongs to a different candidate or reviewer.");
      const {
        approval: _approval,
        bundleDigest: _bundle,
        publishedUxEvidence: _published,
        ...rest
      } = revision;
      return updateRevision({ ...rest, uxEvidence: command.evidence });
    }
    case "delivery.ux.published": {
      if (
        !host ||
        !isCurrent ||
        revision.uxEvidence?.operationsDigest !== command.evidence.operationsDigest ||
        command.evidence.urls.length !== revision.uxEvidence.screenshots.length ||
        command.evidence.urls.length === 0
      )
        return fail("Published screenshots do not match the sealed candidate evidence.");
      const { approval: _approval, bundleDigest: _bundle, ...rest } = revision;
      return updateRevision({ ...rest, publishedUxEvidence: command.evidence });
    }
    case "delivery.approve": {
      if (actor.kind !== "human")
        return fail("Only the human can approve this revision.", "permission-denied");
      const readiness = factoryDeliveryReadiness(state, assignment, revision);
      if (
        !active ||
        !isCurrent ||
        readiness.reasons.length ||
        revision.bundleDigest !== command.bundleDigest ||
        revision.publication?.headSha !== command.expectedHeadSha
      )
        return fail(
          readiness.reasons.join(" ") ||
            "The reviewed revision changed. Refresh its evidence before approving.",
        );
      return updateRevision(
        {
          ...revision,
          approval: {
            expectedHeadSha: command.expectedHeadSha,
            bundleDigest: command.bundleDigest,
            ruleVersion: readiness.ruleVersion,
            authority: "human",
            commandId: command.commandId,
            approvedAt: now,
          },
        },
        [
          notice(
            "The human approved this exact revision and evidence bundle. Continue the team-owned merge process with delivery.merge; the host will recheck evidence and confirm the actual outcome.",
            { kind: "delivery", revisionId: revision.id },
          ),
        ],
        { readiness: [] },
      );
    }
    case "delivery.merge": {
      if (!lead || !active || !isCurrent)
        return fail("Only the active implementation lead can request merge.", "permission-denied");
      const readiness = factoryDeliveryReadiness(state, assignment, revision);
      if (readiness.reasons.length || (readiness.needsHuman && !readiness.humanApproved))
        return fail(
          readiness.reasons.join(" ") || "This revision requires human approval.",
          "permission-denied",
        );
      if (revision.merge && revision.merge.status !== "failed")
        return fail("Reconcile the existing merge operation before requesting another.");
      const operationId = `merge:${command.commandId}`;
      return updateRevision(
        {
          ...revision,
          approval: readiness.humanApproved
            ? revision.approval!
            : {
                expectedHeadSha: revision.publication!.headSha,
                bundleDigest: revision.bundleDigest!,
                ruleVersion: readiness.ruleVersion,
                authority: "project-rule",
                commandId: command.commandId,
                approvedAt: now,
              },
          merge: { operationId, status: "requested", requestedAt: now },
        },
        [{ type: "delivery.merge", ...revisionEffect, operationId }],
      );
    }
    case "delivery.merge.recorded":
      if (
        !host ||
        revision.merge?.operationId !== command.operationId ||
        (command.status === "merged" && command.mergedAt === undefined)
      )
        return fail("Merge receipt does not match the requested operation.");
      return updateRevision({
        ...revision,
        merge: {
          ...revision.merge,
          status: command.status,
          ...(command.mergedAt ? { mergedAt: command.mergedAt } : {}),
          ...(command.reason ? { reason: command.reason } : {}),
        },
      });
    case "delivery.retry": {
      if (!lead || !active || !isCurrent)
        return fail("Only the active lead can retry this delivery operation.", "permission-denied");
      const { error: _error, ...next } = revision;
      return updateRevision(
        {
          ...next,
          ...(next.merge?.status === "unknown"
            ? { merge: { ...next.merge, status: "requested" as const } }
            : {}),
        },
        [],
        { readiness: [] },
      );
    }
    case "delivery.effect.failed":
      if (!host) return fail("Only the host can report execution failure.", "permission-denied");
      return updateRevision(
        {
          ...revision,
          error: command.reason,
        },
        [
          notice(
            `Delivery operation needs attention: ${command.reason} Existing work is preserved. Resolve the cause, then use delivery.retry for this revision.`,
            { kind: "delivery", revisionId: revision.id },
          ),
        ],
        { readiness: [command.reason] },
      );
    default:
      return fail("Unsupported delivery transition.");
  }
}
