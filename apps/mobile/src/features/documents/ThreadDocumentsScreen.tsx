import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  documentAnswersMarkdown,
  documentBridgeInit,
  documentBridgeResponse,
  initialDocumentAnswers,
  isDocumentRevisionReadOnly,
  parseDocumentBridgeRequest,
  validateDocumentAnswers,
} from "@t3tools/client-runtime/documents";
import {
  EnvironmentId,
  ThreadId,
  type DocumentAnswer,
  type DocumentDetail,
  type DocumentSummary,
  type DocumentsHistoryResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { AppText, AppTextInput } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { ScreenHeader } from "../../components/ScreenHeader";
import { uuidv4 } from "../../lib/uuid";
import { documentsEnvironment } from "../../state/documents";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  documentWebViewHtml,
  documentWebViewResponse,
  isDocumentSnapshotNavigation,
} from "./documentWebView";
import { shareDocumentMarkdown } from "./shareDocumentMarkdown";
import {
  documentOperationAcknowledged,
  documentDraftHasChanges,
  documentMarkdownExport,
  prepareDocumentOperation,
  type DocumentDraft as Draft,
} from "./documentDraft";

const outcomeLabels = {
  pending: "Pending",
  complete: "Complete",
  broken: "Broken",
  change_requested: "Request changes",
  skipped: "Skipped",
} as const;
const outcomes = Object.keys(outcomeLabels) as Array<keyof typeof outcomeLabels>;

