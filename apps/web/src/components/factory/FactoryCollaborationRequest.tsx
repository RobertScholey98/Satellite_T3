import type {
  FactoryAssignmentId,
  FactoryCollaborationCondition as Condition,
  FactoryCollaborationPlan,
  FactoryCrossProjectRequest,
  FactoryManager,
  ThreadId,
} from "@t3tools/contracts";
import { useId, useState } from "react";
import type { FactoryEnvironmentView } from "../../state/factory";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import {
  FactoryCollaborationCondition,
  factoryCollaborationConditionLabel,
} from "./FactoryCollaborationCondition";
import { FactoryCollaborationWorkForm } from "./FactoryCollaborationWorkForm";
import { factoryCollaborationPlanStatus } from "./FactoryCollaborationReadModel";
import { useFactoryCommand } from "./useFactoryCommand";

export function FactoryCollaborationRequest({
  environment,
  manager,
  request,
  canOpenThread,
  onOpenThread,
}: {
  environment: FactoryEnvironmentView;
  manager: FactoryManager;
  request: FactoryCrossProjectRequest;
  canOpenThread: (id: ThreadId) => boolean;
  onOpenThread: (id: ThreadId) => void;
}) {
  const prefix = useId();
  const command = useFactoryCommand(environment);
  const [action, setAction] = useState<
    "new" | "existing" | "defer" | "decline" | "withdraw" | "amend" | null
  >(null);
  const [reason, setReason] = useState("");
  const [alternative, setAlternative] = useState("");
  const [condition, setCondition] = useState<Condition | null>(null);
  const [supportId, setSupportId] = useState<FactoryAssignmentId | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [message, setMessage] = useState("");
  const [fromId, setFromId] = useState<FactoryAssignmentId | null>(null);
  const state = environment.data;
  if (!state) return null;
  const origin = request.origin;
  const lifecycle = request.lifecycle;
  const source =
    origin.kind === "assignment"
      ? state.assignments.find((entry) => entry.id === origin.assignmentId)
      : undefined;
  const support =
    lifecycle.phase === "accepted" || lifecycle.phase === "withdrawn"
      ? state.assignments.find((entry) => entry.id === lifecycle.support?.assignmentId)
      : undefined;
  const originManager = state.managers.find((entry) => entry.id === request.originManagerId);
  const receiver = state.managers.find((entry) => entry.id === request.receiverManagerId);
  const inbound = manager.id === request.receiverManagerId;
  const candidates = state.assignments.filter(
    (entry) =>
      entry.managerId === request.receiverManagerId &&
      entry.kind !== "onboarding" &&
      entry.status !== "complete" &&
      !entry.outcome &&
      (!entry.completion || entry.completion.phase === "collecting"),
  );
  const existing = candidates.find((entry) => entry.id === supportId);
  const participants = source && support ? [source, support] : [];
  const from = participants.find((entry) => entry.id === fromId);
  const to = participants.find((entry) => entry.id !== fromId);
  const messages = state.collaborationMessages.filter((entry) => entry.requestId === request.id);
  const plans = state.collaborationPlans.filter((entry) => entry.requestIds.includes(request.id));
  const reconsider =
    request.lifecycle.phase === "deferred" || request.lifecycle.phase === "declined"
      ? request.lifecycle.reconsider
      : null;
  const submit = (operation: Parameters<typeof command.submit>[0]) =>
    void command.submit(operation).then((saved) => {
      if (saved) setAction(null);
    });
  return (
    <details className="border-b border-border pb-3">
      <summary className="cursor-pointer space-y-1 py-2 text-sm">
        <span className="font-medium">{request.outcome}</span>
        <span className="ml-2 inline-flex">
          <Badge
            variant={
              request.lifecycle.phase === "deferred" || request.lifecycle.phase === "declined"
                ? "warning"
                : "outline"
            }
          >
            {request.lifecycle.phase}
          </Badge>
        </span>
        <span className="block text-xs text-muted-foreground">
          {originManager?.name ?? request.originManagerId} →{" "}
          {receiver?.name ?? request.receiverManagerId} · {request.id}
        </span>
      </summary>
      <div className="space-y-4 pt-2">
        <dl className="space-y-2 text-sm">
          <div>
            <dt className="font-medium">Acceptance conditions</dt>
            <dd className="whitespace-pre-wrap text-muted-foreground">
              {request.acceptanceConditions}
            </dd>
          </div>
          <div>
            <dt className="font-medium">Compatibility commitments</dt>
            <dd className="whitespace-pre-wrap text-muted-foreground">{request.compatibility}</dd>
          </div>
        </dl>
        <div className="flex flex-wrap gap-2">
          {source ? (
            <Button
              size="xs"
              variant="outline"
              disabled={!canOpenThread(source.threadId)}
              onClick={() => onOpenThread(source.threadId)}
            >
              Open requesting lead · {source.title ?? source.id}
            </Button>
          ) : (
            <span className="text-sm text-muted-foreground">
              Origin investigation ·{" "}
              {origin.kind === "investigation" ? origin.investigationId : origin.assignmentId}
            </span>
          )}
          {support ? (
            <Button
              size="xs"
              variant="outline"
              disabled={!canOpenThread(support.threadId)}
              onClick={() => onOpenThread(support.threadId)}
            >
              Open supporting lead · {support.title ?? support.id}
            </Button>
          ) : null}
        </div>
        {request.originalLeadThreadId ? (
          <p className="break-all text-xs text-muted-foreground">
            Original requesting lead · {request.originalLeadThreadId}
            {source?.threadId !== request.originalLeadThreadId
              ? ` · current lead ${source?.threadId ?? "unavailable"}`
              : ""}
          </p>
        ) : null}
        {"reason" in request.lifecycle ? (
          <p className="whitespace-pre-wrap text-sm">{request.lifecycle.reason}</p>
        ) : null}
        {request.lifecycle.phase === "declined" ? (
          <p className="text-sm text-muted-foreground">
            Alternative · {request.lifecycle.alternative}
          </p>
        ) : null}
        {reconsider ? (
          <p className="text-sm text-muted-foreground">
            Reconsider {factoryCollaborationConditionLabel(state, reconsider).toLowerCase()}. The
            host reopens the request when that event is recorded.
          </p>
        ) : null}
        {request.lifecycle.phase === "accepted" ? (
          <p className="text-sm text-muted-foreground">
            {request.lifecycle.support.dedicated
              ? "Support was commissioned for this request. It stops on withdrawal only when no other active request depends on it."
              : "This existing team retains its independent work when this request is withdrawn."}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {inbound && request.lifecycle.phase === "requested" ? (
            <>
              {(
                [
                  ["new", "Commission support"],
                  ["existing", "Use existing team"],
                  ["defer", "Defer"],
                  ["decline", "Decline"],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  size="xs"
                  variant="outline"
                  disabled={command.disabled}
                  onClick={() => setAction(value)}
                >
                  {label}
                </Button>
              ))}
            </>
          ) : null}
          {request.lifecycle.phase === "deferred" || request.lifecycle.phase === "declined" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={command.disabled}
              onClick={() =>
                submit({ type: "collaboration.request.reconsider", requestId: request.id })
              }
            >
              {inbound ? "Reconsider now" : "Ask again"}
            </Button>
          ) : null}
          {request.lifecycle.phase === "accepted" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={command.disabled}
              onClick={() => setAction("amend")}
            >
              Amend commitments
            </Button>
          ) : null}
          {!inbound && request.lifecycle.phase !== "withdrawn" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={command.disabled}
              onClick={() => setAction("withdraw")}
            >
              Withdraw request
            </Button>
          ) : null}
        </div>
        {action === "new" && receiver ? (
          <FactoryCollaborationWorkForm
            boundary={state.boundaries.find((entry) => entry.id === receiver.boundaryId)}
            outcome={request.outcome}
            acceptance={request.acceptanceConditions}
            disabled={command.disabled}
            onSubmit={(work) =>
              submit({
                type: "collaboration.request.respond",
                requestId: request.id,
                response: { kind: "accept", support: { kind: "commission", work } },
              })
            }
          />
        ) : null}
        {action === "existing" ? (
          <div className="space-y-3">
            <Label htmlFor={`${prefix}-support`}>Receiving manager's active team</Label>
            <Select
              value={supportId}
              disabled={command.disabled}
              items={candidates.map((entry) => ({
                value: entry.id,
                label: entry.title ?? entry.id,
              }))}
              onValueChange={(value) => {
                setSupportId(value);
                setAcknowledged(false);
              }}
            >
              <SelectTrigger id={`${prefix}-support`}>
                <SelectValue placeholder="Select existing supporting work" />
              </SelectTrigger>
              <SelectPopup>
                {candidates.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.title ?? entry.id}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {existing ? (
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {existing.scope?.description} · Completion: {existing.scope?.completionCondition}
              </p>
            ) : null}
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={acknowledged}
                disabled={command.disabled || !existing}
                onCheckedChange={setAcknowledged}
              />
              The team's existing scope covers this request without expanding its permissions.
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={command.disabled || !existing || !acknowledged}
              onClick={() => {
                if (existing)
                  submit({
                    type: "collaboration.request.respond",
                    requestId: request.id,
                    response: {
                      kind: "accept",
                      support: { kind: "existing", assignmentId: existing.id },
                    },
                  });
              }}
            >
              Accept with existing team
            </Button>
          </div>
        ) : null}
        {action === "defer" || action === "decline" || action === "withdraw" ? (
          <div className="space-y-3">
            <Label htmlFor={`${prefix}-reason`}>Concrete reason (required)</Label>
            <Textarea
              id={`${prefix}-reason`}
              value={reason}
              disabled={command.disabled}
              maxLength={6000}
              onChange={(event) => setReason(event.target.value)}
            />
            {action === "decline" ? (
              <>
                <Label htmlFor={`${prefix}-alternative`}>Proposed alternative (required)</Label>
                <Textarea
                  id={`${prefix}-alternative`}
                  value={alternative}
                  disabled={command.disabled}
                  maxLength={6000}
                  onChange={(event) => setAlternative(event.target.value)}
                />
              </>
            ) : null}
            {action === "defer" || action === "decline" ? (
              <FactoryCollaborationCondition
                state={state}
                value={condition}
                onChange={setCondition}
                disabled={command.disabled}
                label={
                  action === "defer"
                    ? "Reconsideration event (required)"
                    : "Reconsideration event (optional)"
                }
              />
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={
                command.disabled ||
                !reason.trim() ||
                (action === "defer" && !condition) ||
                (action === "decline" && !alternative.trim())
              }
              onClick={() => {
                if (action === "withdraw")
                  submit({
                    type: "collaboration.request.withdraw",
                    requestId: request.id,
                    reason: reason.trim(),
                  });
                else if (action === "defer" && condition)
                  submit({
                    type: "collaboration.request.respond",
                    requestId: request.id,
                    response: { kind: "defer", reason: reason.trim(), reconsider: condition },
                  });
                else if (action === "decline")
                  submit({
                    type: "collaboration.request.respond",
                    requestId: request.id,
                    response: {
                      kind: "decline",
                      reason: reason.trim(),
                      alternative: alternative.trim(),
                      reconsider: condition,
                    },
                  });
              }}
            >
              Confirm {action}
            </Button>
          </div>
        ) : null}
        {action === "amend" ? (
          <AmendForm
            request={request}
            disabled={command.disabled}
            onSubmit={(amendment, why) =>
              submit({
                type: "collaboration.plan.propose",
                requestIds: [request.id],
                text: `Amend the recorded commitments of request ${request.id}.`,
                changes: { kind: "boundary", reason: why, amendments: [amendment] },
              })
            }
          />
        ) : null}
        {action ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={command.disabled}
            onClick={() => setAction(null)}
          >
            Cancel response
          </Button>
        ) : null}
        {request.lifecycle.phase === "accepted" && participants.length === 2 ? (
          <details className="space-y-3">
            <summary className="cursor-pointer text-sm font-medium">
              Lead communication and shared technical plans
            </summary>
            <p className="text-sm text-muted-foreground">
              Leads coordinate through this request. Outcome, compatibility, scope, permissions and
              resource changes require the owning managers' decision. Teams retain PR review
              ownership.
            </p>
            {messages.map((entry) => (
              <div key={entry.id} className="space-y-1 border-l border-border pl-3 text-sm">
                <p className="text-xs text-muted-foreground">
                  {entry.fromAssignmentId} → {entry.toAssignmentId} · {entry.delivery.phase}
                </p>
                <p className="whitespace-pre-wrap">{entry.text}</p>
                {entry.delivery.phase === "failed" ? (
                  <>
                    <p role="alert" className="text-destructive">
                      {entry.delivery.reason}
                    </p>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={command.disabled}
                      onClick={() =>
                        submit({ type: "collaboration.message.retry", messageId: entry.id })
                      }
                    >
                      Retry this message
                    </Button>
                  </>
                ) : null}
              </div>
            ))}
            <Label htmlFor={`${prefix}-from`}>Coordinate from team</Label>
            <Select
              value={fromId}
              disabled={command.disabled}
              items={participants.map((entry) => ({
                value: entry.id,
                label: entry.title ?? entry.id,
              }))}
              onValueChange={setFromId}
            >
              <SelectTrigger id={`${prefix}-from`}>
                <SelectValue placeholder="Select sending team" />
              </SelectTrigger>
              <SelectPopup>
                {participants.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.title ?? entry.id}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Label htmlFor={`${prefix}-message`}>Message to the other lead</Label>
            <Textarea
              id={`${prefix}-message`}
              value={message}
              disabled={command.disabled}
              maxLength={6000}
              onChange={(event) => setMessage(event.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={command.disabled || !from || !to || !message.trim()}
              onClick={() => {
                if (from && to)
                  void command
                    .submit({
                      type: "collaboration.message.send",
                      requestId: request.id,
                      fromAssignmentId: from.id,
                      toAssignmentId: to.id,
                      text: message.trim(),
                    })
                    .then((saved) => {
                      if (saved) setMessage("");
                    });
              }}
            >
              Send to peer lead
            </Button>
          </details>
        ) : null}
        {plans.map((plan) => (
          <div key={plan.id} className="space-y-2 border-t border-border pt-3 text-sm">
            <p className="font-medium">
              Shared plan · {factoryCollaborationPlanStatus(state, plan)}
            </p>
            {factoryCollaborationPlanStatus(state, plan) === "stale" ? (
              <p className="text-muted-foreground">
                A participating lead, scope or permission grant changed. Record a new shared plan
                before treating this agreement as current.
              </p>
            ) : factoryCollaborationPlanStatus(state, plan) === "unverified" ? (
              <p className="text-muted-foreground">
                Some participant details are unavailable in this view. Current agreement cannot be
                confirmed here.
              </p>
            ) : null}
            <p className="whitespace-pre-wrap">{plan.text}</p>
            {plan.changes.kind === "boundary" ? (
              <PlanDecision environment={environment} plan={plan} request={request} />
            ) : null}
            <p className="text-xs text-muted-foreground">
              {plan.acknowledgements.length} of {plan.participants.length} teams acknowledged ·{" "}
              {plan.id}
            </p>
          </div>
        ))}
        {command.pending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Saving collaboration update…
          </p>
        ) : null}
        {command.error ? (
          <p role="alert" className="text-sm text-destructive">
            {command.error}
          </p>
        ) : null}
      </div>
    </details>
  );
}

function AmendForm({
  request,
  disabled,
  onSubmit,
}: {
  request: FactoryCrossProjectRequest;
  disabled: boolean;
  onSubmit: (
    amendment: {
      requestId: string;
      outcome: string;
      acceptanceConditions: string;
      compatibility: string;
    },
    reason: string,
  ) => void;
}) {
  const prefix = useId();
  const [outcome, setOutcome] = useState(request.outcome);
  const [acceptance, setAcceptance] = useState(request.acceptanceConditions);
  const [compatibility, setCompatibility] = useState(request.compatibility);
  const [reason, setReason] = useState("");
  const fields = [
    ["outcome", "Requested outcome", outcome, setOutcome],
    ["acceptance", "Acceptance conditions", acceptance, setAcceptance],
    ["compatibility", "Compatibility commitments", compatibility, setCompatibility],
    ["reason", "Why the commitments change (required)", reason, setReason],
  ] as const;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Both owning managers, or you, approve the amendment before it replaces the recorded
        commitments. The supporting work continues.
      </p>
      {fields.map(([key, label, value, set]) => (
        <div key={key} className="space-y-1">
          <Label htmlFor={`${prefix}-${key}`}>{label}</Label>
          <Textarea
            id={`${prefix}-${key}`}
            value={value}
            disabled={disabled}
            maxLength={6000}
            onChange={(event) => set(event.target.value)}
          />
        </div>
      ))}
      <Button
        size="sm"
        variant="outline"
        disabled={
          disabled ||
          !outcome.trim() ||
          !acceptance.trim() ||
          !compatibility.trim() ||
          !reason.trim()
        }
        onClick={() =>
          onSubmit(
            {
              requestId: request.id,
              outcome: outcome.trim(),
              acceptanceConditions: acceptance.trim(),
              compatibility: compatibility.trim(),
            },
            reason.trim(),
          )
        }
      >
        Propose amendment
      </Button>
    </div>
  );
}

