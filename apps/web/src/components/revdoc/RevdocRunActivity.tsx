import { useAtomValue } from "@effect/atom-react";
import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  RevdocTestingRun,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  derivePendingRequests,
  type PendingUserInput,
} from "@t3tools/client-runtime/pending-requests";
import { extractCommandOutputText } from "@t3tools/client-runtime/work-log/presentation";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo, useState } from "react";
import { legacyRevdocTestingThreads, revdocTestingThreads } from "~/state/revdoc";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  buildPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "~/pendingUserInput";
import { ComposerPendingApprovalPanel } from "../chat/ComposerPendingApprovalPanel";
import { ComposerPendingApprovalActions } from "../chat/ComposerPendingApprovalActions";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

function TestingQuestion({
  prompt,
  threadRef,
  enabled,
}: {
  prompt: PendingUserInput;
  threadRef: ScopedThreadRef;
  enabled: boolean;
}) {
  const respond = useAtomCommand(threadEnvironment.respondToUserInput, { reportFailure: true });
  const dismiss = useAtomCommand(threadEnvironment.dismissUserInput, { reportFailure: true });
  const [answers, setAnswers] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [pending, setPending] = useState(false);
  const submit = async (skip: boolean) => {
    const values = buildPendingUserInputAnswers(prompt.questions, answers);
    if (pending || !enabled || (!skip && !values)) return;
    setPending(true);
    if (skip)
      await dismiss({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, requestId: prompt.requestId },
      });
    else if (values)
      await respond({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, requestId: prompt.requestId, answers: values },
      });
    setPending(false);
  };
  return (
    <div className="space-y-3 border-t border-border/60 pt-3">
      <Badge variant="warning">Testing agent needs your input</Badge>
      {prompt.questions.map((question) => (
        <fieldset key={question.id} className="space-y-2" disabled={pending || !enabled}>
          <legend className="mb-2 text-sm">{question.question}</legend>
          <div className="flex flex-wrap gap-2">
            {question.options.map((option) => (
              <Button
                key={option.label}
                size="xs"
                variant={
                  answers[question.id]?.selectedOptionValues?.includes(option.label)
                    ? "secondary"
                    : "outline"
                }
                aria-pressed={
                  answers[question.id]?.selectedOptionValues?.includes(option.label) ?? false
                }
                onClick={() =>
                  setAnswers((current) => ({
                    ...current,
                    [question.id]: togglePendingUserInputOptionSelection(
                      question,
                      current[question.id],
                      option.label,
                    ),
                  }))
                }
              >
                {option.label}
              </Button>
            ))}
          </div>
          {question.allowCustomAnswer !== false && (
            <Textarea
              size="sm"
              aria-label={`Answer: ${question.question}`}
              placeholder="Your answer…"
              value={answers[question.id]?.customAnswer ?? ""}
              onChange={(event) =>
                setAnswers((current) => ({
                  ...current,
                  [question.id]: setPendingUserInputCustomAnswer(
                    current[question.id],
                    event.target.value,
                  ),
                }))
              }
            />
          )}
        </fieldset>
      ))}
      <div className="flex gap-2">
        <Button
          size="xs"
          disabled={!enabled || pending || !buildPendingUserInputAnswers(prompt.questions, answers)}
          onClick={() => void submit(false)}
        >
          Send answer
        </Button>
        {prompt.dismissible && (
          <Button
            size="xs"
            variant="ghost"
            disabled={!enabled || pending}
            onClick={() => void submit(true)}
          >
            Dismiss
          </Button>
        )}
      </div>
    </div>
  );
}

/** A background run's transcript and prompts stay inside the owning worktree's review. */
export function RevdocRunActivity({
  run,
  threadRef,
}: {
  run: RevdocTestingRun;
  threadRef: ScopedThreadRef;
}) {
  const state = useAtomValue(
    (run.audience === "revdoc" ? revdocTestingThreads : legacyRevdocTestingThreads).stateAtom(
      threadRef.environmentId,
      run.threadId,
    ),
  );
  const data = Option.getOrNull(AsyncResult.value(state));
  const thread = data ? Option.getOrNull(data.data) : null;
  const pending = derivePendingRequests(thread?.activities ?? []);
  const respond = useAtomCommand(threadEnvironment.respondToApproval, { reportFailure: true });
  const [responding, setResponding] = useState<ApprovalRequestId | null>(null);
  const [expanded, setExpanded] = useState(false);
  const testRef = useMemo(
    () => ({ ...threadRef, threadId: run.threadId }),
    [threadRef, run.threadId],
  );
  const canRespond = run.status === "running" && data?.status === "live";
  const approval = pending.approvals[0];
  const respondToApproval = async (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => {
    if (responding || !canRespond) return;
    setResponding(requestId);
    await respond({
      environmentId: testRef.environmentId,
      input: { threadId: testRef.threadId, requestId, decision },
    });
    setResponding(null);
  };
  const activities = (thread?.activities ?? []).slice(-30).toReversed();
  const assistant = thread?.messages.filter((message) => message.role === "assistant").slice(-3);
  const latest = activities[0]?.summary;
  return (
    <div className="space-y-3">
      {approval && run.status === "running" && (
        <div className="space-y-2 border-t border-border/60 pt-3">
          <Badge variant="warning">Waiting for approval</Badge>
          <ComposerPendingApprovalPanel
            approval={approval}
            pendingCount={pending.approvals.length}
          />
          <div className="flex flex-wrap gap-2">
            <ComposerPendingApprovalActions
              requestId={approval.requestId}
              options={approval.options}
              isResponding={responding !== null || !canRespond}
              onRespondToApproval={respondToApproval}
            />
          </div>
        </div>
      )}
      {run.status === "running" &&
        pending.userInputs.map((prompt) => (
          <TestingQuestion
            key={prompt.requestId}
            prompt={prompt}
            threadRef={testRef}
            enabled={canRespond}
          />
        ))}
      {run.status === "running" && !approval && pending.userInputs.length === 0 && (
        <p role="status" className="break-words text-xs text-muted-foreground">
          {latest ??
            (thread ? "Testing agent is preparing the checks…" : "Starting testing agent…")}
        </p>
      )}
      <Button
        size="xs"
        variant="ghost"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? "Hide agent activity" : "Show agent activity"}
      </Button>
      {expanded && (
        <div className="max-h-72 space-y-3 overflow-auto border-t border-border/60 pt-3 text-xs">
          {data && Option.isSome(data.error) && (
            <p role="alert" className="text-destructive">
              Could not load testing activity. Reconnect to this environment and reopen the review.
            </p>
          )}
          {!thread && (
            <p className="text-muted-foreground">
              {run.status === "running" || !data
                ? "Loading testing activity…"
                : "This agent’s activity is no longer available. Saved results and evidence remain in the review."}
            </p>
          )}
          {assistant?.map((message) => (
            <p key={message.id} className="whitespace-pre-wrap break-words leading-relaxed">
              {message.text.slice(-8_000)}
            </p>
          ))}
          {activities.map((activity) => {
            const output = extractCommandOutputText(activity.payload);
            return (
              <div key={activity.id} className="space-y-1 border-t border-border/40 pt-2">
                <p className="break-words">{activity.summary}</p>
                <time className="text-muted-foreground" dateTime={activity.createdAt}>
                  {new Date(activity.createdAt).toLocaleTimeString()}
                </time>
                {output && (
                  <details>
                    <summary className="cursor-pointer py-1 text-muted-foreground">Output</summary>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words">
                      {output.slice(-8_000)}
                    </pre>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
