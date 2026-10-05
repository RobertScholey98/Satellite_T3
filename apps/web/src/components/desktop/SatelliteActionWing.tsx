import type {
  SatelliteAttentionEditor,
  SatelliteAttentionIntent,
  SatelliteAttentionSummary,
  SatelliteAttentionView,
  SatellitePillLayout,
} from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  BellOffIcon,
  ChevronLeftIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
  XIcon,
} from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { hasPendingQuestionAttachments, pendingRequestKey } from "../../pendingRequestStore";
import {
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
} from "../../pendingUserInput";
import { ComposerPendingApprovalActions } from "../chat/ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "../chat/ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "../chat/ComposerPendingUserInputPanel";
import { Button } from "../ui/button";

function RequestEditor({
  editor,
  item,
  dispatch,
  panel,
}: {
  editor: SatelliteAttentionEditor;
  item: SatelliteAttentionSummary;
  dispatch: (intent: SatelliteAttentionIntent) => void;
  panel: HTMLElement | null;
}) {
  const busy =
    editor.delivery === "sending" ||
    editor.delivery === "awaiting-resolution" ||
    editor.delivery === "uncertain";
  const attachments = hasPendingQuestionAttachments(editor.answers);
  const disabled = busy || editor.status !== "ready" || !item.available || attachments;
  const answers = editor.answers;
  const question = editor.question;
  const progress = question
    ? derivePendingUserInputProgress(question.questions, answers, editor.questionIndex)
    : null;
  const advance = () => {
    if (disabled || editor.ref.kind !== "question") return;
    dispatch({ type: "advance", ref: editor.ref });
  };
  const answerInput = useRef<HTMLTextAreaElement>(null);
  return (
    <>
      {editor.status === "loading" ? <p role="status">Loading request...</p> : null}
      {editor.status === "unavailable" ? (
        <p role="status" data-satellite="request-message">
          This environment is offline or synchronizing. Your draft is saved.
        </p>
      ) : null}
      {editor.status === "resolved" ? (
        <p role="status">
          This request is no longer pending. It may have been answered on another device.
        </p>
      ) : null}
      {attachments ? (
        <p role="status" data-satellite="request-message">
          This answer includes attachments. Open in thread to send them with your response.
        </p>
      ) : null}
      {question && editor.ref.kind === "question" ? (
        <>
          <ComposerPendingUserInputPanel
            pendingUserInputs={[question]}
            respondingRequestIds={disabled ? [question.requestId] : []}
            answers={answers}
            questionIndex={editor.questionIndex}
            onToggleOption={(questionId, value) => {
              const field = question.questions.find((entry) => entry.id === questionId);
              if (disabled || !field || editor.ref.kind !== "question") return;
              if (answerInput.current) answerInput.current.value = "";
              dispatch({ type: "toggle-option", ref: editor.ref, questionId, optionValue: value });
            }}
            onAdvance={advance}
            onDismiss={() => {
              if (!disabled && editor.ref.kind === "question")
                dispatch({ type: "dismiss", ref: editor.ref });
            }}
          />
          {progress?.activeQuestion && progress.activeQuestion.allowCustomAnswer !== false ? (
            <label data-satellite="custom-answer">
              <span>
                {progress.activeQuestion.options.length
                  ? "Or write your own answer"
                  : "Your answer"}
              </span>
              <textarea
                ref={answerInput}
                key={`${pendingRequestKey(editor.ref)}:${progress.activeQuestion.id}`}
                rows={3}
                disabled={disabled}
                defaultValue={progress.customAnswer}
                onChange={(event) => {
                  if (editor.ref.kind !== "question" || !progress.activeQuestion) return;
                  dispatch({
                    type: "answer",
                    ref: editor.ref,
                    questionId: progress.activeQuestion.id,
                    answer: setPendingUserInputCustomAnswer(
                      answers[progress.activeQuestion.id],
                      event.target.value,
                    ),
                  });
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    advance();
                  }
                }}
              />
            </label>
          ) : null}
          <div data-satellite="response-actions">
            {editor.questionIndex > 0 ? (
              <Button
                variant="ghost"
                size="xs"
                disabled={disabled}
                onClick={() => {
                  if (editor.ref.kind === "question")
                    dispatch({
                      type: "question-index",
                      ref: editor.ref,
                      index: editor.questionIndex - 1,
                    });
                }}
              >
                <ChevronLeftIcon />
                Back
              </Button>
            ) : null}
            <span data-satellite="question-progress">
              {question.questions.length > 1
                ? `${editor.questionIndex + 1} of ${question.questions.length}`
                : ""}
            </span>
            <Button
              size="xs"
              disabled={
                disabled ||
                !progress?.canAdvance ||
                (progress.isLastQuestion && !progress.isComplete)
              }
              onClick={advance}
            >
              {progress?.isLastQuestion ? "Send answer" : "Next question"}
            </Button>
          </div>
        </>
      ) : null}
      {editor.approval && editor.ref.kind === "approval" ? (
        <>
          <ComposerPendingApprovalPanel approval={editor.approval} pendingCount={1} />
          <div data-satellite="response-actions">
            <ComposerPendingApprovalActions
              requestId={editor.approval.requestId}
              isResponding={disabled}
              options={editor.approval.options}
              collisionBoundary={panel ?? undefined}
              onRespondToApproval={async (_id, decision) => {
                if (editor.ref.kind === "approval")
                  dispatch({ type: "approve", ref: editor.ref, decision });
              }}
            />
          </div>
        </>
      ) : null}
      {editor.ref.kind === "error" || editor.ref.kind === "review" ? (
        <section>
          <h3>{item.label}</h3>
          <p>{item.preview}</p>
        </section>
      ) : null}
      {editor.message ? (
        <p role="alert" data-satellite="request-error">
          {editor.message}
        </p>
      ) : null}
      {busy ? (
        <div role="status" data-satellite="delivery">
          <p>
            {editor.delivery === "uncertain"
              ? "Delivery is unconfirmed. Your response is saved."
              : editor.delivery === "sending"
                ? "Sending your response..."
                : "Waiting for the agent to confirm your response."}
          </p>
          {editor.delivery !== "sending" ? (
            <div data-satellite="response-actions">
              <Button
                size="xs"
                variant="outline"
                disabled={!item.available}
                onClick={() => dispatch({ type: "check-status", ref: editor.ref })}
              >
                Check status
              </Button>
              {editor.delivery === "uncertain" &&
              (editor.ref.kind === "question" || editor.ref.kind === "approval") ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!item.available}
                  onClick={() => {
                    if (editor.ref.kind === "question" || editor.ref.kind === "approval")
                      dispatch({ type: "retry-delivery", ref: editor.ref });
                  }}
                >
                  Retry saved response
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export function SatelliteActionPanel({
  view,
  layout,
  dispatch,
  close,
}: {
  view: SatelliteAttentionView;
  layout: SatellitePillLayout;
  dispatch: (intent: SatelliteAttentionIntent) => void;
  close: () => void;
}) {
  const [showMuted, setShowMuted] = useState(
    () => view.items.length > 0 && view.items.every((item) => item.muted),
  );
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const visible = view.items.filter((item) => !item.muted);
  const muted = view.items.filter((item) => item.muted);
  const selected = view.selected;
  const selectedKey = selected ? pendingRequestKey(selected.ref) : null;
  const item = visible.find((entry) => pendingRequestKey(entry.ref) === selectedKey);
  useLayoutEffect(() => {
    closeButton.current?.focus();
  }, []);
  return (
    <div
      ref={setPanel}
      data-satellite="action-panel"
      role="dialog"
      aria-modal="true"
      aria-label="Requests needing attention"
      style={
        layout.panel
          ? {
              left: layout.panel.x,
              top: layout.panel.y,
              width: layout.panel.width,
              height: layout.panel.height,
            }
          : undefined
      }
      onKeyDown={(event) => {
        if (event.defaultPrevented || document.querySelector('[role="menu"]')) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
        if (event.key === "Tab" && panel) {
          const controls = [
            ...panel.querySelectorAll<HTMLElement>(
              'button:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
            ),
          ].filter((control) => control.getClientRects().length > 0);
          const first = controls[0];
          const last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <div data-satellite="panel-content">
        <header data-satellite="panel-header">
          <strong>{showMuted ? "Muted requests" : "Needs your attention"}</strong>
          <span>{showMuted ? muted.length : visible.length}</span>
          <button ref={closeButton} type="button" aria-label="Close requests" onClick={close}>
            <XIcon />
          </button>
        </header>
        {view.incompleteEnvironments.length ? (
          <p data-satellite="coverage" role="status">
            Request count is incomplete for {view.incompleteEnvironments.join(", ")}. Open the
            workspace to check those environments.
          </p>
        ) : null}
        {!showMuted && visible.length > 1 ? (
          <div data-satellite="request-tabs" role="tablist" aria-label="Pending requests">
            {visible.map((entry, index) => {
              const key = pendingRequestKey(entry.ref);
              const active = selectedKey === key;
              return (
                <button
                  key={key}
                  role="tab"
                  id={`satellite-tab-${index}`}
                  aria-controls="satellite-request-content"
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  type="button"
                  onClick={() => dispatch({ type: "select", ref: entry.ref })}
                  onKeyDown={(event) => {
                    const nextIndex =
                      event.key === "ArrowRight"
                        ? (index + 1) % visible.length
                        : event.key === "ArrowLeft"
                          ? (index + visible.length - 1) % visible.length
                          : event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? visible.length - 1
                              : null;
                    if (nextIndex === null) return;
                    event.preventDefault();
                    const next = visible[nextIndex];
                    if (next) {
                      dispatch({ type: "select", ref: next.ref });
                      document.getElementById(`satellite-tab-${nextIndex}`)?.focus();
                    }
                  }}
                >
                  {entry.ref.kind === "approval" ? (
                    <ShieldQuestionIcon />
                  ) : (
                    <MessageCircleQuestionIcon />
                  )}
                  <span>{entry.label}</span>
                </button>
              );
            })}
          </div>
        ) : null}
        <div
          data-satellite="request-body"
          id="satellite-request-content"
          role={visible.length > 1 && !showMuted ? "tabpanel" : undefined}
          aria-labelledby={
            visible.length > 1 && item && !showMuted
              ? `satellite-tab-${visible.indexOf(item)}`
              : undefined
          }
        >
          {showMuted ? (
            <>
              <p>Muted requests stay open in Satellite.</p>
              {muted.map((entry) => (
                <div data-satellite="muted-row" key={pendingRequestKey(entry.ref)}>
                  <div>
                    <strong>{entry.title}</strong>
                    <p>
                      {entry.environmentName} · {entry.label}
                    </p>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      dispatch({ type: "restore", ref: entry.ref });
                      setShowMuted(false);
                    }}
                  >
                    Restore
                  </Button>
                </div>
              ))}
              {!muted.length ? <p>No muted requests.</p> : null}
            </>
          ) : selected && item ? (
            <>
              <div data-satellite="request-context">
                <span>{item.environmentName}</span>
                <strong>{item.title}</strong>
              </div>
              <RequestEditor
                key={selectedKey}
                editor={selected}
                item={item}
                dispatch={dispatch}
                panel={panel}
              />
              <div data-satellite="request-footer">
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => dispatch({ type: "mute", ref: item.ref })}
                >
                  <BellOffIcon />
                  Mute in pill
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => dispatch({ type: "open-thread", ref: item.ref })}
                >
                  Open in thread
                  <ArrowUpRightIcon />
                </Button>
              </div>
            </>
          ) : (
            <p>
              {view.incompleteEnvironments.length
                ? "No known requests need your attention."
                : "No requests need your attention."}
            </p>
          )}
        </div>
        {muted.length || showMuted ? (
          <footer data-satellite="muted-footer">
            <button type="button" onClick={() => setShowMuted((current) => !current)}>
              {showMuted
                ? "Back to requests"
                : `${muted.length} muted ${muted.length === 1 ? "request" : "requests"}`}
            </button>
          </footer>
        ) : null}
      </div>
    </div>
  );
}
