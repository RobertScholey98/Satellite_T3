import type {
  DocumentAnswer,
  DocumentDetail,
  DocumentsHistoryResult,
  DocumentSummary,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  documentAnswersMarkdown,
  initialDocumentAnswers,
  isDocumentRevisionReadOnly,
} from "@t3tools/client-runtime/documents";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { FileTextIcon } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { documentsEnvironment } from "~/state/documents";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { MenuItem } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { BoundDocumentFrame } from "./BoundDocumentFrame";
import { randomUUID } from "~/lib/utils";

const OUTCOMES: { value: DocumentAnswer["outcome"]; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "complete", label: "Complete" },
  { value: "broken", label: "Broken" },
  { value: "change_requested", label: "Change requested" },
  { value: "skipped", label: "Skipped" },
];
function unwrap<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Success") return result.value;
  const error = squashAtomCommandFailure(result);
  throw error instanceof Error ? error : new Error(String(error));
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
interface ReviewDraft {
  readonly answers: readonly DocumentAnswer[];
  readonly answerVersion: number;
  readonly dirty: boolean;
}

export function ThreadDocuments({
  threadRef,
  presentation,
  onOpen,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly presentation: "menu" | "toolbar";
  readonly onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [documents, setDocuments] = useState<readonly DocumentSummary[]>([]);
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [history, setHistory] = useState<DocumentsHistoryResult | null>(null);
  const [answers, setAnswers] = useState<readonly DocumentAnswer[]>([]);
  const [answerVersion, setAnswerVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const drafts = useRef(new Map<string, ReviewDraft>());
  const requestGeneration = useRef(0);
  const busyRef = useRef(false);
  const mutationRequests = useRef(new Map<string, { identity: string; requestId: string }>());
  const list = useAtomCommand(documentsEnvironment.list, { reportFailure: false });
  const get = useAtomCommand(documentsEnvironment.get, { reportFailure: false });
  const getHistory = useAtomCommand(documentsEnvironment.history, { reportFailure: false });
  const save = useAtomCommand(documentsEnvironment.saveDraft, { reportFailure: false });
  const submit = useAtomCommand(documentsEnvironment.submit, { reportFailure: false });
  const retry = useAtomCommand(documentsEnvironment.retry, { reportFailure: false });
  const readOnly = detail !== null && isDocumentRevisionReadOnly(detail);
  const savedAnswers = useMemo(() => (detail ? initialDocumentAnswers(detail) : []), [detail]);
  const dirty =
    answers.length !== savedAnswers.length ||
    answers.some((answer, index) => {
      const saved = savedAnswers[index];
      return (
        !saved ||
        answer.itemId !== saved.itemId ||
        answer.outcome !== saved.outcome ||
        answer.notes !== saved.notes
      );
    });
  useLayoutEffect(() => {
    if (detail) drafts.current.set(detail.revision.id, { answers, answerVersion, dirty });
  }, [detail, answers, answerVersion, dirty]);

  const refreshList = useCallback(async () => {
    try {
      setDocuments(
        unwrap(
          await list({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId },
          }),
        ),
      );
    } catch (failure) {
      setError(errorText(failure));
    }
  }, [list, threadRef.environmentId, threadRef.threadId]);
  const selectRevision = async (documentId: string, revisionId?: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const generation = ++requestGeneration.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const [loaded, timeline] = await Promise.all([
        get({
          environmentId: threadRef.environmentId,
          input: { documentId, ...(revisionId ? { revisionId } : {}) },
        }).then(unwrap),
        getHistory({ environmentId: threadRef.environmentId, input: { documentId } }).then(unwrap),
      ]);
      if (generation !== requestGeneration.current) return;
      const retained = drafts.current.get(loaded.revision.id);
      const cached = retained?.dirty ? retained : undefined;
      setDetail(loaded);
      setHistory(timeline);
      setAnswers(cached?.answers ?? initialDocumentAnswers(loaded));
      setAnswerVersion(cached?.answerVersion ?? loaded.answerVersion);
      if (cached && cached.answerVersion !== loaded.answerVersion)
        setError(
          "The saved draft changed on another device. Your edits are still here. Load saved draft to replace them.",
        );
    } catch (failure) {
      if (generation === requestGeneration.current) setError(errorText(failure));
    } finally {
      if (generation === requestGeneration.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  const refreshHistory = async (documentId: string) => {
    const generation = requestGeneration.current;
    try {
      const refreshed = unwrap(
        await getHistory({ environmentId: threadRef.environmentId, input: { documentId } }),
      );
      if (generation === requestGeneration.current) setHistory(refreshed);
    } catch (failure) {
      if (generation === requestGeneration.current)
        setError(`Could not refresh review history: ${errorText(failure)}`);
    }
  };
  const nativeRequestId = (method: "save" | "submit") => {
    const identity = JSON.stringify({
      documentId: detail?.document.id,
      revisionId: detail?.revision.id,
      answerVersion,
      answers,
    });
    const previous = mutationRequests.current.get(method);
    if (previous?.identity === identity) return previous.requestId;
    const requestId = randomUUID();
    mutationRequests.current.set(method, { identity, requestId });
    return requestId;
  };
  const loadDraft = async () => {
    if (!detail) throw new Error("No document is selected.");
    if (busyRef.current)
      throw new Error("A document update is in progress. Try again after it finishes.");
    const generation = requestGeneration.current;
    const loaded = unwrap(
      await get({
        environmentId: threadRef.environmentId,
        input: { documentId: detail.document.id, revisionId: detail.revision.id },
      }),
    );
    if (generation === requestGeneration.current) {
      setDetail(loaded);
      if (!drafts.current.get(loaded.revision.id)?.dirty) {
        setAnswers(initialDocumentAnswers(loaded));
        setAnswerVersion(loaded.answerVersion);
        drafts.current.set(loaded.revision.id, {
          answers: initialDocumentAnswers(loaded),
          answerVersion: loaded.answerVersion,
          dirty: false,
        });
      }
    }
    return loaded;
  };
  const saveDraft = async (
    nextAnswers: readonly DocumentAnswer[],
    expectedAnswerVersion: number,
    requestId: string,
  ) => {
    if (!detail) throw new Error("No document is selected.");
    if (isDocumentRevisionReadOnly(detail))
      throw new Error("Submitted and historical revisions are read-only.");
    if (busyRef.current)
      throw new Error("A document update is already in progress. Try again after it finishes.");
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const saved = unwrap(
        await save({
          environmentId: threadRef.environmentId,
          input: {
            documentId: detail.document.id,
            revisionId: detail.revision.id,
            expectedAnswerVersion,
            requestId,
            answers: nextAnswers,
          },
        }),
      );
      setDetail(saved);
      setAnswers(initialDocumentAnswers(saved));
      setAnswerVersion(saved.answerVersion);
      drafts.current.set(saved.revision.id, {
        answers: initialDocumentAnswers(saved),
        answerVersion: saved.answerVersion,
        dirty: false,
      });
      setNotice("Draft saved. It has not been sent to the agent.");
      void refreshList();
      void refreshHistory(saved.document.id);
      return saved;
    } catch (failure) {
      setError(`${errorText(failure)} Your edits are still here.`);
      throw failure;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const submitReview = async () => {
    if (!detail || busyRef.current || readOnly) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const submitted = unwrap(
        await submit({
          environmentId: threadRef.environmentId,
          input: {
            documentId: detail.document.id,
            revisionId: detail.revision.id,
            expectedAnswerVersion: answerVersion,
            requestId: nativeRequestId("submit"),
            answers,
          },
        }),
      );
      setDetail({
        ...detail,
        document: { ...detail.document, status: "submitted" },
        lastSubmission: submitted,
        answers: submitted.answers,
        answerVersion: submitted.answerVersion,
      });
      setAnswerVersion(submitted.answerVersion);
      setAnswers(submitted.answers);
      setNotice(
        submitted.delivery === "delivered"
          ? "Review submitted to the agent."
          : submitted.delivery === "failed"
            ? "Review submitted. Agent delivery failed; retry delivery below."
            : "Review submitted. Agent delivery is pending.",
      );
      mutationRequests.current.delete("submit");
      void refreshList();
      void refreshHistory(detail.document.id);
    } catch (failure) {
      setError(`${errorText(failure)} Your edits are still here.`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const retryDelivery = async () => {
    if (!detail?.lastSubmission || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const sent = unwrap(
        await retry({
          environmentId: threadRef.environmentId,
          input: { submissionId: detail.lastSubmission.id },
        }),
      );
      setDetail({ ...detail, lastSubmission: sent });
      setNotice(`Agent delivery: ${sent.delivery}.`);
      void refreshHistory(detail.document.id);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const exportMarkdown = (localDraft = false) => {
    if (!detail) return;
    const markdown =
      !detail.revision.definition && detail.revision.format !== "html"
        ? detail.content
        : localDraft
          ? documentAnswersMarkdown(detail, answers)
          : (detail.lastSubmission?.markdown ??
            documentAnswersMarkdown(detail, readOnly ? savedAnswers : answers));
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${detail.document.title.replace(/[^a-zA-Z0-9_-]+/g, "-")}.md`;
    link.click();
    URL.revokeObjectURL(url);
  };
  const show = () => {
    setOpen(true);
    void refreshList();
    onOpen?.();
  };
  return (
    <>
      {presentation === "menu" ? (
        <MenuItem onClick={show}>
          <FileTextIcon />
          Documents
        </MenuItem>
      ) : (
        <Button size="sm" variant="ghost" onClick={show}>
          <FileTextIcon />
          Documents
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup
          variant="media"
          className="flex h-[85vh] w-[95vw] max-w-6xl flex-col"
          bottomStickOnMobile={false}
        >
          <DialogHeader>
            <DialogTitle>Thread documents</DialogTitle>
            <DialogDescription>
              Review a retained revision, save your draft, then submit it to the agent when ready.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <div className="flex flex-wrap items-center gap-2 px-6">
              <p role="alert" className="flex-1 text-sm text-destructive">
                {error}
              </p>
              {detail && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  title="Replace local edits with the currently saved draft"
                  onClick={() => {
                    drafts.current.delete(detail.revision.id);
                    void selectRevision(detail.document.id, detail.revision.id);
                  }}
                >
                  Load saved draft
                </Button>
              )}
            </div>
          )}
          {notice && (
            <p role="status" className="px-6 text-sm text-muted-foreground">
              {notice}
            </p>
          )}
          <div className="flex min-h-0 flex-1 max-sm:flex-col">
            <aside className="w-56 shrink-0 overflow-auto border-r p-4 max-sm:max-h-36 max-sm:w-full max-sm:border-r-0 max-sm:border-b">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  void refreshList();
                  if (detail) void selectRevision(detail.document.id, detail.revision.id);
                }}
              >
                Refresh documents
              </Button>
              {documents.length === 0 && (
                <p className="mt-4 text-sm text-muted-foreground">
                  No documents have been published to this thread.
                </p>
              )}
              <div className="mt-3 flex flex-col gap-2">
                {documents.map((entry) => (
                  <Button
                    key={entry.id}
                    size="sm"
                    variant={detail?.document.id === entry.id ? "secondary" : "ghost"}
                    disabled={busy}
                    onClick={() => void selectRevision(entry.id)}
                  >
                    <span className="min-w-0 truncate">
                      {entry.title} · {entry.status}
                    </span>
                  </Button>
                ))}
              </div>
            </aside>
            {detail ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex flex-wrap items-center gap-3 border-b p-4">
                  <h3 className="min-w-0 flex-1 truncate text-sm font-medium">
                    {detail.document.title}
                  </h3>
                  <div className="w-40">
                    <Select
                      value={detail.revision.id}
                      onValueChange={(value) => {
                        if (value) void selectRevision(detail.document.id, value);
                      }}
                      disabled={busy}
                    >
                      <SelectTrigger size="sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        {history?.revisions.map((revision) => (
                          <SelectItem key={revision.id} value={revision.id}>
                            Revision {revision.number}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => exportMarkdown()}>
                    Export Markdown
                  </Button>
                </div>
                <div className="flex min-h-0 flex-1 max-md:flex-col">
                  <div className="flex min-h-48 min-w-0 flex-1 flex-col">
                    {detail.revision.format === "html" ? (
                      <BoundDocumentFrame
                        key={`${detail.revision.id}:${readOnly}`}
                        detail={detail}
                        dirty={dirty}
                        saveDraft={saveDraft}
                        loadDraft={loadDraft}
                      />
                    ) : (
                      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-5 text-sm">
                        {detail.content}
                      </pre>
                    )}
                  </div>
                  <div className="w-80 shrink-0 overflow-auto border-l p-4 max-md:w-full max-md:border-t max-md:border-l-0">
                    {readOnly && (
                      <p className="mb-3 text-sm text-muted-foreground">
                        This retained revision is read-only.
                      </p>
                    )}
                    {(detail.revision.definition?.items ?? []).map((item) => {
                      const answer = (readOnly ? savedAnswers : answers).find(
                        (entry) => entry.itemId === item.id,
                      ) ?? {
                        itemId: item.id,
                        outcome: "pending" as const,
                        notes: "",
                      };
                      const update = (change: Partial<DocumentAnswer>) =>
                        setAnswers((current) =>
                          current.map((entry) =>
                            entry.itemId === item.id ? { ...entry, ...change } : entry,
                          ),
                        );
                      return (
                        <section key={item.id} className="mb-5 space-y-2">
                          <h4 className="text-sm font-medium">{item.title}</h4>
                          {item.description && (
                            <p className="text-xs text-muted-foreground">{item.description}</p>
                          )}
                          <Select
                            value={answer.outcome}
                            onValueChange={(value) => {
                              const outcome = OUTCOMES.find(
                                (entry) => entry.value === value,
                              )?.value;
                              if (outcome) update({ outcome });
                            }}
                            disabled={readOnly || busy}
                          >
                            <SelectTrigger size="sm" aria-label={`Outcome for ${item.title}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectPopup>
                              {OUTCOMES.map((entry) => (
                                <SelectItem key={entry.value} value={entry.value}>
                                  {entry.label}
                                </SelectItem>
                              ))}
                            </SelectPopup>
                          </Select>
                          <Textarea
                            size="sm"
                            aria-label={`Notes for ${item.title}`}
                            placeholder="Notes"
                            value={answer.notes}
                            disabled={readOnly || busy}
                            maxLength={8000}
                            onChange={(event) => update({ notes: event.target.value })}
                          />
                        </section>
                      );
                    })}
                    {!detail.revision.definition && (
                      <p className="text-sm text-muted-foreground">
                        This document has no review checklist.
                      </p>
                    )}
                    {detail.lastSubmission && (
                      <div className="space-y-2 border-t pt-3 text-sm">
                        <p>Agent delivery: {detail.lastSubmission.delivery}</p>
                        {detail.lastSubmission.deliveryError && (
                          <p className="text-destructive">{detail.lastSubmission.deliveryError}</p>
                        )}
                        {detail.lastSubmission.delivery !== "delivered" && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => void retryDelivery()}
                          >
                            Retry agent delivery
                          </Button>
                        )}
                      </div>
                    )}
                    {history && (
                      <details className="mt-5 text-xs text-muted-foreground">
                        <summary>Revision and review history</summary>
                        <ol className="mt-2 space-y-2">
                          {history.events.map((event) => (
                            <li key={event.id}>
                              {event.event} · {event.actor} · {event.createdAt}
                              <br />
                              {event.detail}
                              {event.answers && (
                                <details className="mt-1">
                                  <summary>Saved answers · version {event.answerVersion}</summary>
                                  <ul className="mt-2 space-y-2">
                                    {event.answers.map((answer) => {
                                      const revision = history.revisions.find(
                                        (entry) => entry.id === event.revisionId,
                                      );
                                      const title =
                                        revision?.definition?.items.find(
                                          (item) => item.id === answer.itemId,
                                        )?.title ?? answer.itemId;
                                      return (
                                        <li key={answer.itemId}>
                                          <p>
                                            {title} ·{" "}
                                            {OUTCOMES.find(
                                              (outcome) => outcome.value === answer.outcome,
                                            )?.label ?? answer.outcome}
                                          </p>
                                          {answer.notes && (
                                            <p className="whitespace-pre-wrap">{answer.notes}</p>
                                          )}
                                        </li>
                                      );
                                    })}
                                  </ul>
                                </details>
                              )}
                            </li>
                          ))}
                        </ol>
                      </details>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2 border-t p-4">
                  <span className="mr-auto text-xs text-muted-foreground">
                    {readOnly ? "Read-only revision" : dirty ? "Unsaved draft" : "Saved draft"}
                  </span>
                  {readOnly && dirty && (
                    <Button size="sm" variant="outline" onClick={() => exportMarkdown(true)}>
                      Export local draft
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={readOnly || busy}
                    onClick={() =>
                      void saveDraft(answers, answerVersion, nativeRequestId("save"))
                        .then(() => {
                          mutationRequests.current.delete("save");
                        })
                        .catch(() => undefined)
                    }
                  >
                    Save draft
                  </Button>
                  <Button size="sm" disabled={readOnly || busy} onClick={() => void submitReview()}>
                    Submit to agent
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
                {busy ? "Loading document…" : "Select a document to review."}
              </div>
            )}
          </div>
        </DialogPopup>
      </Dialog>
    </>
  );
}
