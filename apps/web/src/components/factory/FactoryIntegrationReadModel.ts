import type { FactorySnapshot } from "@t3tools/contracts";
import { factoryCollaborationPlanStatus } from "./FactoryCollaborationReadModel";

export function factoryIntegrationRecordedEvidence(
  state: Pick<
    FactorySnapshot,
    | "integrations"
    | "integrationVerifications"
    | "integrationPreparations"
    | "integrationCapabilities"
    | "integrationGrants"
    | "integrationTestArtifacts"
    | "assignments"
    | "collaborationPlans"
  >,
  integrationId: string,
): {
  status: "missing" | "running" | "failed" | "stale" | "passed" | "unverified";
  reasons: string[];
  published: boolean;
} {
  const integration = state.integrations.find((entry) => entry.id === integrationId);
  const verification = state.integrationVerifications.findLast(
    (entry) => entry.integrationId === integrationId,
  );
  if (!integration || !verification)
    return { status: "missing", reasons: ["No verification has been recorded."], published: false };
  if (verification.lifecycle.phase === "requested")
    return { status: "running", reasons: ["Host verification is pending."], published: false };
  if (verification.lifecycle.phase === "failed")
    return { status: "failed", reasons: [verification.lifecycle.reason], published: false };
  const preparation = state.integrationPreparations.find(
    (entry) => entry.id === verification.preparationId,
  );
  if (!preparation || preparation.lifecycle.phase !== "ready")
    return {
      status: "unverified",
      reasons: ["The recorded preparation is not available."],
      published: false,
    };
  const manifest = preparation.lifecycle.manifest;
  const reasons: string[] = [];
  let incomplete = false;
  if (integration.phase !== "ready")
    reasons.push(integration.waitReason ?? "The integration workspace is not ready for execution.");
  if (
    integration.currentPreparationId !== verification.preparationId ||
    verification.inputDigest !== manifest.inputDigest
  )
    reasons.push("Inputs have been refreshed since this verification.");
  if (integration.currentTestArtifactId !== verification.lifecycle.testArtifactId)
    reasons.push("Integration tests have changed since this verification.");
  const testArtifactId = verification.lifecycle.testArtifactId;
  const artifact = state.integrationTestArtifacts.find((entry) => entry.id === testArtifactId);
  if (!artifact) incomplete = true;
  else if (artifact.digest !== verification.lifecycle.testArtifactDigest)
    reasons.push("The recorded test artifact digest differs from the verification.");
  for (const input of manifest.inputs) {
    const assignment = state.assignments.find((entry) => entry.id === input.assignmentId);
    const grant = state.integrationGrants.find((entry) => entry.id === input.integrationGrantId);
    const capability = state.integrationCapabilities.find(
      (entry) => entry.id === input.capabilityId,
    );
    if (!assignment || !grant || !capability) {
      incomplete = true;
      continue;
    }
    const revision = assignment.delivery?.revisions.find((entry) => entry.id === input.revisionId);
    if (
      assignment.threadId !== input.leadThreadId ||
      assignment.grant?.epoch !== input.grantEpoch ||
      assignment.delivery?.currentRevisionId !== input.revisionId ||
      revision?.candidateId !== input.candidateId ||
      revision.candidateDigest !== input.candidateDigest
    )
      reasons.push(`${input.projectId}: the participating lead, grant or candidate has changed.`);
    if (
      grant.lifecycle.phase !== "active" ||
      capability.supersededBy !== null ||
      capability.qualification.status !== "qualified"
    )
      reasons.push(`${input.projectId}: owner access needs renewal.`);
    if (
      input.publication.kind === "published-head" &&
      (revision?.publication?.headSha !== input.publication.headSha ||
        revision.publication.treeOid !== input.publication.treeOid)
    )
      reasons.push(`${input.projectId}: the recorded published head has changed.`);
  }
  for (const id of manifest.planIds) {
    const plan = state.collaborationPlans.find((entry) => entry.id === id);
    const status = plan ? factoryCollaborationPlanStatus(state, plan) : "unverified";
    if (status === "unverified") incomplete = true;
    else if (status !== "agreed") reasons.push("A technical agreement is no longer current.");
  }
  const currentPlans = state.collaborationPlans.filter(
    (entry) =>
      entry.phase === "agreed" &&
      entry.requestIds.some((id) => integration.requestIds.includes(id)),
  );
  if (currentPlans.some((entry) => !manifest.planIds.includes(entry.id)))
    reasons.push("A newer technical agreement needs refreshed inputs.");
  const published = manifest.inputs.every((entry) => entry.publication.kind === "published-head");
  return {
    status: reasons.length
      ? "stale"
      : incomplete
        ? "unverified"
        : verification.lifecycle.result === "passed"
          ? "passed"
          : "failed",
    reasons: reasons.length
      ? reasons
      : incomplete
        ? ["Some participant state is outside this view."]
        : [],
    published,
  };
}
