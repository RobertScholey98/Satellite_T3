import { assert, describe, it } from "@effect/vitest";
import { MessageId, RunId, ThreadId } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { decide } from "./FactoryState.ts";
import { deliveryIds, deliveryNow, deliverySkills } from "./FactoryDelivery.testkit.ts";
import { factoryCompletionEligibility } from "./FactoryRetros.ts";
import { FACTORY_DELIVERED_MESSAGE_RETENTION } from "./FactoryCollaboration.ts";
import { factoryDirectionBlocked, factoryExecutionBlocked } from "./FactoryControls.ts";
import {
  factoryIntegrationAccessBlocked,
  factoryIntegrationVerificationReadiness,
} from "./FactoryIntegration.ts";
import {
  api,
  integrated,
  host,
  actor,
  id,
  paths,
  run,
  apply,
  commissioned,
  configured,
  granted,
  preparationReceipt,
  ready,
  verified,
} from "./FactoryIntegration.testkit.ts";

describe("integration assignments", () => {
  it("preserves integration inputs and tools during takeover and releases parent direction on handback", () => {
    for (const assignmentId of [integrated.assignment, api.assignment]) {
      const prepared = ready();
      const assignment = prepared.state.assignments.find((entry) => entry.id === assignmentId)!;
      const membership = {
        threadId: assignment.threadId,
        assignmentId: assignment.id,
        managerId: assignment.managerId,
        projectId: assignment.projectId,
        ancestorThreadIds: [assignment.managerId],
      };
      const taken = Result.getOrThrow(
        decide({
          skills: deliverySkills,
          state: prepared.state,
          actor: { kind: "human" },
          command: { type: "thread.takeover", commandId: id(), threadId: assignment.threadId },
          controlTarget: membership,
          now: deliveryNow,
        }),
      );
      assert.isNull(factoryIntegrationAccessBlocked(taken.state, prepared.integrationId));
      assert.equal(taken.state.integrations[0]!.phase, "ready");
      assert.equal(taken.state.integrations[0]!.currentPreparationId, prepared.preparationId);
      assert.isUndefined(factoryExecutionBlocked(taken.state, membership));
      assert.isDefined(factoryDirectionBlocked(taken.state, membership, assignment.managerId));
      assert.isFalse(taken.effects.some((entry) => entry.type === "integration.stop"));
      const returned = apply(taken.state, {
        type: "thread.handback",
        commandId: id(),
        threadId: assignment.threadId,
      });
      assert.isUndefined(factoryDirectionBlocked(returned.state, membership, assignment.managerId));
      assert.equal(returned.state.integrations[0]!.currentPreparationId, prepared.preparationId);
      assert.equal(returned.state.integrations[0]!.phase, "ready");
      assert.isFalse(returned.effects.some((entry) => entry.type === "integration.prepare"));
    }
  });
  it("carries a revoked hold's captured work into the explicitly refreshed preparation", () => {
    const result = ready();
    const grant = result.state.integrationGrants.find((entry) => entry.projectId === api.project)!;
    const replaced = apply(
      result.state,
      {
        type: "integration.grant",
        commandId: id(),
        integrationId: result.integrationId,
        projectId: api.project,
        capabilityId: grant.capabilityId,
        paths,
      },
      actor(api.manager),
    );
    const hold = replaced.state.integrations[0]!.hold!;
    const queue = { threadId: integrated.lead, runIds: [RunId.make("queued-work")] };
    const captured = apply(
      replaced.state,
      {
        type: "integration.hold.targets.recorded",
        commandId: id(),
        integrationId: result.integrationId,
        holdId: hold.id,
        threadIds: [integrated.lead],
        resumeQueues: [queue],
      },
      host,
    );
    const refreshed = apply(
      captured.state,
      {
        type: "integration.refresh",
        commandId: id(),
        integrationId: result.integrationId,
        expectedPreparationId: result.preparationId,
      },
      actor(integrated.lead),
    );
    const next = refreshed.state.integrationPreparations.at(-1)!;
    assert.deepEqual(next.inheritedResumeThreadIds, [integrated.lead]);
    assert.deepEqual(next.inheritedResumeQueues, [queue]);
    assert.isUndefined(next.resumeThreadIds);
  });
  it("carries unresumed verification work and excludes it once restoration is confirmed", () => {
    const result = ready();
    const pending = apply(
      result.state,
      {
        type: "integration.verify",
        commandId: id(),
        integrationId: result.integrationId,
        preparationId: result.preparationId,
      },
      actor(integrated.lead),
    );
    const operation = {
      kind: "verification" as const,
      id: pending.result.integrationVerificationId!,
    };
    const queue = { threadId: integrated.lead, runIds: [RunId.make("saved-check-followup")] };
    const captured = apply(
      pending.state,
      {
        type: "integration.operation.targets.recorded",
        commandId: id(),
        integrationId: result.integrationId,
        operation,
        threadIds: [integrated.lead],
        resumeQueues: [queue],
      },
      host,
    );
    const failed = apply(
      captured.state,
      {
        type: "integration.verify.failed",
        commandId: id(),
        verificationId: operation.id,
        reason: "Runner unavailable",
      },
      host,
    );
    const refresh = {
      type: "integration.refresh" as const,
      commandId: id(),
      integrationId: result.integrationId,
      expectedPreparationId: result.preparationId,
    };
    const retained = apply(failed.state, refresh, actor(integrated.lead));
    assert.deepEqual(retained.state.integrationPreparations.at(-1)!.inheritedResumeThreadIds, [
      integrated.lead,
    ]);
    assert.deepEqual(retained.state.integrationPreparations.at(-1)!.inheritedResumeQueues, [queue]);
    const resumed = apply(
      failed.state,
      {
        type: "integration.operation.resumed",
        commandId: id(),
        integrationId: result.integrationId,
        operation,
      },
      host,
    );
    const fresh = apply(resumed.state, { ...refresh, commandId: id() }, actor(integrated.lead));
    assert.deepEqual(fresh.state.integrationPreparations.at(-1)!.inheritedResumeThreadIds, []);
    assert.deepEqual(fresh.state.integrationPreparations.at(-1)!.inheritedResumeQueues, []);
  });
  it("rejects a delayed stop receipt after an explicit refresh supersedes its hold", () => {
    const result = ready();
    const grant = result.state.integrationGrants.find((entry) => entry.projectId === api.project)!;
    const replaced = apply(
      result.state,
      {
        type: "integration.grant",
        commandId: id(),
        integrationId: result.integrationId,
        projectId: api.project,
        capabilityId: grant.capabilityId,
        paths,
      },
      actor(api.manager),
    );
    const hold = replaced.state.integrations[0]!.hold!;
    assert.equal(hold.preparationId, result.preparationId);
    const refreshed = apply(
      replaced.state,
      {
        type: "integration.refresh",
        commandId: id(),
        integrationId: result.integrationId,
        expectedPreparationId: result.preparationId,
      },
      actor(integrated.lead),
    );
    assert.isNull(refreshed.state.integrations[0]!.hold);
    assert.isTrue(
      Result.isFailure(
        run(
          refreshed.state,
          {
            type: "integration.stop.failed",
            commandId: id(),
            integrationId: result.integrationId,
            holdId: hold.id,
            reason: "Late old stop",
          },
          host,
        ),
      ),
    );
  });
  it("notifies an integration team when a shared technical plan becomes agreed", () => {
    const result = ready();
    const proposed = apply(
      result.state,
      {
        type: "collaboration.plan.propose",
        commandId: id(),
        requestIds: ["peer-request"],
        text: "Use versioned response payloads",
        changes: { kind: "technical" },
      },
      actor(deliveryIds.lead),
    );
    const planId = proposed.result.planId!;
    const frontend = apply(
      proposed.state,
      {
        type: "collaboration.plan.acknowledge",
        commandId: id(),
        planId,
        assignmentId: deliveryIds.assignment,
      },
      actor(deliveryIds.lead),
    );
    const agreed = apply(
      frontend.state,
      {
        type: "collaboration.plan.acknowledge",
        commandId: id(),
        planId,
        assignmentId: api.assignment,
      },
      actor(api.lead),
    );
    assert.isTrue(
      agreed.effects.some(
        (entry) =>
          entry.type === "integration.notify" && entry.integrationId === result.integrationId,
      ),
    );
    assert.isTrue(
      Result.isFailure(
        run(
          agreed.state,
          {
            type: "integration.verify",
            commandId: id(),
            integrationId: result.integrationId,
            preparationId: result.preparationId,
          },
          actor(integrated.lead),
        ),
      ),
    );
  });
  it("retains revoked verification as stale history and never resumes it as current evidence", () => {
    const result = ready();
    const pending = apply(
      result.state,
      {
        type: "integration.verify",
        commandId: id(),
        integrationId: result.integrationId,
        preparationId: result.preparationId,
      },
      actor(integrated.lead),
    );
    const grant = pending.state.integrationGrants.find((entry) => entry.projectId === api.project)!;
    const revoked = apply(
      pending.state,
      {
        type: "integration.grant.revoke",
        commandId: id(),
        grantId: grant.id,
        reason: "Emergency restriction",
      },
      actor(api.manager),
    );
    const recorded = apply(
      revoked.state,
      {
        type: "integration.verified",
        commandId: id(),
        verificationId: pending.result.integrationVerificationId!,
        result: "passed",
        testArtifact: result.artifact,
        hostArtifactId: "old-finished-run",
        checks: [
          {
            id: "coordinator",
            status: "passed",
            exitCode: 0,
            output: "Captured before revocation",
          },
        ],
      },
      host,
    );
    assert.equal(recorded.state.integrationVerifications[0]!.lifecycle.phase, "completed");
    assert.equal(
      factoryIntegrationVerificationReadiness(recorded.state, result.integrationId).status,
      "stale",
    );
    assert.equal(recorded.state.integrations[0]!.phase, "blocked");
  });
  it("creates a full requester-owned lead while waiting for independent project grants", () => {
    const result = commissioned();
    const team = result.state.assignments.find((entry) => entry.id === integrated.assignment)!;
    assert.equal(team.managerId, deliveryIds.manager);
    assert.equal(team.projectId, deliveryIds.project);
    assert.equal(team.threadId, integrated.lead);
    assert.equal(team.integrationId, result.integrationId);
    assert.deepEqual(team.grant?.sourcePaths, []);
    assert.deepEqual(
      result.effects.filter(
        (entry) => entry.type !== "integration.notify" && entry.type !== "merge.group.hold",
      ),
      [{ type: "integration.thread.create", integrationId: result.integrationId }],
    );
    assert.equal(result.state.integrations[0]!.phase, "awaiting-grants");
  });
  it("rejects requester grants for foreign resources and manager-defined test classifications", () => {
    const { state, integrationId } = configured();
    const capability = state.integrationCapabilities.find(
      (entry) => entry.projectId === api.project,
    )!;
    assert.isTrue(
      Result.isFailure(
        run(
          state,
          {
            type: "integration.grant",
            commandId: id(),
            integrationId,
            projectId: api.project,
            capabilityId: capability.id,
            paths,
          },
          actor(deliveryIds.manager),
        ),
      ),
    );
    assert.isTrue(
      Result.isFailure(
        run(
          state,
          {
            type: "integration.capability.configure",
            commandId: id(),
            projectId: api.project,
            boundaryId: api.boundary,
            paths,
            coordinator: null,
          },
          actor(api.manager),
        ),
      ),
    );
  });
  it("autonomously prepares once both owners grant their classified test scope", () => {
    const { state, integrationId } = granted();
    assert.equal(state.integrations[0]!.phase, "preparing");
    assert.lengthOf(state.integrationGrants, 2);
    assert.lengthOf(state.integrationPreparations, 1);
    assert.isNull(factoryIntegrationAccessBlocked(state, integrationId));
    const prepared = ready();
    assert.equal(prepared.state.integrations[0]!.phase, "ready");
    assert.equal(prepared.effects[0]!.type, "thread.launch");
  });
  it("rejects production writes and permits exact test and fixture operations", () => {
    const result = ready();
    const grantId = result.state.integrationGrants[0]!.id;
    const base = {
      type: "integration.file.mutate" as const,
      commandId: id(),
      integrationId: result.integrationId,
      preparationId: result.preparationId,
      grantId,
    };
    assert.isTrue(
      Result.isFailure(
        run(
          result.state,
          { ...base, operation: { kind: "write", path: "src/feature.ts", content: "bad" } },
          actor(integrated.lead),
        ),
      ),
    );
    assert.isTrue(
      Result.isFailure(
        run(
          result.state,
          { ...base, operation: { kind: "write", path: "runner.js", content: "bad" } },
          actor(integrated.lead),
        ),
      ),
    );
    assert.isTrue(
      Result.isFailure(
        run(
          result.state,
          {
            ...base,
            operation: { kind: "create", path: "test/new/../production.js", content: "bad" },
          },
          actor(integrated.lead),
        ),
      ),
    );
    assert.equal(
      apply(
        result.state,
        { ...base, operation: { kind: "write", path: "test/check.js", content: "test" } },
        actor(integrated.lead),
      ).effects[0]!.type,
      "integration.file.mutate",
    );
    assert.equal(
      apply(
        result.state,
        { ...base, operation: { kind: "create", path: "fixtures/new/input.json", content: "{}" } },
        actor(integrated.lead),
      ).effects[0]!.type,
      "integration.file.mutate",
    );
  });
  it("requires host-resolved membership for descendant verification", () => {
    const prepared = ready();
    const command = {
      type: "integration.verify" as const,
      commandId: id(),
      integrationId: prepared.integrationId,
      preparationId: prepared.preparationId,
    };
    const worker = actor(ThreadId.make("integration-worker"));
    assert.isTrue(Result.isFailure(run(prepared.state, command, worker)));
    assert.isTrue(
      Result.isSuccess(
        decide({
          skills: deliverySkills,
          state: prepared.state,
          command,
          actor: worker,
          now: deliveryNow,
          integrationActorAssignmentId: integrated.assignment,
        }),
      ),
    );
  });
  it("records exact immutable QA evidence and makes a new participant revision stale", () => {
    const result = verified();
    assert.deepEqual(factoryIntegrationVerificationReadiness(result.state, result.integrationId), {
      status: "passed",
      verificationId: result.result.integrationVerificationId!,
      reasons: [],
      published: false,
    });
    const changed = {
      ...result.state,
      assignments: result.state.assignments.map((entry) =>
        entry.id === api.assignment
          ? { ...entry, delivery: { ...entry.delivery!, currentRevisionId: "new-api" } }
          : entry,
      ),
    };
    assert.equal(
      factoryIntegrationVerificationReadiness(changed, result.integrationId).status,
      "stale",
    );
  });
  it("requires nonempty actual passing checks instead of agent success prose", () => {
    const prepared = ready();
    const pending = apply(
      prepared.state,
      {
        type: "integration.verify",
        commandId: id(),
        integrationId: prepared.integrationId,
        preparationId: prepared.preparationId,
      },
      actor(integrated.lead),
    );
    assert.isTrue(
      Result.isFailure(
        run(
          pending.state,
          {
            type: "integration.verified",
            commandId: id(),
            verificationId: pending.result.integrationVerificationId!,
            result: "passed",
            testArtifact: prepared.artifact,
            hostArtifactId: "fake",
            checks: [],
          },
          host,
        ),
      ),
    );
    assert.isTrue(
      Result.isFailure(
        run(
          pending.state,
          {
            type: "integration.verified",
            commandId: id(),
            verificationId: pending.result.integrationVerificationId!,
            result: "passed",
            testArtifact: prepared.artifact,
            hostArtifactId: "fake",
            checks: [{ id: "coordinator", status: "failed", exitCode: 1, output: "failed" }],
          },
          host,
        ),
      ),
    );
  });
  it("revokes all combined execution immediately and rejects an in-flight prepared receipt", () => {
    const { state, integrationId } = granted();
    const receipt = preparationReceipt(state, integrationId);
    const grant = state.integrationGrants.find((entry) => entry.projectId === api.project)!;
    const revoked = apply(
      state,
      {
        type: "integration.grant.revoke",
        commandId: id(),
        grantId: grant.id,
        reason: "API resource unavailable",
      },
      actor(api.manager),
    );
    assert.equal(revoked.state.integrations[0]!.phase, "blocked");
    assert.equal(revoked.effects.filter((entry) => entry.type === "integration.stop").length, 1);
    assert.isTrue(
      Result.isFailure(
        run(
          revoked.state,
          {
            type: "integration.prepared",
            commandId: id(),
            integrationId,
            preparationId: receipt.preparationId,
            manifest: receipt.manifest,
            profileId: "stale",
            testArtifact: receipt.artifact,
          },
          host,
        ),
      ),
    );
    const repeated = apply(
      revoked.state,
      {
        type: "integration.grant.revoke",
        commandId: id(),
        grantId: grant.id,
        reason: "Already revoked",
      },
      actor(api.manager),
    );
    assert.lengthOf(repeated.effects, 0);
  });
  it("regrant preserves the hold until an explicit refresh replaces preparation identity", () => {
    const result = ready();
    const grant = result.state.integrationGrants.find((entry) => entry.projectId === api.project)!;
    const replacement = apply(
      result.state,
      {
        type: "integration.grant",
        commandId: id(),
        integrationId: result.integrationId,
        projectId: api.project,
        capabilityId: grant.capabilityId,
        paths,
      },
      actor(api.manager),
    );
    assert.equal(replacement.state.integrations[0]!.phase, "blocked");
    const refreshed = apply(
      replacement.state,
      {
        type: "integration.refresh",
        commandId: id(),
        integrationId: result.integrationId,
        expectedPreparationId: result.preparationId,
      },
      actor(integrated.lead),
    );
    assert.equal(refreshed.state.integrations[0]!.phase, "preparing");
    assert.equal(
      refreshed.state.integrationPreparations.at(-1)!.previousPreparationId,
      result.preparationId,
    );
    assert.notEqual(refreshed.result.integrationPreparationId, result.preparationId);
  });
  it("project pause blocks every combined participant while a manager pause alone preserves access", () => {
    const result = ready();
    const managerPaused = apply(result.state, {
      type: "manager.pause",
      commandId: id(),
      managerId: api.manager,
    });
    assert.isNull(factoryIntegrationAccessBlocked(managerPaused.state, result.integrationId));
    const projectPaused = apply(result.state, {
      type: "project.pause",
      commandId: id(),
      projectId: api.project,
    });
    assert.equal(projectPaused.state.integrations[0]!.phase, "blocked");
    assert.isTrue(projectPaused.effects.some((entry) => entry.type === "integration.stop"));
  });
  it("superseding a capability stops existing combined access before requalification", () => {
    const result = ready();
    const reconfigured = apply(result.state, {
      type: "integration.capability.configure",
      commandId: id(),
      projectId: api.project,
      boundaryId: api.boundary,
      paths,
      coordinator: null,
    });
    assert.equal(reconfigured.state.integrations[0]!.phase, "blocked");
    assert.isTrue(reconfigured.effects.some((entry) => entry.type === "integration.stop"));
  });
  it("routes production defects to the owning lead without expanding file permission", () => {
    const result = ready();
    const routed = apply(
      result.state,
      {
        type: "integration.defect.report",
        commandId: id(),
        integrationId: result.integrationId,
        participantAssignmentId: api.assignment,
        preparationId: result.preparationId,
        summary: "Response is incompatible",
        evidence: [{ label: "failing combined run", location: "artifact://run" }],
      },
      actor(integrated.lead),
    );
    assert.equal(routed.state.integrationMessages[0]!.toAssignmentId, api.assignment);
    assert.equal(routed.state.integrationMessages[0]!.content.kind, "production-defect");
    assert.deepEqual(routed.state.integrationGrants, result.state.integrationGrants);
    assert.isTrue(
      Result.isFailure(
        run(
          result.state,
          {
            type: "integration.message.send",
            commandId: id(),
            integrationId: result.integrationId,
            fromAssignmentId: deliveryIds.assignment,
            toAssignmentId: api.assignment,
            text: "Bypass peer request",
          },
          actor(deliveryIds.lead),
        ),
      ),
    );
  });
  it("keeps the latest delivered integration messages and every undelivered one", () => {
    const prepared = ready();
    let state = prepared.state;
    const send = () => {
      const sent = apply(
        state,
        {
          type: "integration.message.send",
          commandId: id(),
          integrationId: prepared.integrationId,
          fromAssignmentId: integrated.assignment,
          toAssignmentId: api.assignment,
          text: "Status update.",
        },
        actor(integrated.lead),
      );
      state = sent.state;
      return sent.result.integrationMessageId!;
    };
    const failed = send();
    state = apply(
      state,
      { type: "integration.message.failed", commandId: id(), messageId: failed, reason: "Offline" },
      host,
    ).state;
    const pending = send();
    const delivered = Array.from({ length: FACTORY_DELIVERED_MESSAGE_RETENTION + 2 }, () => {
      const messageId = send();
      state = apply(
        state,
        {
          type: "integration.message.recorded",
          commandId: id(),
          messageId,
          recipientThreadId: api.lead,
          deliveredMessageId: MessageId.make(`peer-${messageId}`),
        },
        host,
      ).state;
      return messageId;
    });
    assert.deepEqual(
      state.integrationMessages.map((entry) => entry.id),
      [failed, pending, ...delivered.slice(2)],
    );
    apply(
      state,
      { type: "integration.message.retry", commandId: id(), messageId: failed },
      actor(integrated.lead),
    );
  });
  it("cannot complete successfully through generic human acceptance or publication", () => {
    const result = verified();
    const assignment = result.state.assignments.find(
      (entry) => entry.id === integrated.assignment,
    )!;
    assert.isFalse(factoryCompletionEligibility(result.state, assignment).eligible);
    assert.isTrue(
      Result.isFailure(
        run(result.state, {
          type: "assignment.completion.accept",
          commandId: id(),
          assignmentId: assignment.id,
          condition: assignment.scope!.completionCondition,
          evidence: [],
        }),
      ),
    );
    assert.isTrue(
      Result.isFailure(
        run(
          result.state,
          {
            type: "delivery.capture",
            commandId: id(),
            assignmentId: assignment.id,
            expectedEpoch: 0,
            selectedPaths: ["test/check.js"],
            commitMessage: "Publish outside owner",
          },
          actor(integrated.lead),
        ),
      ),
    );
  });
  it("allows normal cancellation only after the human reason and physical stop", () => {
    const result = ready();
    const cancelled = apply(result.state, {
      type: "assignment.cancel",
      commandId: id(),
      assignmentId: integrated.assignment,
    });
    const control = cancelled.state.controls.find(
      (entry) => entry.kind === "cancellation" && entry.assignmentId === integrated.assignment,
    )!;
    const stopped = {
      ...cancelled.state,
      controls: cancelled.state.controls.map((entry) =>
        entry.id === control.id
          ? { ...entry, stop: { status: "confirmed" as const, stoppedAt: deliveryNow } }
          : entry,
      ),
    };
    const reasoned = apply(stopped, {
      type: "assignment.cancellation-reason",
      commandId: id(),
      assignmentId: integrated.assignment,
      reason: "Product direction changed",
    });
    const concluded = {
      ...reasoned.state,
      controls: reasoned.state.controls.map((entry) =>
        entry.id === control.id
          ? { ...entry, stop: { status: "confirmed" as const, stoppedAt: deliveryNow } }
          : entry,
      ),
    };
    const assignment = concluded.assignments.find((entry) => entry.id === integrated.assignment)!;
    assert.isTrue(factoryCompletionEligibility(concluded, assignment).eligible);
  });
  it("records a grant beyond the owner's capability for the human to approve or decline", () => {
    const base = configured();
    const narrowed = apply(base.state, {
      type: "integration.capability.configure",
      commandId: id(),
      projectId: api.project,
      boundaryId: api.boundary,
      paths: { ...paths, fixtureDirectories: [] },
      coordinator: null,
    });
    const capabilityId = narrowed.result.integrationCapabilityId!;
    let state = apply(
      narrowed.state,
      {
        type: "integration.capability.qualified",
        commandId: id(),
        capabilityId,
        profileId: "integration-profile-api",
        configurationDigest: "configuration-api",
        coordinatorDigest: null,
      },
      host,
    ).state;
    const frontend = state.integrationCapabilities.find(
      (entry) => entry.projectId === deliveryIds.project && entry.supersededBy === null,
    )!;
    state = apply(
      state,
      {
        type: "integration.grant",
        commandId: id(),
        integrationId: base.integrationId,
        projectId: deliveryIds.project,
        capabilityId: frontend.id,
        paths,
      },
      actor(deliveryIds.manager),
    ).state;
    const ask = (current: typeof state) =>
      apply(
        current,
        {
          type: "integration.grant",
          commandId: id(),
          integrationId: base.integrationId,
          projectId: api.project,
          capabilityId,
          paths,
        },
        actor(api.manager),
      );
    const asked = ask(state);
    const grantId = asked.result.integrationGrantId!;
    assert.equal(
      asked.state.integrationGrants.find((entry) => entry.id === grantId)?.lifecycle.phase,
      "requested",
    );
    assert.equal(asked.state.integrations[0]!.phase, "awaiting-grants");
    assert.isTrue(asked.effects.some((entry) => entry.type === "integration.notify"));
    const approve = { type: "integration.grant.approve", commandId: id(), grantId } as const;
    assert.isTrue(Result.isFailure(run(asked.state, approve, actor(api.manager))));
    const approved = apply(asked.state, approve);
    assert.equal(
      approved.state.integrationGrants.find((entry) => entry.id === grantId)?.lifecycle.phase,
      "active",
    );
    assert.equal(approved.state.integrations[0]!.phase, "preparing");
    const again = ask(state);
    const declined = apply(again.state, {
      type: "integration.grant.revoke",
      commandId: id(),
      grantId: again.result.integrationGrantId!,
      reason: "Fixture directories stay closed",
    });
    assert.equal(
      declined.state.integrationGrants.find((entry) => entry.id === again.result.integrationGrantId)
        ?.lifecycle.phase,
      "revoked",
    );
    assert.isTrue(declined.effects.some((entry) => entry.type === "integration.notify"));
  });
  it("cancels the integration team when its originating assignment is cancelled", () => {
    const { state } = commissioned();
    const cancelled = apply(state, {
      type: "assignment.cancel",
      commandId: id(),
      assignmentId: deliveryIds.assignment,
    });
    assert.equal(cancelled.state.crossProjectRequests[0]?.lifecycle.phase, "withdrawn");
    assert.equal(
      cancelled.state.assignments.find((entry) => entry.id === integrated.assignment)?.outcome
        ?.kind,
      "cancelled",
    );
    assert.isTrue(
      cancelled.effects.some(
        (entry) =>
          entry.type === "control.stop" &&
          entry.controlId === `cancellation:${integrated.assignment}`,
      ),
    );
  });
});
