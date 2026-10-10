import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  AuthSettingsWriteScope,
  type FactoryManager,
  type FactorySharedWork,
  type ThreadId,
} from "@t3tools/contracts";
import { useId, useState } from "react";
import type { FactoryEnvironmentView } from "../../state/factory";
import { useEnvironmentScope } from "../../state/session";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { factoryModelLabel } from "./FactoryModelPolicyDialog";
import { FactorySharedRepositoryForm } from "./FactorySharedRepositoryForm";
import { FactoryWorkflowAdoption } from "./FactoryWorkflowAdoption";
import { useFactoryCommand } from "./useFactoryCommand";

type Props = {
  environment: FactoryEnvironmentView;
  projects: readonly EnvironmentProject[];
  manager: Extract<FactoryManager, { role: "system" }>;
  canOpenThread: (id: ThreadId) => boolean;
  onOpenThread: (id: ThreadId) => void;
  onClose: () => void;
};
function WorkPlan({
  work,
  environment,
  canOpenThread,
  onOpenThread,
}: Pick<Props, "environment" | "canOpenThread" | "onOpenThread"> & { work: FactorySharedWork }) {
  const prefix = useId();
  const permission = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const command = useFactoryCommand(environment, permission);
  const [acknowledged, setAcknowledged] = useState(false);
  const [reason, setReason] = useState("");
  const plan = work.plan;
  const assignmentId = "assignmentId" in work.lifecycle ? work.lifecycle.assignmentId : null;
  const assignment = environment.data?.assignments.find((entry) => entry.id === assignmentId);
  const repository = environment.data?.sharedRepositories.find(
    (entry) => entry.id === plan.repositoryId,
  );
  return (
    <section className="space-y-3 border-b border-border pb-4">
      <div className="flex flex-wrap gap-2">
        <h3 className="text-sm font-medium">{plan.work.title}</h3>
        <Badge variant={work.lifecycle.phase === "proposed" ? "warning" : "outline"}>
          {work.lifecycle.phase}
        </Badge>
      </div>
      <p className="break-all text-xs text-muted-foreground">
        {repository?.repositoryRoot ?? plan.repositoryId} · work {work.id} · proposal{" "}
        {plan.proposalId} · revision {plan.proposalRevision}
      </p>
      <dl className="space-y-2 text-sm">
        {(
          [
            ["Scope", plan.work.scope.description],
            ["Completion", plan.work.scope.completionCondition],
            ["Expected benefit", plan.expectedBenefit],
            ["Assessment approach", plan.assessmentApproach],
            ["Existing source files", plan.work.sourcePaths.join("\n") || "None"],
            ["Creation directories", plan.work.creatableDirectories.join("\n") || "None"],
            ["Exact protected edits or creations", plan.work.controlPaths?.join("\n") || "None"],
          ] as const
        ).map(([label, value]) => (
          <div key={label}>
            <dt className="font-medium">{label}</dt>
            <dd className="whitespace-pre-wrap break-words text-muted-foreground">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm text-muted-foreground">
        {plan.work.complexity} · {plan.work.kind} ·{" "}
        {plan.work.scope.requiresPullRequest
          ? "Human PR approval required"
          : "Explicit report or human acceptance"}{" "}
        ·{" "}
        {plan.work.modelSelection
          ? factoryModelLabel(plan.work.modelSelection)
          : "Automatic choice within the approved model pool"}
      </p>
      <p className="text-sm text-muted-foreground">
        {plan.changesSkills
          ? "Skill authoring explicitly requires writing-for-agents and applicable references."
          : "The host also detects skill edits from paths and changes."}{" "}
        {plan.weakensRules
          ? "This is a separately authorized rule-weakening task. Review the exact protected changes before authorizing."
          : "This plan does not authorize weakening rules."}
      </p>
      {work.lifecycle.phase === "proposed" ? (
        <>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={acknowledged}
              disabled={command.disabled}
              onCheckedChange={setAcknowledged}
            />
            I authorize this exact work plan and its listed protected changes.
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={command.disabled || !acknowledged}
            onClick={() => void command.submit({ type: "shared.work.authorize", workId: work.id })}
          >
            Authorize this implementation plan
          </Button>
        </>
      ) : null}
      {work.lifecycle.phase === "authorized" ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {work.notification?.phase === "delivered"
              ? "Authorization delivered to the system manager for commissioning."
              : work.notification?.phase === "failed"
                ? "The manager has not received this authorization."
                : "Authorization delivery to the system manager is pending."}
          </p>
          {work.notification?.phase === "failed" ? (
            <>
              <p role="alert" className="text-sm text-destructive">
                {work.notification.reason}
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={command.disabled}
                onClick={() =>
                  void command.submit({ type: "shared.work.notify.retry", workId: work.id })
                }
              >
                Retry authorization delivery
              </Button>
            </>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={command.disabled}
            onClick={() => void command.submit({ type: "shared.work.commission", workId: work.id })}
          >
            Commission authorized implementation now
          </Button>
        </div>
      ) : null}
      {assignment ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={!canOpenThread(assignment.threadId)}
          onClick={() => onOpenThread(assignment.threadId)}
        >
          Open implementation team · {assignment.status}
        </Button>
      ) : null}
      {work.lifecycle.phase === "revoked" ? (
        <p className="text-sm text-muted-foreground">Authority revoked: {work.lifecycle.reason}</p>
      ) : (
        <details className="space-y-2 text-sm">
          <summary className="cursor-pointer">Revoke this work authority</summary>
          <Label htmlFor={`${prefix}-reason`}>Reason</Label>
          <Textarea
            id={`${prefix}-reason`}
            value={reason}
            maxLength={6000}
            disabled={command.disabled}
            onChange={(event) => setReason(event.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={command.disabled || !reason.trim()}
            onClick={() =>
              void command.submit({
                type: "shared.work.revoke",
                workId: work.id,
                reason: reason.trim(),
              })
            }
          >
            Revoke and stop affected work
          </Button>
        </details>
      )}
      {command.pending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Saving work decision…
        </p>
      ) : null}
      {command.error ? (
        <p role="alert" className="text-sm text-destructive">
          {command.error}
        </p>
      ) : null}
    </section>
  );
}

function ExperimentSettings({ environment }: Pick<Props, "environment">) {
  const prefix = useId();
  const current = environment.data?.experimentConfigurations.at(-1);
  const [enabled, setEnabled] = useState(current?.enabled ?? false);
  const [maxConcurrent, setMaxConcurrent] = useState<number | null>(current?.maxConcurrent ?? 1);
  const [maxPerInvestigation, setMaxPerInvestigation] = useState<number | null>(
    current?.maxPerInvestigation ?? 1,
  );
  const permission = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const command = useFactoryCommand(environment, permission);
  const valid =
    maxConcurrent !== null &&
    Number.isInteger(maxConcurrent) &&
    maxConcurrent >= 1 &&
    maxConcurrent <= 10 &&
    maxPerInvestigation !== null &&
    Number.isInteger(maxPerInvestigation) &&
    maxPerInvestigation >= 1 &&
    maxPerInvestigation <= 20;
  return (
    <section className="space-y-3">
      <p className="text-sm text-muted-foreground">
        When enabled, the system manager can commission isolated candidate authoring and inspection
        for named investigations. These teams cannot publish PRs, create tracker tickets or change
        the adopted workflow. Live trials still require your selected-team approval.
      </p>
      <label className="flex items-start gap-2 text-sm">
        <Checkbox checked={enabled} disabled={command.disabled} onCheckedChange={setEnabled} />
        Allow bounded isolated experiments
      </label>
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-concurrent`}>Maximum concurrent experiments</Label>
        <NumberField
          id={`${prefix}-concurrent`}
          value={maxConcurrent}
          min={1}
          max={10}
          step={1}
          disabled={command.disabled}
          onValueChange={setMaxConcurrent}
        >
          <NumberFieldGroup>
            <NumberFieldInput />
          </NumberFieldGroup>
        </NumberField>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-investigation`}>Maximum experiments per investigation</Label>
        <NumberField
          id={`${prefix}-investigation`}
          value={maxPerInvestigation}
          min={1}
          max={20}
          step={1}
          disabled={command.disabled}
          onValueChange={setMaxPerInvestigation}
        >
          <NumberFieldGroup>
            <NumberFieldInput />
          </NumberFieldGroup>
        </NumberField>
      </div>
      <p className="text-xs text-muted-foreground">
        Completed and canceled experiments still count toward the investigation limit. Disabling
        stops affected experimental work and preserves evidence; re-enabling does not revive revoked
        work.
      </p>
      <Button
        size="sm"
        variant="outline"
        disabled={command.disabled || !valid}
        onClick={() => {
          if (valid)
            void command.submit({
              type: "experiment.configure",
              enabled,
              maxConcurrent,
              maxPerInvestigation,
            });
        }}
      >
        {command.pending ? "Saving…" : "Approve experiment permissions"}
      </Button>
      {command.error ? (
        <p role="alert" className="text-sm text-destructive">
          {command.error}
        </p>
      ) : null}
    </section>
  );
}

export function FactoryWorkflowDialog({
  environment,
  projects,
  manager,
  canOpenThread,
  onOpenThread,
  onClose,
}: Props) {
  const prefix = useId();
  const permission = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const command = useFactoryCommand(environment, permission);
  const [view, setView] = useState<
    "work" | "repositories" | "adoption" | "experiments" | "validation" | "models"
  >("work");
  const [limit, setLimit] = useState(50);
  const data = environment.data;
  if (!data) return null;
  const views = [
    { value: "work", label: "Implementation plans" },
    { value: "repositories", label: "Owned repositories" },
    { value: "adoption", label: "Workflow releases and adoption" },
    { value: "experiments", label: "Isolated experiments" },
    { value: "validation", label: "Outcome validation" },
    { value: "models", label: "Model recommendations" },
  ] as const;
  const works = data.sharedWorks.filter((entry) => entry.managerId === manager.id).toReversed();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Shared workflow delivery</DialogTitle>
          <DialogDescription>
            {manager.name} coordinates approved implementation; you retain work authority, live
            trial, adoption and standing model decisions.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            {!environment.connected || !environment.canOperate || !permission ? (
              <p role="status" className="text-sm text-muted-foreground">
                Review is available. Changes require a connected environment with settings and
                operate permission.
              </p>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor={`${prefix}-view`}>Workflow area</Label>
              <Select
                value={view}
                items={views}
                onValueChange={(value) => {
                  if (value) {
                    setView(value);
                    setLimit(50);
                  }
                }}
              >
                <SelectTrigger id={`${prefix}-view`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {views.map((entry) => (
                    <SelectItem key={entry.value} value={entry.value}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            {view === "work" ? (
              <div className="space-y-5">
                <p className="text-sm text-muted-foreground">
                  Accepting a proposal does not grant repository access. Review the system manager's
                  exact immutable work plan here. Implementation and PR review belong to its
                  delegated team; adoption is separate.
                </p>
                {works.slice(0, limit).map((work) => (
                  <WorkPlan
                    key={work.id}
                    work={work}
                    environment={environment}
                    canOpenThread={canOpenThread}
                    onOpenThread={onOpenThread}
                  />
                ))}
                {!works.length ? (
                  <p className="text-sm text-muted-foreground">
                    No implementation plans yet. Discuss an accepted proposal with the system
                    manager to prepare one.
                  </p>
                ) : null}
                {works.length > limit ? (
                  <Button size="sm" variant="ghost" onClick={() => setLimit((value) => value + 50)}>
                    Show more plans
                  </Button>
                ) : null}
              </div>
            ) : null}
            {view === "repositories" ? (
              <div className="space-y-5">
                {data.sharedRepositories
                  .filter((entry) => entry.managerId === manager.id)
                  .map((repository) => (
                    <section key={repository.id} className="space-y-2 border-b border-border pb-3">
                      <div className="flex flex-wrap gap-2">
                        <h3 className="text-sm font-medium">
                          {projects.find((entry) => entry.id === repository.projectId)?.title ??
                            repository.projectId}
                        </h3>
                        <Badge variant={repository.enabled ? "outline" : "warning"}>
                          {repository.enabled ? "Enabled" : "Disabled"}
                        </Badge>
                      </div>
                      <p className="break-all text-xs text-muted-foreground">
                        {repository.repositoryRoot} · {repository.kind}
                      </p>
                      <details className="space-y-2 text-sm">
                        <summary className="cursor-pointer">Approved repository boundary</summary>
                        {data.boundaries
                          .filter((entry) => entry.id === repository.boundaryId)
                          .map((boundary) => (
                            <dl key={boundary.id} className="space-y-2">
                              {(
                                [
                                  ["Protected files", boundary.protectedPaths],
                                  ["Existing source files", boundary.writablePaths],
                                  ["Creation directories", boundary.creatableDirectories],
                                  [
                                    "Protected creation paths",
                                    boundary.protectedCreatablePaths ?? [],
                                  ],
                                  ["Skill roots", boundary.skillRoots ?? []],
                                  ["Required checks", boundary.gates.map((gate) => gate.label)],
                                ] as const
                              ).map(([label, values]) => (
                                <div key={label}>
                                  <dt className="font-medium">{label}</dt>
                                  <dd className="whitespace-pre-wrap break-words text-muted-foreground">
                                    {values.join("\n") || "None"}
                                  </dd>
                                </div>
                              ))}
                              <div>
                                <dt className="font-medium">Verification</dt>
                                <dd>{boundary.verification ?? "gates"}</dd>
                              </div>
                              <div>
                                <dt className="font-medium">Approved source revision</dt>
                                <dd className="break-all text-muted-foreground">
                                  {boundary.sourceRevision}
                                </dd>
                              </div>
                            </dl>
                          ))}
                      </details>
                      <p className="text-xs text-muted-foreground">
                        Disabling stops its shared assignments. Re-enabling does not restore revoked
                        grants.
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={command.disabled}
                        onClick={() =>
                          void command.submit({
                            type: "shared.repository.configure",
                            repositoryId: repository.id,
                            enabled: !repository.enabled,
                          })
                        }
                      >
                        {repository.enabled
                          ? "Disable shared repository"
                          : "Enable for future work"}
                      </Button>
                    </section>
                  ))}
                <details className="space-y-3">
                  <summary className="cursor-pointer text-sm font-medium">
                    Register another owned repository
                  </summary>
                  <FactorySharedRepositoryForm environment={environment} projects={projects} />
                </details>
              </div>
            ) : null}
            {view === "adoption" ? (
              <FactoryWorkflowAdoption
                environment={environment}
                canOpenThread={canOpenThread}
                onOpenThread={onOpenThread}
              />
            ) : null}
            {view === "experiments" ? (
              <div className="space-y-4">
                <ExperimentSettings
                  key={data.experimentConfigurations.at(-1)?.commandId ?? "defaults"}
                  environment={environment}
                />
                {data.workflowExperiments
                  .toReversed()
                  .slice(0, limit)
                  .map((experiment) => {
                    const assignment = data.assignments.find(
                      (entry) => entry.id === experiment.assignmentId,
                    );
                    return (
                      <section
                        key={experiment.id}
                        className="space-y-2 border-l border-border pl-3 text-sm"
                      >
                        <h3 className="font-medium">{assignment?.title ?? experiment.id}</h3>
                        <p>{experiment.expectedBenefit}</p>
                        <p className="text-muted-foreground">
                          Assessment: {experiment.assessmentApproach}
                        </p>
                        <p className="break-all text-xs text-muted-foreground">
                          Investigation {experiment.investigationId} ·{" "}
                          {assignment?.status ?? "Assignment unavailable"}
                        </p>
                        {assignment ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={!canOpenThread(assignment.threadId)}
                            onClick={() => onOpenThread(assignment.threadId)}
                          >
                            Open experiment team
                          </Button>
                        ) : null}
                      </section>
                    );
                  })}
                {data.workflowExperiments.length > limit ? (
                  <Button size="sm" variant="ghost" onClick={() => setLimit((value) => value + 50)}>
                    Show more experiments
                  </Button>
                ) : null}
              </div>
            ) : null}
            {view === "validation" ? (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  The system manager records whether available evidence supports the expected
                  benefit. Implementation can finish while validation remains insufficient.
                  Assessments do not add a PR gate or automatically roll back adoption.
                </p>
                {data.improvementValidations
                  .toReversed()
                  .slice(0, limit)
                  .map((validation) => (
                    <section
                      key={validation.id}
                      className="space-y-2 border-l border-border pl-3 text-sm"
                    >
                      <Badge variant={validation.outcome === "failure" ? "warning" : "outline"}>
                        {validation.outcome}
                      </Badge>
                      <p className="whitespace-pre-wrap">{validation.assessment}</p>
                      <p className="whitespace-pre-wrap text-muted-foreground">
                        Recommended next step: {validation.recommendedNextStep}
                      </p>
                      <p className="break-all text-xs text-muted-foreground">
                        Proposal {validation.proposalId} · revision {validation.proposalRevision}
                        {validation.assignmentId ? ` · assignment ${validation.assignmentId}` : ""}
                        {validation.releaseId ? ` · release ${validation.releaseId}` : ""}
                      </p>
                      <ul className="space-y-1 text-xs text-muted-foreground">
                        {validation.evidence.map((ref) => (
                          <li key={JSON.stringify(ref)} className="break-all">
                            {ref.kind}:{" "}
                            {"threadId" in ref ? (
                              <>
                                <code>{ref.threadId}</code>
                                {"messageId" in ref
                                  ? ` · ${ref.messageId}`
                                  : "runId" in ref
                                    ? ` · ${ref.runId}`
                                    : ""}
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  disabled={!canOpenThread(ref.threadId)}
                                  onClick={() => onOpenThread(ref.threadId)}
                                >
                                  Open source thread
                                </Button>
                              </>
                            ) : (
                              <code>{ref.id}</code>
                            )}
                          </li>
                        ))}
                      </ul>
                      {!validation.evidence.length ? (
                        <p className="text-xs text-muted-foreground">
                          No linked evidence recorded.
                        </p>
                      ) : null}
                    </section>
                  ))}
                {!data.improvementValidations.length ? (
                  <p className="text-sm text-muted-foreground">
                    No outcome assessment recorded yet.
                  </p>
                ) : null}
                {data.improvementValidations.length > limit ? (
                  <Button size="sm" variant="ghost" onClick={() => setLimit((value) => value + 50)}>
                    Show more assessments
                  </Button>
                ) : null}
              </div>
            ) : null}
            {view === "models" ? (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Individual model choices stay autonomous inside approved pools. Standing
                  preferences change only when you apply a concrete recommendation.
                </p>
                {data.modelRecommendations
                  .toReversed()
                  .slice(0, limit)
                  .map((recommendation) => {
                    const target = recommendation.target;
                    const policy = target.kind === "default" ? target.policy : target.overrides;
                    return (
                      <section
                        key={recommendation.id}
                        className="space-y-3 border-b border-border pb-4 text-sm"
                      >
                        <h3 className="font-medium">
                          {target.kind === "default"
                            ? "Environment model defaults"
                            : (data.managers.find((entry) => entry.id === target.managerId)?.name ??
                              target.managerId)}
                        </h3>
                        <p className="whitespace-pre-wrap">{recommendation.rationale}</p>
                        <p className="break-all text-xs text-muted-foreground">
                          Proposal {recommendation.proposalId} · revision{" "}
                          {recommendation.proposalRevision}
                        </p>
                        <div>
                          <p className="font-medium">Approved models</p>
                          {policy.approvedModels ? (
                            policy.approvedModels.length ? (
                              <ul>
                                {policy.approvedModels.map((model) => (
                                  <li key={JSON.stringify(model)}>{factoryModelLabel(model)}</li>
                                ))}
                              </ul>
                            ) : (
                              <p>Empty pool: no model is approved.</p>
                            )
                          ) : (
                            <p className="text-muted-foreground">Inherit approved model pool.</p>
                          )}
                        </div>
                        <div>
                          <p className="font-medium">Preferences</p>
                          {policy.preferences ? (
                            policy.preferences.length ? (
                              <ul>
                                {policy.preferences.map((preference) => (
                                  <li key={`${preference.role}:${preference.complexity}`}>
                                    {preference.role} · {preference.complexity}:{" "}
                                    {factoryModelLabel(preference.selection)}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p>No standing preferences.</p>
                            )
                          ) : (
                            <p className="text-muted-foreground">Inherit preferences.</p>
                          )}
                        </div>
                        {recommendation.applied ? (
                          <p role="status" className="text-muted-foreground">
                            Applied {recommendation.applied.appliedAt}.
                          </p>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={command.disabled}
                            onClick={() =>
                              void command.submit({
                                type: "workflow.models.apply",
                                recommendationId: recommendation.id,
                              })
                            }
                          >
                            Approve and apply these standing preferences
                          </Button>
                        )}
                      </section>
                    );
                  })}
                {!data.modelRecommendations.length ? (
                  <p className="text-sm text-muted-foreground">
                    No standing model recommendation awaiting review.
                  </p>
                ) : null}
                {data.modelRecommendations.length > limit ? (
                  <Button size="sm" variant="ghost" onClick={() => setLimit((value) => value + 50)}>
                    Show more recommendations
                  </Button>
                ) : null}
              </div>
            ) : null}
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
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={!canOpenThread(manager.threadId)}
            onClick={() => onOpenThread(manager.threadId)}
          >
            Discuss with system manager
          </Button>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
