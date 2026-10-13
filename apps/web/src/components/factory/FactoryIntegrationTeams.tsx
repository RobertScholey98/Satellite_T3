import type {
  FactoryIntegration,
  FactoryIntegrationCapability,
  FactoryIntegrationGrant,
  FactoryManager,
  ThreadId,
} from "@t3tools/contracts";
import { useId, useState } from "react";
import type { FactoryEnvironmentView } from "../../state/factory";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { FactoryIntegrationCommission } from "./FactoryIntegrationCommission";
import { FactoryIntegrationPathsSummary, integrationPathFields } from "./FactoryIntegrationPaths";
import { factoryIntegrationRecordedEvidence } from "./FactoryIntegrationReadModel";
import { useFactoryCommand } from "./useFactoryCommand";

export function FactoryIntegrationTeams({
  environment,
  manager,
  canOpenThread,
  onOpenThread,
}: {
  environment: FactoryEnvironmentView;
  manager: FactoryManager;
  canOpenThread: (id: ThreadId) => boolean;
  onOpenThread: (id: ThreadId) => void;
}) {
  const state = environment.data;
  const integrations =
    state?.integrations.filter(
      (entry) =>
        entry.requesterManagerId === manager.id ||
        entry.participantAssignmentIds.some((id) =>
          state.assignments.some(
            (assignment) => assignment.id === id && assignment.managerId === manager.id,
          ),
        ),
    ) ?? [];
  return (
    <div className="space-y-4">
      {manager.role === "project" ? (
        <FactoryIntegrationCommission environment={environment} manager={manager} />
      ) : null}
      {integrations.toReversed().map((entry) => (
        <IntegrationTeam
          key={entry.id}
          environment={environment}
          manager={manager}
          integration={entry}
          canOpenThread={canOpenThread}
          onOpenThread={onOpenThread}
        />
      ))}
      {!integrations.length ? (
        <p className="text-sm text-muted-foreground">
          No integration teams involve this manager yet.
        </p>
      ) : null}
    </div>
  );
}