export function ThreadDocumentsScreen({
  route,
}: StaticScreenProps<{ environmentId: string; threadId: string }>) {
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const threadId = ThreadId.make(route.params.threadId);
  const list = useAtomCommand(documentsEnvironment.list, { reportFailure: false });
  const get = useAtomCommand(documentsEnvironment.get, { reportFailure: false });
  const getHistory = useAtomCommand(documentsEnvironment.history, { reportFailure: false });
  const [listed, setListed] = useState<{
    key: string;
    documents: readonly DocumentSummary[];
  } | null>(null);
  const [selection, setSelection] = useState<{ documentId: string; revisionId?: string } | null>(
    null,
  );
  const [loaded, setLoaded] = useState<{
    key: string;
    detail: DocumentDetail | null;
    history: DocumentsHistoryResult | null;
  } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const refresh = useCallback(() => setRefreshVersion((value) => value + 1), []);
  const listKey = JSON.stringify([environmentId, threadId, refreshVersion]);
  const loadKey = JSON.stringify([environmentId, threadId, selection, refreshVersion]);
  const currentLoadKey = useRef(loadKey);
  useEffect(() => {
    currentLoadKey.current = loadKey;
  }, [loadKey]);
  const documents = listed?.key === listKey ? listed.documents : [];
  const detail = loaded?.key === loadKey ? loaded.detail : null;
  const history = loaded?.key === loadKey ? loaded.history : null;
  const loading = selection !== null && loaded?.key !== loadKey;

  useEffect(() => {
    let active = true;
    void list({ environmentId, input: { threadId } }).then((result) => {
      if (!active) return;
      if (result._tag === "Success") setListed({ key: listKey, documents: result.value });
      else setError(Cause.pretty(result.cause));
    });
    return () => {
      active = false;
    };
  }, [environmentId, threadId, list, listKey]);

  useEffect(() => {
    if (!selection) return;
    let active = true;
    void Promise.all([
      get({ environmentId, input: selection }),
      getHistory({ environmentId, input: { documentId: selection.documentId } }),
    ]).then(([result, historyResult]) => {
      if (!active) return;
      setLoaded({
        key: loadKey,
        detail: result._tag === "Success" ? result.value : null,
        history: historyResult._tag === "Success" ? historyResult.value : null,
      });
      if (result._tag === "Failure") setError(Cause.pretty(result.cause));
      else if (historyResult._tag === "Failure") setError(Cause.pretty(historyResult.cause));
      else setError(null);
    });
    return () => {
      active = false;
    };
  }, [environmentId, selection, get, getHistory, loadKey]);

  const draftKey = detail
    ? `${environmentId}:${threadId}:${detail.document.id}:${detail.revision.id}`
    : "";
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title="Documents"
        onBack={() =>
          navigation.canGoBack()
            ? navigation.goBack()
            : navigation.dispatch(StackActions.replace("Thread", route.params))
        }
        actions={[
          { accessibilityLabel: "Refresh documents", icon: "arrow.clockwise", onPress: refresh },
        ]}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-4 p-4 pb-16"
      >
        <AppText className="text-foreground-muted">
          Retained documents for this chat. Saving answers keeps a draft; submitting sends a frozen
          result to the agent.
        </AppText>
        {error ? (
          <AppText accessibilityRole="alert" className="text-danger">
            {error}
          </AppText>
        ) : null}
        {!documents.length ? <AppText>No documents have been published yet.</AppText> : null}
        {documents.map((document) => (
          <Pressable
            accessibilityRole="button"
            key={document.id}
            onPress={() => setSelection({ documentId: document.id })}
            className="gap-1 rounded-xl border border-border p-4"
          >
            <AppText className="font-t3-medium">{document.title}</AppText>
            <AppText className="text-foreground-muted">
              {document.kind} · Revision {document.revisionNumber} · {document.status}
            </AppText>
          </Pressable>
        ))}
        {loading ? <AppText>Loading document…</AppText> : null}
        {detail ? (
          <DocumentReview
            key={`${environmentId}:${draftKey}`}
            detail={detail}
            environmentId={environmentId}
            savedDraft={drafts[draftKey]}
            onDraftChange={(draft) => setDrafts((previous) => ({ ...previous, [draftKey]: draft }))}
            onPersisted={refresh}
            onSaved={() => {
              void list({ environmentId, input: { threadId } }).then((result) => {
                if (currentLoadKey.current !== loadKey) return;
                if (result._tag === "Success") setListed({ key: listKey, documents: result.value });
                else setError(Cause.pretty(result.cause));
              });
              void getHistory({ environmentId, input: { documentId: detail.document.id } }).then(
                (result) => {
                  if (currentLoadKey.current !== loadKey) return;
                  if (result._tag === "Success")
                    setLoaded((previous) =>
                      previous?.key === loadKey ? { ...previous, history: result.value } : previous,
                    );
                  else setError(Cause.pretty(result.cause));
                },
              );
            }}
            onReloadSaved={() => {
              setDrafts((previous) => {
                const next = { ...previous };
                delete next[draftKey];
                return next;
              });
              refresh();
            }}
          />
        ) : null}
        {history ? (
          <View className="gap-3">
            <AppText className="text-xl font-t3-medium">Revisions and history</AppText>
            <View className="flex-row flex-wrap gap-2">
              {history.revisions.map((revision) => (
                <MaterialButton
                  key={revision.id}
                  label={`Revision ${revision.number}${revision.id === detail?.document.currentRevisionId ? " (current)" : ""}`}
                  onPress={() =>
                    setSelection({ documentId: revision.documentId, revisionId: revision.id })
                  }
                />
              ))}
            </View>
            {history.events.map((event) => (
              <View key={event.id} className="gap-1 border-b border-border py-2">
                <AppText>
                  {event.event} · {event.actor} · {new Date(event.createdAt).toLocaleString()}
                </AppText>
                <AppText className="text-foreground-muted">{event.detail}</AppText>
                {event.answers?.map((answer) => (
                  <AppText key={answer.itemId} selectable>
                    {history.revisions
                      .find((revision) => revision.id === event.revisionId)
                      ?.definition?.items.find((item) => item.id === answer.itemId)?.title ??
                      answer.itemId}
                    : {outcomeLabels[answer.outcome]}
                    {answer.notes ? ` — ${answer.notes}` : ""}
                  </AppText>
                ))}
              </View>
            ))}
            {history.submissions.map((submission) => (
              <View key={submission.id} className="gap-2 rounded-xl border border-border p-3">
                <AppText>
                  Submitted {new Date(submission.createdAt).toLocaleString()} ·{" "}
                  {submission.delivery}
                </AppText>
                <AppText selectable>{submission.markdown}</AppText>
                <MaterialButton
                  label="Save / share submitted Markdown"
                  onPress={() => {
                    void shareDocumentMarkdown(
                      detail?.document.title ?? "Results",
                      submission.markdown,
                    ).catch((cause) => setError(String(cause)));
                  }}
                />
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function DocumentReview(props: {
  readonly environmentId: EnvironmentId;
  readonly detail: DocumentDetail;
  readonly savedDraft?: Draft;
  readonly onDraftChange: (draft: Draft) => void;
  readonly onPersisted: () => void;
  readonly onSaved: () => void;
  readonly onReloadSaved: () => void;
}) {
  const [detail, setDetail] = useState(props.detail);
  const latestDetail = useRef(detail);
  const updateDetail = (next: DocumentDetail) => {
    latestDetail.current = next;
    setDetail(next);
  };
  const [draft, setDraft] = useState<Draft>(
    () =>
      props.savedDraft ?? {
        answers: initialDocumentAnswers(detail),
        answerVersion: detail.answerVersion,
      },
  );
  const draftRef = useRef(draft);
  const busyRef = useRef(false);
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflicted, setConflicted] = useState(false);
  const webView = useRef<WebView>(null);
  const binding = useMemo(
    () => ({ sessionId: uuidv4(), documentId: detail.document.id, revisionId: detail.revision.id }),
    [detail.document.id, detail.revision.id],
  );
  const readOnly = isDocumentRevisionReadOnly(detail);
  const displayedAnswers = readOnly ? initialDocumentAnswers(detail) : draft.answers;
  const dirty = documentDraftHasChanges(draft, detail);
  const get = useAtomCommand(documentsEnvironment.get, { reportFailure: false });
  const save = useAtomCommand(documentsEnvironment.saveDraft, { reportFailure: false });
  const submit = useAtomCommand(documentsEnvironment.submit, { reportFailure: false });
  const retry = useAtomCommand(documentsEnvironment.retry, { reportFailure: false });
  const interactive = detail.revision.definition !== null;
  const html = useMemo(
    () => documentWebViewHtml(detail.content, interactive),
    [detail.content, interactive],
  );

  const updateDraft = (next: Draft) => {
    draftRef.current = next;
    setDraft(next);
    props.onDraftChange(next);
  };
  const send = (value: unknown) =>
    activeRef.current && webView.current?.injectJavaScript(documentWebViewResponse(value));
  const sendInit = () =>
    send({
      ...documentBridgeInit(binding, detail),
      readOnly,
      expectedAnswerRevision: detail.answerVersion,
      result: { answers: detail.answers },
    });

  async function persist(kind: "save" | "submit", requested?: Draft) {
    if (busyRef.current || readOnly) return null;
    const snapshot = prepareDocumentOperation(
      requested ? { ...requested, operation: draftRef.current.operation } : draftRef.current,
      kind,
      uuidv4,
    );
    const validation = validateDocumentAnswers(detail, snapshot.answers);
    if (validation) {
      setError(validation);
      return null;
    }
    updateDraft(snapshot);
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const input = {
      documentId: detail.document.id,
      revisionId: detail.revision.id,
      expectedAnswerVersion: snapshot.answerVersion,
      requestId: snapshot.operation.requestId,
      answers: snapshot.answers,
    };
    try {
      if (kind === "save") {
        const result = await save({ environmentId: props.environmentId, input });
        if (!activeRef.current) return null;
        if (result._tag === "Failure") {
          const reconciled = await get({
            environmentId: props.environmentId,
            input: { documentId: detail.document.id, revisionId: detail.revision.id },
          });
          if (!activeRef.current) return null;
          if (reconciled._tag === "Success") updateDetail(reconciled.value);
          if (
            reconciled._tag === "Success" &&
            documentOperationAcknowledged(snapshot, reconciled.value, kind)
          ) {
            updateDraft({
              answers: reconciled.value.answers,
              answerVersion: reconciled.value.answerVersion,
            });
            setNotice("Draft saved; the saved state confirmed the missing acknowledgement.");
            props.onSaved();
            return reconciled.value;
          }
          const message = Cause.pretty(result.cause);
          setError(
            `${message}\nYour draft remains on this screen. Reload saved answers to resolve a conflict.`,
          );
          setConflicted(true);
          return null;
        }
        updateDraft({ answers: result.value.answers, answerVersion: result.value.answerVersion });
        updateDetail(result.value);
        setConflicted(false);
        setNotice("Draft saved. The agent has not been sent a result.");
        props.onSaved();
        return result.value;
      }
      const result = await submit({ environmentId: props.environmentId, input });
      if (!activeRef.current) return null;
      if (result._tag === "Failure") {
        const reconciled = await get({
          environmentId: props.environmentId,
          input: { documentId: detail.document.id, revisionId: detail.revision.id },
        });
        if (!activeRef.current) return null;
        if (reconciled._tag === "Success") updateDetail(reconciled.value);
        if (
          reconciled._tag === "Success" &&
          documentOperationAcknowledged(snapshot, reconciled.value, kind)
        ) {
          updateDraft({
            answers: reconciled.value.lastSubmission!.answers,
            answerVersion: reconciled.value.lastSubmission!.answerVersion,
          });
          props.onPersisted();
          return null;
        }
        setError(
          `${Cause.pretty(result.cause)}\nYour draft remains on this screen. Refresh to check whether submission was saved before retrying.`,
        );
        setConflicted(true);
        return null;
      }
      updateDraft({ answers: result.value.answers, answerVersion: result.value.answerVersion });
      setNotice(`Result saved · delivery ${result.value.delivery}`);
      props.onPersisted();
      return null;
    } finally {
      busyRef.current = false;
      if (activeRef.current) setBusy(false);
    }
  }

  async function onMessage(event: WebViewMessageEvent) {
    let value: unknown;
    try {
      value = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    const request = parseDocumentBridgeRequest(value, binding);
    if (!request) return;
    if (request.type === "ready") {
      sendInit();
      return;
    }
    if (request.method === "load") {
      if (busyRef.current) {
        send(
          documentBridgeResponse(binding, request.requestId, {
            ok: false,
            error: "A document operation is already pending.",
          }),
        );
        return;
      }
      busyRef.current = true;
      setBusy(true);
      try {
        const result = await get({
          environmentId: props.environmentId,
          input: { documentId: detail.document.id, revisionId: detail.revision.id },
        });
        if (!activeRef.current) return;
        if (result._tag === "Failure") {
          send(
            documentBridgeResponse(binding, request.requestId, {
              ok: false,
              error: Cause.pretty(result.cause),
            }),
          );
          return;
        }
        const fresh = result.value;
        const keepDraft = documentDraftHasChanges(draftRef.current, detail);
        updateDetail(fresh);
        if (!keepDraft)
          updateDraft({
            answers: initialDocumentAnswers(fresh),
            answerVersion: fresh.answerVersion,
          });
        else if (
          fresh.answerVersion !== draftRef.current.answerVersion ||
          isDocumentRevisionReadOnly(fresh)
        ) {
          setConflicted(true);
          setNotice(
            "Saved answers changed. Your local draft is retained; export it or explicitly reload saved answers.",
          );
        }
        props.onSaved();
        send(
          documentBridgeResponse(binding, request.requestId, {
            ok: true,
            result: { answers: fresh.answers },
            expectedAnswerRevision: fresh.answerVersion,
            readOnly: isDocumentRevisionReadOnly(fresh),
          }),
        );
      } finally {
        busyRef.current = false;
        if (activeRef.current) setBusy(false);
      }
      return;
    }
    if (readOnly || busyRef.current || conflicted || dirty) {
      send(
        documentBridgeResponse(binding, request.requestId, {
          ok: false,
          readOnly,
          error:
            "Draft saving is unavailable while the app has unsaved edits or a conflict. Save the app draft or reload saved answers first.",
        }),
      );
      return;
    }
    const saved = await persist("save", {
      answers: request.result!.answers,
      answerVersion: request.expectedAnswerRevision!,
    });
    send(
      documentBridgeResponse(
        binding,
        request.requestId,
        saved
          ? {
              ok: true,
              result: { answers: saved.answers },
              expectedAnswerRevision: saved.answerVersion,
              readOnly: isDocumentRevisionReadOnly(saved),
            }
          : {
              ok: false,
              readOnly: isDocumentRevisionReadOnly(latestDetail.current),
              error:
                "Draft was not acknowledged. Answers are preserved in the app review controls.",
            },
      ),
    );
  }

  return (
    <View className="gap-4">
      <AppText className="text-2xl font-t3-medium">{detail.document.title}</AppText>
      <AppText className="text-foreground-muted">
        Revision {detail.revision.number} · {readOnly ? "Read only" : "Draft"} · Answer version{" "}
        {readOnly ? detail.answerVersion : draft.answerVersion}
      </AppText>
      {detail.revision.format === "html" ? (
        <WebView
          ref={webView}
          source={{ html, baseUrl: "about:blank" }}
          style={{ height: 420, backgroundColor: "transparent" }}
          originWhitelist={["*"]}
          javaScriptEnabled={interactive}
          javaScriptCanOpenWindowsAutomatically={false}
          setSupportMultipleWindows={false}
          domStorageEnabled={false}
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          incognito
          onError={(event) =>
            setError(
              `Document preview unavailable: ${event.nativeEvent.description}. Use the review controls below.`,
            )
          }
          onShouldStartLoadWithRequest={(request) => isDocumentSnapshotNavigation(request.url)}
          onLoadEnd={interactive ? sendInit : undefined}
          onMessage={
            interactive
              ? (event) => {
                  void onMessage(event);
                }
              : undefined
          }
        />
      ) : (
        <AppText selectable>{detail.content}</AppText>
      )}
      {interactive ? <AppText className="text-xl font-t3-medium">Review answers</AppText> : null}
      {detail.revision.definition?.items.map((item) => {
        const answer = displayedAnswers.find((value) => value.itemId === item.id) ?? {
          itemId: item.id,
          outcome: "pending" as const,
          notes: "",
        };
        const update = (next: DocumentAnswer) => {
          updateDraft({
            ...draftRef.current,
            answers: [
              ...draftRef.current.answers.filter((value) => value.itemId !== item.id),
              next,
            ],
          });
        };
        return (
          <View key={item.id} className="gap-3 rounded-xl border border-border p-3">
            <AppText className="font-t3-medium">{item.title}</AppText>
            {item.description ? (
              <AppText className="text-foreground-muted">{item.description}</AppText>
            ) : null}
            <View className="flex-row flex-wrap gap-2">
              {outcomes.map((outcome) => (
                <MaterialButton
                  key={outcome}
                  label={outcomeLabels[outcome]}
                  tone={answer.outcome === outcome ? "primary" : "secondary"}
                  disabled={busy || readOnly}
                  onPress={() => update({ ...answer, outcome })}
                />
              ))}
            </View>
            <AppTextInput
              accessibilityLabel={`Notes for ${item.title}`}
              placeholder="Notes"
              multiline
              maxLength={8000}
              editable={!readOnly && !busy}
              value={answer.notes}
              onChangeText={(notes) => update({ ...answer, notes })}
              className="min-h-24 rounded-lg border border-border p-3 text-foreground"
            />
          </View>
        );
      })}
      {error ? (
        <AppText accessibilityRole="alert" className="text-danger">
          {error}
        </AppText>
      ) : null}
      {notice ? <AppText>{notice}</AppText> : null}
      {conflicted ? (
        <MaterialButton
          label="Reload saved answers"
          onPress={() =>
            Alert.alert(
              "Replace local draft?",
              "The saved answers will replace your unsaved answers on this screen.",
              [
                { text: "Keep draft", style: "cancel" },
                { text: "Reload saved", style: "destructive", onPress: props.onReloadSaved },
              ],
            )
          }
        />
      ) : null}
      {!readOnly ? (
        <View className="flex-row flex-wrap gap-3">
          <MaterialButton
            label="Save draft"
            disabled={busy || conflicted}
            onPress={() => {
              void persist("save");
            }}
          />
          <MaterialButton
            label="Submit to agent"
            tone="primary"
            disabled={busy || conflicted}
            onPress={() => {
              void persist("submit");
            }}
          />
        </View>
      ) : null}
      <MaterialButton
        label={
          detail.revision.definition === null && detail.revision.format !== "html"
            ? "Save / share document Markdown"
            : "Save / share draft Markdown"
        }
        onPress={() => {
          void shareDocumentMarkdown(
            detail.document.title,
            documentMarkdownExport(detail, displayedAnswers),
          ).catch((cause) => setError(String(cause)));
        }}
      />
      {readOnly && dirty ? (
        <MaterialButton
          label="Save / share retained local draft"
          onPress={() => {
            void shareDocumentMarkdown(
              detail.document.title,
              documentAnswersMarkdown(detail, draft.answers),
            ).catch((cause) => setError(String(cause)));
          }}
        />
      ) : null}
      {detail.lastSubmission ? (
        <View className="gap-3">
          <AppText className="text-xl font-t3-medium">
            Submitted result · {detail.lastSubmission.delivery}
          </AppText>
          {detail.lastSubmission.deliveryError ? (
            <AppText className="text-danger">{detail.lastSubmission.deliveryError}</AppText>
          ) : null}
          <AppText selectable>{detail.lastSubmission.markdown}</AppText>
          <MaterialButton
            label="Save / share submitted Markdown"
            onPress={() => {
              void shareDocumentMarkdown(
                detail.document.title,
                detail.lastSubmission!.markdown,
              ).catch((cause) => setError(String(cause)));
            }}
          />
          {detail.lastSubmission.delivery === "failed" ? (
            <MaterialButton
              label="Retry delivery to agent"
              disabled={busy}
              onPress={() => {
                setBusy(true);
                void retry({
                  environmentId: props.environmentId,
                  input: { submissionId: detail.lastSubmission!.id },
                })
                  .then((result) => {
                    if (!activeRef.current) return;
                    if (result._tag === "Failure") setError(Cause.pretty(result.cause));
                    else props.onPersisted();
                  })
                  .finally(() => {
                    if (activeRef.current) setBusy(false);
                  });
              }}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