function PlanDecision({
  environment,
  plan,
  request,
}: {
  environment: FactoryEnvironmentView;
  plan: FactoryCollaborationPlan;
  request: FactoryCrossProjectRequest;
}) {
  const prefix = useId();
  const command = useFactoryCommand(environment);
  const [reason, setReason] = useState("");
  const state = environment.data;
  if (plan.changes.kind !== "boundary") return null;
  const name = (id: ThreadId | null) =>
    id === null ? "You" : (state?.managers.find((entry) => entry.id === id)?.name ?? id);
  const amendment = plan.changes.amendments?.find((entry) => entry.requestId === request.id);
  return (
    <div className="space-y-2">
      <p className="text-muted-foreground">Owner decision · {plan.changes.reason}</p>
      {amendment ? (
        <dl className="space-y-1 text-muted-foreground">
          <div>
            <dt className="font-medium">Amended outcome</dt>
            <dd className="whitespace-pre-wrap">{amendment.outcome}</dd>
          </div>
          <div>
            <dt className="font-medium">Amended acceptance</dt>
            <dd className="whitespace-pre-wrap">{amendment.acceptanceConditions}</dd>
          </div>
          <div>
            <dt className="font-medium">Amended compatibility</dt>
            <dd className="whitespace-pre-wrap">{amendment.compatibility}</dd>
          </div>
        </dl>
      ) : null}
      {plan.approvals?.length ? (
        <p className="text-xs text-muted-foreground">
          Approved by {plan.approvals.map((entry) => name(entry.managerId)).join(", ")}
        </p>
      ) : null}
      {plan.declined ? (
        <p className="text-muted-foreground">
          Declined by {name(plan.declined.managerId)} · {plan.declined.reason}
        </p>
      ) : null}
      {plan.phase === "escalated" ? (
        <>
          <Button
            size="xs"
            variant="outline"
            disabled={command.disabled}
            onClick={() =>
              void command.submit({
                type: "collaboration.plan.decide",
                planId: plan.id,
                decision: { kind: "approve" },
              })
            }
          >
            Approve plan
          </Button>
          <Label htmlFor={`${prefix}-decline`}>Reason to decline</Label>
          <Textarea
            id={`${prefix}-decline`}
            value={reason}
            disabled={command.disabled}
            maxLength={6000}
            onChange={(event) => setReason(event.target.value)}
          />
          <Button
            size="xs"
            variant="outline"
            disabled={command.disabled || !reason.trim()}
            onClick={() =>
              void command.submit({
                type: "collaboration.plan.decide",
                planId: plan.id,
                decision: { kind: "decline", reason: reason.trim() },
              })
            }
          >
            Decline plan
          </Button>
        </>
      ) : null}
      {command.error ? (
        <p role="alert" className="text-destructive">
          {command.error}
        </p>
      ) : null}
    </div>
  );
}