function IntegrationTeam({
  environment,
  manager,
  integration,
  canOpenThread,
  onOpenThread,
}: {
  environment: FactoryEnvironmentView;
  manager: FactoryManager;
  integration: FactoryIntegration;
  canOpenThread: (id: ThreadId) => boolean;
  onOpenThread: (id: ThreadId) => void;
}) {
  const prefix = useId();
  const command = useFactoryCommand(environment);
  const [reason, setReason] = useState("");
  const state = environment.data;
  if (!state) return null;
  const lead = state.assignments.find((entry) => entry.id === integration.assignmentId);
  const participants = state.assignments.filter((entry) =>
    integration.participantAssignmentIds.includes(entry.id),
  );
  const preparation = state.integrationPreparations.find(
    (entry) => entry.id === integration.currentPreparationId,
  );
  const grants = state.integrationGrants.filter((entry) => entry.integrationId === integration.id);
  const currentGrant = grants.findLast(
    (entry) => entry.projectId === manager.projectId && entry.lifecycle.phase === "active",
  );
  const capability = state.integrationCapabilities.findLast(
    (entry) =>
      entry.projectId === manager.projectId &&
      entry.supersededBy === null &&
      entry.qualification.status === "qualified",
  );
  const ownParticipant = participants.find((entry) => entry.managerId === manager.id);
  const evidence = factoryIntegrationRecordedEvidence(state, integration.id);
  const verification = state.integrationVerifications.findLast(
    (entry) => entry.integrationId === integration.id,
  );
  const artifacts = state.integrationTestArtifacts.filter(
    (entry) => entry.integrationId === integration.id,
  );
  const phases = {
    "awaiting-grants": "Waiting for owner grants",
    preparing: "Preparing isolated workspace",
    ready: "Workspace ready",
    blocked: "Blocked",
  };
  return (
    <section className="space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{lead?.title ?? "Integration team"}</h3>
        {lead ? (
          <Button
            size="sm"
            variant="outline"
            disabled={!canOpenThread(lead.threadId)}
            onClick={() => onOpenThread(lead.threadId)}
          >
            Open integration lead
          </Button>
        ) : null}
      </div>
      <p className="text-sm">{phases[integration.phase]}</p>
      <p className="break-all text-xs text-muted-foreground">{integration.id}</p>
      {integration.waitReason ? (
        <p role="status" className="text-sm">
          {integration.waitReason}
        </p>
      ) : null}
      {integration.hold ? (
        <p role="status" className="text-sm">
          Stop confirmation: {integration.hold.status}. {integration.hold.reason}
        </p>
      ) : null}
      {lead?.wait?.kind === "execution-boundary" ? (
        <p role="status" className="text-sm">
          {lead.wait.reason}
        </p>
      ) : null}
      {lead?.qualification.status === "unavailable" ? (
        <>
          <p role="alert" className="text-sm">
            {lead.qualification.reason}
          </p>
          {lead.threadStatus === "pending" ? (
            <Button
              size="sm"
              disabled={command.disabled}
              onClick={() =>
                void command.submit({
                  type: "integration.thread.retry",
                  integrationId: integration.id,
                })
              }
            >
              Retry integration thread
            </Button>
          ) : null}
        </>
      ) : null}
      <ul className="space-y-2 text-sm">
        {participants.map((participant) => {
          const grant = grants.findLast(
            (entry) =>
              entry.participantAssignmentId === participant.id &&
              entry.lifecycle.phase === "active",
          );
          const grantedCapability = state.integrationCapabilities.find(
            (entry) => entry.id === grant?.capabilityId,
          );
          const grantCurrent =
            grant &&
            grantedCapability?.supersededBy === null &&
            grantedCapability.qualification.status === "qualified";
          return (
            <li key={participant.id}>
              <div className="flex flex-wrap items-center gap-2">
                <span>
                  {participant.title ?? participant.id} ·{" "}
                  {state.managers.find((entry) => entry.id === participant.managerId)?.name ??
                    participant.projectId}
                </span>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={!canOpenThread(participant.threadId)}
                  onClick={() => onOpenThread(participant.threadId)}
                >
                  Open owning lead
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {grantCurrent
                  ? `Current owner grant ${grant.id}`
                  : grant
                    ? "Owner grant needs renewal against a current qualified capability"
                    : "Waiting for this project's owner grant"}
              </p>
            </li>
          );
        })}
      </ul>
      {grants
        .filter((entry) => entry.lifecycle.phase === "requested")
        .map((entry) => (
          <GrantRequest key={entry.id} environment={environment} grant={entry} />
        ))}
      {ownParticipant ? (
        <details className="rounded-md border p-3">
          <summary className="cursor-pointer text-sm font-medium">
            This project's integration access
          </summary>
          <div className="mt-3 space-y-3">
            {currentGrant ? (
              <>
                <FactoryIntegrationPathsSummary paths={currentGrant.paths} />
                <Label htmlFor={`${prefix}-revoke`}>Reason for withdrawing access</Label>
                <Textarea
                  id={`${prefix}-revoke`}
                  value={reason}
                  disabled={command.disabled}
                  onChange={(event) => setReason(event.target.value)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={command.disabled || !reason.trim()}
                  onClick={() =>
                    void command.submit({
                      type: "integration.grant.revoke",
                      grantId: currentGrant.id,
                      reason: reason.trim(),
                    })
                  }
                >
                  Revoke this grant
                </Button>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                No active grant. Other projects' access remains under their owners' control.
              </p>
            )}
            {capability ? (
              <GrantForm
                key={`${capability.id}:${currentGrant?.id ?? "new"}`}
                environment={environment}
                integration={integration}
                capability={capability}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                A human must qualify this project's integration capability before its manager can
                grant access.
              </p>
            )}
            {grants
              .filter(
                (entry) =>
                  entry.projectId === manager.projectId && entry.lifecycle.phase === "revoked",
              )
              .map((entry) => (
                <p key={entry.id} className="text-xs text-muted-foreground">
                  Revoked {entry.id}:{" "}
                  {entry.lifecycle.phase === "revoked" ? entry.lifecycle.reason : ""}
                </p>
              ))}
          </div>
        </details>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={command.disabled || integration.phase === "preparing"}
          onClick={() =>
            void command.submit({
              type: "integration.refresh",
              integrationId: integration.id,
              expectedPreparationId: integration.currentPreparationId,
            })
          }
        >
          {command.pending ? "Updating…" : "Refresh inputs and preserve tests"}
        </Button>
        {preparation?.lifecycle.phase === "ready" ? (
          <Button
            size="sm"
            disabled={
              command.disabled ||
              integration.phase !== "ready" ||
              verification?.lifecycle.phase === "requested"
            }
            onClick={() =>
              void command.submit({
                type: "integration.verify",
                integrationId: integration.id,
                preparationId: preparation.id,
              })
            }
          >
            Run protected verification
          </Button>
        ) : null}
      </div>
      {preparation?.lifecycle.phase === "failed" ? (
        <p role="alert" className="text-sm">
          {preparation.lifecycle.reason}
        </p>
      ) : null}
      <div className="space-y-1">
        <h4 className="text-sm font-medium">Recorded evidence: {evidence.status}</h4>
        {evidence.reasons.map((entry) => (
          <p key={entry} className="text-xs text-muted-foreground">
            {entry}
          </p>
        ))}
        <p className="text-xs text-muted-foreground">
          {evidence.published
            ? "Evidence references published heads."
            : "Candidate QA can include unpublished work."}{" "}
          This is recorded evidence. Final merge must freshly capture tests and recheck all heads.
        </p>
      </div>
      {preparation?.lifecycle.phase === "ready" ? (
        <details>
          <summary className="cursor-pointer text-sm">Exact prepared revisions</summary>
          <div className="mt-2 space-y-2 text-xs">
            <p className="break-all">Input digest: {preparation.lifecycle.manifest.inputDigest}</p>
            {preparation.lifecycle.manifest.inputs.map((input) => (
              <div key={input.projectId} className="space-y-1 break-all">
                <p>
                  {input.projectId} · revision {input.revisionId} · grant epoch {input.grantEpoch}
                </p>
                <p>
                  Candidate {input.candidateId} · {input.candidateDigest}
                </p>
                <p>
                  {input.publication.kind === "published-head"
                    ? `Published head ${input.publication.headSha}; base ${input.publication.baseSha}`
                    : "Unpublished candidate — QA only"}
                </p>
              </div>
            ))}
          </div>
        </details>
      ) : null}
      {verification?.lifecycle.phase === "completed" ? (
        <details>
          <summary className="cursor-pointer text-sm">
            Host checks: {verification.lifecycle.result}
          </summary>
          <div className="mt-2 space-y-2">
            {verification.lifecycle.checks.map((check) => (
              <details key={check.id}>
                <summary className="cursor-pointer text-xs">
                  {check.id}: {check.status} · exit {check.exitCode ?? "none"}
                </summary>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
                  {check.output}
                </pre>
              </details>
            ))}
          </div>
        </details>
      ) : null}
      {artifacts.length ? (
        <details>
          <summary className="cursor-pointer text-sm">
            Scoped test and fixture patches ({artifacts.length})
          </summary>
          <div className="mt-2 space-y-2 text-xs">
            {artifacts.toReversed().map((artifact) => (
              <div key={artifact.id} className="space-y-1 break-all">
                <p>
                  {artifact.id} · {artifact.digest}
                </p>
                {artifact.projects.map((project) => (
                  <div key={project.projectId}>
                    <p>
                      {project.projectId}: {project.changedPaths.join(", ") || "No changed files"}
                    </p>
                    {project.deletedPaths.length ? (
                      <p>Deleted: {project.deletedPaths.join(", ")}</p>
                    ) : null}
                    <p>Patch artifact: {project.patchArtifactId}</p>
                  </div>
                ))}
              </div>
            ))}
            <p className="text-muted-foreground">
              Owning leads can retrieve their exact patch through factory_integration_read_patch and
              incorporate it into their own PR. Production code remains with its owning team.
            </p>
          </div>
        </details>
      ) : null}
      {state.integrationMessages
        .filter((entry) => entry.integrationId === integration.id)
        .map((message) => (
          <details key={message.id}>
            <summary className="cursor-pointer text-sm">
              {message.content.kind === "production-defect"
                ? "Production defect routed to owner"
                : "Lead coordination"}{" "}
              · {message.delivery.phase}
            </summary>
            <p className="mt-2 whitespace-pre-wrap text-sm">
              {message.content.kind === "production-defect"
                ? message.content.summary
                : message.content.text}
            </p>
            {message.delivery.phase === "failed" ? (
              <div className="mt-2 space-y-2">
                <p role="alert" className="text-xs">
                  {message.delivery.reason}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={command.disabled}
                  onClick={() =>
                    void command.submit({
                      type: "integration.message.retry",
                      messageId: message.id,
                    })
                  }
                >
                  Retry delivery
                </Button>
              </div>
            ) : null}
          </details>
        ))}
      {command.error ? (
        <p role="alert" className="text-sm text-destructive">
          {command.error}
        </p>
      ) : null}
    </section>
  );
}

function GrantForm({
  environment,
  integration,
  capability,
}: {
  environment: FactoryEnvironmentView;
  integration: FactoryIntegration;
  capability: FactoryIntegrationCapability;
}) {
  const prefix = useId();
  const command = useFactoryCommand(environment);
  const [paths, setPaths] = useState(capability.paths);
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">Grant a subset of the qualified capability</p>
      {integrationPathFields.map(([key, label]) => (
        <fieldset key={key} disabled={command.disabled} className="space-y-2">
          <legend className="mb-1 text-xs font-medium">{label}</legend>
          {capability.paths[key].map((path, index) => (
            <div key={path} className="flex items-start gap-2">
              <Checkbox
                id={`${prefix}-${key}-${index}`}
                checked={paths[key].includes(path)}
                onCheckedChange={(checked) =>
                  setPaths((previous) => ({
                    ...previous,
                    [key]: checked
                      ? [...previous[key], path]
                      : previous[key].filter((entry) => entry !== path),
                  }))
                }
              />
              <Label htmlFor={`${prefix}-${key}-${index}`}>{path}</Label>
            </div>
          ))}
        </fieldset>
      ))}
      <p className="text-xs text-muted-foreground">
        Grant changes stop affected integration work. Refresh inputs explicitly once all owners have
        supplied current access.
      </p>
      {command.error ? (
        <p role="alert" className="text-sm text-destructive">
          {command.error}
        </p>
      ) : null}
      <Button
        size="sm"
        disabled={command.disabled}
        onClick={() =>
          void command.submit({
            type: "integration.grant",
            integrationId: integration.id,
            projectId: capability.projectId,
            capabilityId: capability.id,
            paths,
          })
        }
      >
        {command.pending ? "Granting…" : "Grant selected access"}
      </Button>
    </div>
  );
}

// An owner asked for more than its qualified capability; only the human grants or declines it.
function GrantRequest({
  environment,
  grant,
}: {
  environment: FactoryEnvironmentView;
  grant: FactoryIntegrationGrant;
}) {
  const prefix = useId();
  const command = useFactoryCommand(environment);
  const [reason, setReason] = useState("");
  const owner = environment.data?.managers.find((entry) => entry.id === grant.ownerManagerId);
  return (
    <div className="space-y-3 rounded-md border p-3">
      <p className="text-sm font-medium">
        {owner?.name ?? grant.projectId} asks to grant access beyond its qualified capability
      </p>
      <FactoryIntegrationPathsSummary paths={grant.paths} />
      <Button
        size="sm"
        disabled={command.disabled}
        onClick={() =>
          void command.submit({ type: "integration.grant.approve", grantId: grant.id })
        }
      >
        Approve this grant
      </Button>
      <Label htmlFor={`${prefix}-decline`}>Reason to decline</Label>
      <Textarea
        id={`${prefix}-decline`}
        value={reason}
        disabled={command.disabled}
        onChange={(event) => setReason(event.target.value)}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={command.disabled || !reason.trim()}
        onClick={() =>
          void command.submit({
            type: "integration.grant.revoke",
            grantId: grant.id,
            reason: reason.trim(),
          })
        }
      >
        Decline this grant
      </Button>
      {command.error ? (
        <p role="alert" className="text-sm text-destructive">
          {command.error}
        </p>
      ) : null}
    </div>
  );
}
