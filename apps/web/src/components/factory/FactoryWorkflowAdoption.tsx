import {
  AuthSettingsWriteScope,
  type FactoryAssignmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useId, useState } from "react";
import type { FactoryEnvironmentView } from "../../state/factory";
import { useEnvironmentScope } from "../../state/session";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { useFactoryCommand } from "./useFactoryCommand";

export function FactoryWorkflowAdoption({
  environment,
  canOpenThread,
  onOpenThread,
}: {
  environment: FactoryEnvironmentView;
  canOpenThread: (id: ThreadId) => boolean;
  onOpenThread: (id: ThreadId) => void;
}) {
  const prefix = useId();
  const permission = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const command = useFactoryCommand(environment, permission);
  const [repositoryId, setRepositoryId] = useState<string | null>(null);
  const [deliveryId, setDeliveryId] = useState<string | null>(null);
  const [releaseId, setReleaseId] = useState<string | null>(null);
  const [scope, setScope] = useState<"default" | "managers">("default");
  const [managerIds, setManagerIds] = useState<readonly ThreadId[]>([]);
  const [assignmentIds, setAssignmentIds] = useState<readonly FactoryAssignmentId[]>([]);
  const [restartKind, setRestartKind] = useState<"migration" | "trial" | "restore">("migration");
  const [reason, setReason] = useState("");
  const data = environment.data;
  if (!data) return null;
  const repositories = data.sharedRepositories.filter((entry) => entry.enabled);
  // Releases are registered from the exact commit the human approved and merged.
  const deliveries = data.assignments.flatMap((assignment) => {
    const purpose = assignment.sharedWork;
    if (purpose?.kind !== "implementation" || purpose.repositoryId !== repositoryId) return [];
    const plan = data.sharedWorks.find((entry) => entry.id === purpose.workId)?.plan;
    const revision = assignment.delivery?.revisions.findLast(
      (entry) => entry.merge?.status === "merged",
    )?.approval?.expectedHeadSha;
    return plan && revision ? [{ assignment, plan, revision }] : [];
  });
  const delivery = deliveries.find((entry) => entry.assignment.id === deliveryId);
  const releases = data.workflowReleases;
  const release = releases.find((entry) => entry.id === releaseId);
  const releaseProposal = data.improvementProposals.find(
    (entry) => entry.id === release?.proposalId && entry.revision === release.proposalRevision,
  );
  const releaseAssignment = data.assignments.find((entry) => entry.id === release?.assignmentId);
  const releasePullRequest = releaseAssignment?.delivery?.revisions.findLast(
    (entry) => entry.merge?.status === "merged",
  )?.publication?.ref;
  const latestDefault = data.workflowAdoptions.findLast((entry) => entry.scope.kind === "default");
  const defaultRelease = releases.find((entry) => entry.id === latestDefault?.releaseId);
  const restore = restartKind === "restore";
  const active = data.assignments.filter(
    (entry) =>
      entry.kind !== "onboarding" &&
      entry.status !== "complete" &&
      !entry.outcome &&
      (entry.completion === undefined || entry.completion.phase === "collecting") &&
      (restore || entry.sharedWork?.kind !== "experiment"),
  );
  const selectedAssignments = assignmentIds.filter((id) => active.some((entry) => entry.id === id));
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-sm font-medium">Register an exact workflow release</h3>
        <p className="text-sm text-muted-foreground">
          Register the merged commit you approved for a proposal's shared implementation. This
          verifies identity and required capabilities; it does not require quality tests or adopt
          the version.
        </p>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-repository`}>Owned repository</Label>
          <Select
            value={repositoryId}
            disabled={command.disabled}
            items={repositories.map((entry) => ({ value: entry.id, label: entry.repositoryRoot }))}
            onValueChange={setRepositoryId}
          >
            <SelectTrigger id={`${prefix}-repository`}>
              <SelectValue placeholder="Select repository" />
            </SelectTrigger>
            <SelectPopup>
              {repositories.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.repositoryRoot}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-delivery`}>Merged implementation</Label>
          <Select
            value={deliveryId}
            disabled={command.disabled}
            items={deliveries.map((entry) => ({
              value: entry.assignment.id,
              label: `${entry.assignment.title ?? entry.assignment.id} · ${entry.revision}`,
            }))}
            onValueChange={setDeliveryId}
          >
            <SelectTrigger id={`${prefix}-delivery`}>
              <SelectValue placeholder="Select merged implementation" />
            </SelectTrigger>
            <SelectPopup>
              {deliveries.map((entry) => (
                <SelectItem key={entry.assignment.id} value={entry.assignment.id}>
                  {entry.assignment.title ?? entry.assignment.id} · {entry.revision}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {repositoryId && !deliveries.length ? (
            <p className="text-xs text-muted-foreground">
              No shared implementation in this repository has a merged, approved delivery yet.
            </p>
          ) : null}
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={command.disabled || !repositoryId || !delivery}
          onClick={() => {
            if (repositoryId && delivery)
              void command.submit({
                type: "workflow.release.register",
                repositoryId,
                revision: delivery.revision,
                proposalId: delivery.plan.proposalId,
                proposalRevision: delivery.plan.proposalRevision,
                assignmentId: delivery.assignment.id,
              });
          }}
        >
          Register release
        </Button>
      </section>
      <section className="space-y-3">
        <h3 className="text-sm font-medium">Adopt for future assignments</h3>
        <p className="break-all text-sm text-muted-foreground">
          Environment default:{" "}
          {defaultRelease
            ? `${defaultRelease.version.repositoryRoot} @ ${defaultRelease.version.revision}`
            : "Each manager's existing approved workflow"}
          .
        </p>
        {defaultRelease ? (
          <Button
            size="xs"
            variant="outline"
            disabled={command.disabled}
            onClick={() =>
              void command.submit({
                type: "workflow.adopt",
                releaseId: null,
                scope: { kind: "default" },
              })
            }
          >
            Reset default to each manager's existing workflow
          </Button>
        ) : null}
        <p className="text-sm text-muted-foreground">
          Manager overrides take precedence over the environment default. Existing assignments keep
          their starting version. Adoption grants no additional source, model, publication or
          rule-change permissions.
        </p>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-release`}>Registered release</Label>
          <Select
            value={releaseId}
            disabled={command.disabled}
            items={releases.map((entry) => ({
              value: entry.id,
              label: `${entry.version.repositoryRoot} @ ${entry.version.revision}`,
            }))}
            onValueChange={setReleaseId}
          >
            <SelectTrigger id={`${prefix}-release`}>
              <SelectValue placeholder="Select release" />
            </SelectTrigger>
            <SelectPopup>
              {releases.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.version.repositoryRoot} @ {entry.version.revision}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        {release ? (
          <p className="break-all text-xs text-muted-foreground">
            Proposal: {releaseProposal?.content.problem.slice(0, 200) ?? release.proposalId}.
            Implementation: {releaseAssignment?.title ?? release.assignmentId ?? "not recorded"}
            {releasePullRequest
              ? ` · ${releasePullRequest.repository}#${releasePullRequest.number}`
              : ""}
            . Snapshot {release.snapshotDigest}. Owned Codex library; pstack provenance creates no
            upstream subscription.
          </p>
        ) : null}
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-scope`}>Adoption scope</Label>
          <Select
            value={scope}
            disabled={command.disabled}
            onValueChange={(value) => {
              if (value) setScope(value);
            }}
          >
            <SelectTrigger id={`${prefix}-scope`}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="default">Environment default</SelectItem>
              <SelectItem value="managers">Selected manager overrides</SelectItem>
            </SelectPopup>
          </Select>
        </div>
        {scope === "managers" ? (
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">Managers receiving this override</legend>
            {data.managers.map((manager) => (
              <label key={manager.id} className="flex items-start gap-2 text-sm">
                <Checkbox
                  disabled={command.disabled}
                  checked={managerIds.includes(manager.id)}
                  onCheckedChange={(checked) =>
                    setManagerIds((previous) =>
                      checked
                        ? [...previous, manager.id]
                        : previous.filter((id) => id !== manager.id),
                    )
                  }
                />
                {manager.name}
              </label>
            ))}
          </fieldset>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={command.disabled || !release || (scope === "managers" && !managerIds.length)}
          onClick={() => {
            if (release)
              void command.submit({
                type: "workflow.adopt",
                releaseId: release.id,
                scope: scope === "default" ? { kind: "default" } : { kind: "managers", managerIds },
              });
          }}
        >
          Approve adoption for future assignments
        </Button>
        {data.workflowOverrides.map((override) => {
          const manager = data.managers.find((entry) => entry.id === override.managerId);
          const adoption = data.workflowAdoptions.find((entry) => entry.id === override.adoptionId);
          const version = releases.find((entry) => entry.id === adoption?.releaseId)?.version;
          return (
            <div key={override.managerId} className="space-y-1 text-sm">
              <p className="break-all">
                {manager?.name ?? override.managerId}:{" "}
                {adoption?.releaseId === null
                  ? "Its existing approved workflow"
                  : (version?.revision ?? "Release unavailable")}
              </p>
              <Button
                size="xs"
                variant="ghost"
                disabled={command.disabled}
                onClick={() =>
                  void command.submit({
                    type: "workflow.override.clear",
                    managerId: override.managerId,
                  })
                }
              >
                Use current default for future assignments
              </Button>
            </div>
          );
        })}
      </section>
      <section className="space-y-3">
        <h3 className="text-sm font-medium">Explicitly restart selected active teams</h3>
        <p className="text-sm text-muted-foreground">
          Migrations and trials use the selected release above. A restore keeps each team's current
          pinned version, for work held after its authority was withdrawn and restored. The host
          stops each team, preserves permitted work and restarts it with a fresh workflow profile. A
          trial changes only the selected teams; it does not change the adopted default. Paused work
          stays paused.
        </p>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-restart-kind`}>Restart purpose</Label>
          <Select
            value={restartKind}
            disabled={command.disabled}
            onValueChange={(value) => {
              if (value) setRestartKind(value);
            }}
          >
            <SelectTrigger id={`${prefix}-restart-kind`}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="migration">Migrate selected teams</SelectItem>
              <SelectItem value="trial">Human-approved live trial</SelectItem>
              <SelectItem value="restore">Restore on current pinned version</SelectItem>
            </SelectPopup>
          </Select>
        </div>
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">
            Selected assignments and current pins
          </legend>
          {active.map((assignment) => (
            <label key={assignment.id} className="flex items-start gap-2 text-sm">
              <Checkbox
                disabled={command.disabled}
                checked={selectedAssignments.includes(assignment.id)}
                onCheckedChange={(checked) =>
                  setAssignmentIds((previous) =>
                    checked
                      ? [...previous, assignment.id]
                      : previous.filter((id) => id !== assignment.id),
                  )
                }
              />
              <span className="break-all">
                {assignment.title ?? assignment.id} · {assignment.workflow.revision}
              </span>
            </label>
          ))}
          {!active.length ? (
            <p className="text-sm text-muted-foreground">No active implementation assignments.</p>
          ) : null}
        </fieldset>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-restart-reason`}>Reason for this selected restart</Label>
          <Textarea
            id={`${prefix}-restart-reason`}
            value={reason}
            disabled={command.disabled}
            maxLength={6000}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={
            command.disabled ||
            (!restore && !release) ||
            !selectedAssignments.length ||
            !reason.trim()
          }
          onClick={() => {
            if (restore || release)
              void command
                .submit({
                  type: "workflow.restart",
                  ...(restore || !release ? {} : { releaseId: release.id }),
                  assignmentIds: selectedAssignments,
                  kind: restartKind,
                  reason: reason.trim(),
                })
                .then((saved) => {
                  if (saved) {
                    setAssignmentIds([]);
                    setReason("");
                  }
                });
          }}
        >
          Approve stop and restart for {selectedAssignments.length} selected teams
        </Button>
        {data.workflowMigrations
          .toReversed()
          .slice(0, 50)
          .map((migration) => {
            const assignment = data.assignments.find(
              (entry) => entry.id === migration.assignmentId,
            );
            const target = releases.find((entry) => entry.id === migration.releaseId);
            const currentPrepared =
              assignment !== undefined &&
              assignment.outcome === undefined &&
              assignment.status !== "complete" &&
              migration.lifecycle.phase === "ready" &&
              migration.lifecycle.resume.phase !== "delivered" &&
              data.workflowMigrations.findLast(
                (entry) => entry.assignmentId === migration.assignmentId,
              )?.id === migration.id;
            const authorityHeld = currentPrepared && assignment?.wait?.kind === "authority";
            const needsPreparation =
              currentPrepared &&
              assignment?.grant !== undefined &&
              assignment.grant.epoch !== migration.preparedEpoch;
            const failed =
              migration.lifecycle.phase === "failed"
                ? migration.lifecycle.reason
                : migration.lifecycle.phase === "ready" &&
                    migration.lifecycle.resume.phase === "failed"
                  ? migration.lifecycle.resume.reason
                  : null;
            return (
              <div key={migration.id} className="space-y-2 border-l border-border pl-3 text-sm">
                <div className="flex flex-wrap gap-2">
                  <span>{assignment?.title ?? migration.assignmentId}</span>
                  <Badge variant={failed ? "warning" : "outline"}>
                    {migration.lifecycle.phase === "ready"
                      ? `Prepared · resume ${migration.lifecycle.resume.phase}`
                      : migration.lifecycle.phase}
                  </Badge>
                </div>
                <p className="break-all text-xs text-muted-foreground">
                  {migration.previousVersion.revision} →{" "}
                  {migration.releaseId === null
                    ? migration.previousVersion.revision
                    : (target?.version.revision ?? migration.releaseId)}{" "}
                  · {migration.kind}
                </p>
                <p className="text-muted-foreground">{migration.reason}</p>
                {authorityHeld || needsPreparation ? (
                  <div className="space-y-2">
                    <p className="text-muted-foreground">
                      {assignment?.wait?.reason} Continuing checks the team's current permissions
                      and approved model. It does not restore removed file access, grant scope or
                      model permissions. Other waits and pauses remain in effect.
                    </p>
                    {needsPreparation ? (
                      <p className="text-muted-foreground">
                        Permissions changed after this profile was prepared. Prepare the team with
                        its current permissions before continuing.
                      </p>
                    ) : null}
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={command.disabled}
                      onClick={() =>
                        void command.submit({
                          type: needsPreparation
                            ? "workflow.restart.retry"
                            : "workflow.restart.continue",
                          migrationId: migration.id,
                        })
                      }
                    >
                      {needsPreparation
                        ? "Prepare current permissions again"
                        : "Continue with current permissions"}
                    </Button>
                  </div>
                ) : null}
                {failed ? (
                  <>
                    <p role="alert" className="text-destructive">
                      {failed}
                    </p>
                    {!needsPreparation ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={command.disabled}
                        onClick={() =>
                          void command.submit({
                            type: "workflow.restart.retry",
                            migrationId: migration.id,
                          })
                        }
                      >
                        Retry failed restart step
                      </Button>
                    ) : null}
                  </>
                ) : null}
                {assignment ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={!canOpenThread(assignment.threadId)}
                    onClick={() => onOpenThread(assignment.threadId)}
                  >
                    Open team
                  </Button>
                ) : null}
              </div>
            );
          })}
      </section>
      {command.pending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Saving workflow decision…
        </p>
      ) : null}
      {command.error ? (
        <p role="alert" className="text-sm text-destructive">
          {command.error}
        </p>
      ) : null}
    </div>
  );
}
