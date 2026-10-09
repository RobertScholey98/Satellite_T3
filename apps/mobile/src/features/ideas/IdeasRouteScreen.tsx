import { shareAttachmentBytes } from "../../lib/attachmentDownload";
import { ideaDocumentHtml } from "./ideaDocumentHtml";
import { rememberIdea } from "./ideaWorkspace";
import { MarkdownDocument } from "../files/FileMarkdownPreview";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { clearDeletedIdea } from "./IdeaDeletionCleanup";
import { useThreadOutboxMessages } from "../../state/use-thread-outbox";
import { useIdeaValue, readIdeaPosition, saveIdeaPosition } from "./ideaWorkspace";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Image,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  Switch,
  TextInput,
  View,
} from "react-native";
import {
  CommandId,
  EnvironmentId,
  IdeaEntryId,
  IdeaCategoryId,
  ThreadId,
  type IdeaArtifact,
  type IdeaEdit,
  type IdeaNotebook,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { WebView } from "react-native-webview";

import { AppText as Text } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useWorkspaceState } from "../../state/workspace";
import { useProjects } from "../../state/entities";
import { ideaEnvironment } from "../../state/ideas";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { getComposerDraftSnapshot, setComposerDraftText } from "../../state/use-composer-drafts";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { uuidv4 } from "../../lib/uuid";
import { ThreadRouteScreen } from "../threads/ThreadRouteScreen";

export function IdeasRouteScreen() {
  const { environments } = useWorkspaceState();
  const [filter, setFilter] = useState("");
  return (
    <View className="flex-1 bg-screen">
      <NativeStackScreenOptions options={{ title: "Ideas" }} />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-4 p-4">
        <TextInput
          accessibilityLabel="Find an idea"
          placeholder="Find an idea"
          value={filter}
          onChangeText={setFilter}
          className="rounded-xl border border-border bg-surface px-4 py-3 text-foreground"
        />
        {environments.map((environment) => (
          <EnvironmentIdeas
            key={environment.environmentId}
            environmentId={environment.environmentId}
            label={environment.environmentLabel}
            filter={filter}
          />
        ))}
        <Text className="text-sm text-foreground-muted">
          Start an idea by selecting Idea in a new thread.
        </Text>
      </ScrollView>
    </View>
  );
}

function EnvironmentIdeas({
  environmentId,
  label,
  filter,
}: {
  environmentId: EnvironmentId;
  label: string;
  filter: string;
}) {
  const query = useEnvironmentQuery(ideaEnvironment.list({ environmentId, input: {} }));
  const projects = useProjects();
  const navigation = useNavigation();
  const [showSettled, setShowSettled] = useState(false);
  const queued = useThreadOutboxMessages();
  const pending = Object.values(queued)
    .flat()
    .filter(
      (message) =>
        message.environmentId === environmentId &&
        message.creation?.purpose === "idea" &&
        !query.data?.ideas.some((idea) => idea.threadId === message.threadId),
    );
  const projectName = (projectId: string) =>
    projects.find((project) => project.environmentId === environmentId && project.id === projectId)
      ?.title ?? "Project";
  const rows =
    query.data?.ideas.filter((item) =>
      `${projectName(item.projectId)} ${item.title} ${item.excerpt}`
        .toLowerCase()
        .includes(filter.toLowerCase()),
    ) ?? [];
  return (
    <View className="gap-3">
      <Text className="text-xs font-t3-medium text-foreground-muted">{label}</Text>
      {query.error ? (
        <>
          <Text className="text-sm text-danger">{query.error}</Text>
          <MaterialButton label="Retry" onPress={query.refresh} />
        </>
      ) : null}
      {query.isPending && !query.data ? (
        <Text className="text-sm text-foreground-muted">Loading ideas…</Text>
      ) : null}
      {query.data?.ideas.length === 0 ? (
        <Text className="text-sm text-foreground-muted">No ideas yet.</Text>
      ) : null}
      {pending.map((message) => (
        <Pressable
          key={message.threadId}
          className="gap-1 rounded-xl bg-surface p-4"
          onPress={() => navigation.navigate("Idea", { environmentId, threadId: message.threadId })}
        >
          <Text className="text-foreground">{message.text.slice(0, 90) || "New idea"}</Text>
          <Text className="text-xs text-foreground-muted">
            Waiting to start · {message.creation?.projectTitle}
          </Text>
        </Pressable>
      ))}
      {[...new Set(rows.map((item) => item.projectId))].map((projectId) => {
        const group = rows.filter(
          (item) => item.projectId === projectId && (item.status !== "settled" || showSettled),
        );
        if (!group.length) return null;
        return (
          <View key={projectId} className="gap-2">
            <Text className="font-t3-medium text-foreground">{projectName(projectId)}</Text>
            {group.map((item) => (
              <Pressable
                key={item.threadId}
                accessibilityRole="button"
                className="gap-1 rounded-xl bg-surface p-4 active:opacity-70"
                onPress={() =>
                  navigation.navigate("Idea", { environmentId, threadId: item.threadId })
                }
              >
                <Text className="font-t3-medium text-foreground">{item.title}</Text>
                <Text className="text-xs text-foreground-muted">{item.status}</Text>
                <Text numberOfLines={2} className="text-sm text-foreground-muted">
                  {item.excerpt || "The pitch will grow with the conversation."}
                </Text>
              </Pressable>
            ))}
          </View>
        );
      })}
      {rows.some((item) => item.status === "settled") ? (
        <MaterialButton
          tone="text"
          label={showSettled ? "Hide settled ideas" : "Show settled ideas"}
          onPress={() => setShowSettled((value) => !value)}
        />
      ) : null}
    </View>
  );
}

type IdeaRouteProps = StaticScreenProps<{ environmentId: string; threadId: string }>;
type Tab =
  | { kind: "thread" }
  | { kind: "notebook" }
  | { kind: "entry"; id: string }
  | { kind: "artifact"; id: string };
const tabKey = (tab: Tab) => ("id" in tab ? `${tab.kind}:${tab.id}` : tab.kind);
type Edit = (edit: IdeaEdit) => Promise<boolean>;

export function IdeaRouteScreen(props: IdeaRouteProps) {
  const key = scopedThreadKey(
    EnvironmentId.make(props.route.params.environmentId),
    ThreadId.make(props.route.params.threadId),
  );
  return <IdeaWorkspace key={key} {...props} />;
}

function IdeaWorkspace(props: IdeaRouteProps) {
  const navigation = useNavigation();
  const threadRef = {
    environmentId: EnvironmentId.make(props.route.params.environmentId),
    threadId: ThreadId.make(props.route.params.threadId),
  };
  const query = useEnvironmentQuery(
    ideaEnvironment.get({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const dispatch = useAtomCommand(ideaEnvironment.dispatch, { reportFailure: false });
  const upload = useAtomCommand(ideaEnvironment.writeArtifact, { reportFailure: false });
  const workspaceKey = scopedThreadKey(threadRef.environmentId, threadRef.threadId);
  useEffect(() => {
    rememberIdea({ environmentId: threadRef.environmentId, threadId: threadRef.threadId });
  }, [threadRef.environmentId, threadRef.threadId]);
  const [threadReadingPosition] = useState(() => ({
    initialOffset: readIdeaPosition(workspaceKey, "thread"),
    save: (offset: number) => saveIdeaPosition(workspaceKey, "thread", offset),
  }));
  const [tabs, setTabs] = useIdeaValue<Tab[]>(workspaceKey, "tabs", [
    { kind: "thread" },
    { kind: "notebook" },
  ]);
  const [selected, setSelected] = useIdeaValue(workspaceKey, "selected", "notebook");
  const [messageRequest, setMessageRequest] = useIdeaValue<{
    messageId?: string;
    activityId?: string;
    requestId: number;
  } | null>(workspaceKey, "message-request", null);
  const list = useEnvironmentQuery(
    ideaEnvironment.list({ environmentId: threadRef.environmentId, input: {} }),
  );
  const title =
    list.data?.ideas.find((item) => item.threadId === threadRef.threadId)?.title ?? "Idea";
  const [titleDraft, setTitleDraft] = useIdeaValue<string | null>(workspaceKey, "title", null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queued = useThreadOutboxMessages();
  const pendingCreation =
    queued[workspaceKey]?.some((message) => message.creation?.purpose === "idea") === true;
  const notebook = query.data?.notebook;
  useEffect(() => {
    if (query.data?.notebook === null && !pendingCreation)
      void clearDeletedIdea({
        environmentId: threadRef.environmentId,
        threadId: threadRef.threadId,
      }).catch((cause) =>
        setError(cause instanceof Error ? cause.message : "Local idea cleanup failed."),
      );
  }, [query.data, pendingCreation, threadRef.environmentId, threadRef.threadId]);
  const open = (tab: Tab) => {
    setTabs((current) =>
      current.some((item) => tabKey(item) === tabKey(tab)) ? current : [...current, tab],
    );
    setSelected(tabKey(tab));
  };
  const refreshNotebook = query.refresh;
  const environmentId = threadRef.environmentId;
  const threadId = threadRef.threadId;
  const edit: Edit = useCallback(
    async (edit) => {
      const result = await dispatch({
        environmentId: environmentId,
        input: {
          type: "idea.edit",
          commandId: CommandId.make(uuidv4()),
          threadId: threadId,
          edit,
        },
      });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Could not update idea.");
        return false;
      }
      setError(null);
      if (edit.kind !== "edit.begin" && edit.kind !== "edit.end") refreshNotebook();
      return true;
    },
    [dispatch, refreshNotebook, environmentId, threadId],
  );
  const remove = async () => {
    setBusy(true);
    const result = await dispatch({
      environmentId: threadRef.environmentId,
      input: {
        type: "idea.delete",
        commandId: CommandId.make(uuidv4()),
        threadId: threadRef.threadId,
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Deletion failed.");
    } else query.refresh();
  };
  const attach = async () => {
    const { getDocumentAsync } = await import("expo-document-picker");
    const result = await getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (result.canceled) return;
    const { File, Paths } = await import("expo-file-system");
    setBusy(true);
    try {
      for (const asset of result.assets) {
        const file = new File(asset.uri);
        try {
          if (file.size > 20_000_000) throw new Error("Files must be smaller than 20 MB.");
          const uploaded = await upload({
            environmentId: threadRef.environmentId,
            input: {
              threadId: threadRef.threadId,
              name: asset.name,
              mediaType: asset.mimeType ?? "application/octet-stream",
              contentBase64: await file.base64(),
            },
          });
          if (uploaded._tag === "Failure") throw squashAtomCommandFailure(uploaded);
        } finally {
          if (file.uri.startsWith(`${Paths.cache.uri.replace(/\/$/, "")}/`)) file.delete();
        }
      }
      query.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  };
  const promote = () => {
    const key = scopedThreadKey(threadRef.environmentId, threadRef.threadId);
    const draft = getComposerDraftSnapshot(key).text;
    if (!draft.startsWith("/promote"))
      setComposerDraftText(key, draft ? `/promote\n\n${draft}` : "/promote");
    setSelected("thread");
  };
  const openEntry = (id: string) => {
    let resolved = id;
    const visited = new Set<string>();
    while (!visited.has(resolved)) {
      visited.add(resolved);
      const alias = notebook?.aliases.find((item) => item.from === resolved);
      if (!alias) break;
      resolved = alias.to;
    }
    open({ kind: "entry", id: resolved });
  };
  if (!notebook && pendingCreation) return <ThreadRouteScreen {...props} ideaWorkspace />;
  if (!notebook)
    return (
      <View className="flex-1 bg-screen p-5">
        <NativeStackScreenOptions options={{ title }} />
        <MaterialButton
          label="All ideas"
          tone="text"
          onPress={() => navigation.navigate("Ideas")}
        />
        <Text className="text-foreground-muted">
          {error ??
            query.error ??
            (query.isPending ? "Opening idea…" : "This idea is no longer available.")}
        </Text>
        {query.error ? <MaterialButton label="Retry" onPress={query.refresh} /> : null}
      </View>
    );
  if (notebook.status === "deleting")
    return (
      <View className="flex-1 gap-4 bg-screen p-5">
        <Text className="text-foreground">
          {notebook.deletionError ?? "Deleting this idea and its files…"}
        </Text>
        {notebook.deletionError ? (
          <MaterialButton label="Retry deletion" disabled={busy} onPress={() => void remove()} />
        ) : null}
      </View>
    );
  return (
    <View className="flex-1 bg-screen">
      <NativeStackScreenOptions options={{ title }} />
      <MaterialButton label="All ideas" tone="text" onPress={() => navigation.navigate("Ideas")} />
      <View className="border-b border-border">
        <ScrollView horizontal contentContainerClassName="gap-2 px-3 py-2">
          {tabs.map((tab) => (
            <View key={tabKey(tab)} className="flex-row items-center">
              <Pressable
                accessibilityRole="tab"
                accessibilityState={{ selected: selected === tabKey(tab) }}
                className={`rounded-lg px-3 py-2 ${selected === tabKey(tab) ? "bg-surface" : ""}`}
                onPress={() => setSelected(tabKey(tab))}
              >
                <Text numberOfLines={1} className="max-w-40 text-sm text-foreground">
                  {tab.kind === "thread"
                    ? "Thread"
                    : tab.kind === "notebook"
                      ? "Notebook"
                      : tab.kind === "entry"
                        ? (notebook.entries.find((entry) => entry.id === tab.id)?.title ??
                          "Removed note")
                        : (notebook.artifacts.find((artifact) => artifact.id === tab.id)?.name ??
                          "Removed document")}
                </Text>
              </Pressable>
              {"id" in tab ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Close tab"
                  className="px-2 py-3"
                  onPress={() => {
                    setTabs((current) => current.filter((item) => tabKey(item) !== tabKey(tab)));
                    if (selected === tabKey(tab)) setSelected("thread");
                  }}
                >
                  <Text className="text-foreground-muted">×</Text>
                </Pressable>
              ) : null}
            </View>
          ))}
        </ScrollView>
      </View>
      {error ? (
        <Text accessibilityRole="alert" className="px-4 py-2 text-sm text-danger">
          {error}
        </Text>
      ) : null}
      <View style={{ flex: 1, display: selected === "thread" ? "flex" : "none" }}>
        <ThreadRouteScreen
          {...props}
          ideaWorkspace
          revealMessage={messageRequest}
          readingPosition={threadReadingPosition}
        />
      </View>
      <ScrollView
        contentOffset={{ x: 0, y: readIdeaPosition(workspaceKey, "notebook") }}
        onScroll={(event) =>
          saveIdeaPosition(workspaceKey, "notebook", event.nativeEvent.contentOffset.y)
        }
        scrollEventThrottle={100}
        style={{ display: selected === "notebook" ? "flex" : "none" }}
        contentContainerClassName="gap-5 p-5"
        contentInsetAdjustmentBehavior="automatic"
      >
        <View className="gap-2">
          {titleDraft === null ? (
            <MaterialButton label="Rename idea" tone="text" onPress={() => setTitleDraft(title)} />
          ) : (
            <>
              <TextInput
                accessibilityLabel="Idea title"
                maxLength={240}
                value={titleDraft}
                onChangeText={setTitleDraft}
                className="rounded-lg border border-border bg-surface p-3 text-foreground"
              />
              <MaterialButton
                label="Save title"
                disabled={!titleDraft.trim()}
                onPress={async () => {
                  const result = await dispatch({
                    environmentId: threadRef.environmentId,
                    input: {
                      type: "thread.metadata.update",
                      commandId: CommandId.make(uuidv4()),
                      threadId: threadRef.threadId,
                      title: titleDraft.trim(),
                    },
                  });
                  if (result._tag === "Failure") {
                    const cause = squashAtomCommandFailure(result);
                    setError(cause instanceof Error ? cause.message : "Could not rename idea.");
                  } else {
                    setTitleDraft(null);
                    list.refresh();
                  }
                }}
              />
              <MaterialButton label="Cancel" tone="text" onPress={() => setTitleDraft(null)} />
            </>
          )}
        </View>
        <View className="flex-row flex-wrap gap-2">
          <MaterialButton label="Promote to issues" onPress={promote} />
          <MaterialButton
            tone="text"
            label={notebook.status === "settled" ? "Reopen idea" : "Settle idea"}
            onPress={() => {
              if (notebook.status === "settled") {
                void edit({
                  kind: "idea.reopen",
                  reviewedContentRevision: notebook.contentRevision,
                });
                return;
              }
              Alert.alert(
                `Settle “${title}”?`,
                "Move it to settled ideas and set aside remaining scope. Published issues remain. You can reopen the idea later.",
                [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Settle idea",
                    onPress: () =>
                      void edit({
                        kind: "idea.settle",
                        reviewedContentRevision: notebook.contentRevision,
                      }),
                  },
                ],
              );
            }}
          />
          <MaterialButton
            tone="text"
            label="Delete idea"
            onPress={() =>
              Alert.alert(
                `Delete “${title}” permanently?`,
                "Its thread, notebook and files will be removed. Published issues remain. This cannot be undone.",
                [
                  { text: "Cancel", style: "cancel" },
                  { text: "Delete idea", style: "destructive", onPress: () => void remove() },
                ],
              )
            }
          />
        </View>
        <Text className="text-xl font-t3-semibold text-foreground">Pitch</Text>
        <NativeEditor
          workspaceKey={workspaceKey}
          notebook={notebook}
          resource="pitch"
          edit={edit}
          onEntry={openEntry}
        />
        <Text className="text-xs text-foreground-muted">
          {notebook.update.status === "current"
            ? "Notebook is up to date"
            : notebook.update.status === "waiting"
              ? "Waiting for the conversation"
              : notebook.update.status === "failed"
                ? "Notebook is behind the conversation"
                : "Updating notebook…"}
        </Text>
        {notebook.update.status === "failed" ? (
          <MaterialButton
            label="Retry update"
            onPress={() => void edit({ kind: "update.retry" })}
          />
        ) : null}
        {notebook.proposals.map((proposal) => (
          <View key={proposal.id} className="gap-3 rounded-xl bg-surface p-4">
            <Text className="font-t3-medium text-foreground">Update needs review</Text>
            <Text className="text-sm text-foreground-muted">{proposal.reason}</Text>
            <Text selectable className="text-sm text-foreground">
              {proposal.edits
                .map((change) =>
                  "markdown" in change
                    ? change.markdown
                    : "name" in change
                      ? change.name
                      : change.kind,
                )
                .join("\n\n")}
            </Text>
            <MaterialButton
              label="Apply update"
              onPress={() =>
                void edit({
                  kind: "proposal.accept",
                  id: proposal.id,
                  reviewedContentRevision: notebook.contentRevision,
                })
              }
            />
            <MaterialButton
              tone="text"
              label="Keep current"
              onPress={() => void edit({ kind: "proposal.reject", id: proposal.id })}
            />
          </View>
        ))}
        {notebook.promotion ? (
          <NativePromotion
            notebook={notebook}
            edit={edit}
            onRevise={() => {
              const draft = getComposerDraftSnapshot(workspaceKey).text;
              setComposerDraftText(workspaceKey, `Revise the proposed issues. ${draft}`);
              setSelected("thread");
            }}
          />
        ) : null}
        <View className="flex-row items-center justify-between">
          <Text className="font-t3-semibold text-foreground">Notes</Text>
          <MaterialButton
            tone="text"
            label="Add note"
            onPress={async () => {
              const category = notebook.categories[0];
              if (!category) return;
              const id = IdeaEntryId.make(uuidv4());
              if (
                await edit({
                  kind: "entry.save",
                  id,
                  baseRevision: 0,
                  title: "New note",
                  categoryId: category.id,
                  markdown: "",
                  sources: [],
                })
              )
                openEntry(id);
            }}
          />
        </View>
        <NativeCategories workspaceKey={workspaceKey} notebook={notebook} edit={edit} />
        {notebook.categories.map((category) => (
          <View key={category.id} className="gap-2">
            <Text className="text-xs font-t3-medium text-foreground-muted">{category.name}</Text>
            {notebook.entries
              .filter((entry) => entry.categoryId === category.id)
              .map((entry) => (
                <Pressable
                  key={entry.id}
                  accessibilityRole="button"
                  className="rounded-lg bg-surface px-4 py-3"
                  onPress={() => openEntry(entry.id)}
                >
                  <Text className="text-foreground">{entry.title}</Text>
                </Pressable>
              ))}
          </View>
        ))}
        <View className="flex-row items-center justify-between">
          <Text className="font-t3-semibold text-foreground">Documents and images</Text>
          <MaterialButton
            label="Attach"
            tone="text"
            disabled={busy}
            onPress={() => void attach()}
          />
        </View>
        {notebook.artifacts.map((artifact) => (
          <Pressable
            key={artifact.id}
            accessibilityRole="button"
            className="rounded-lg bg-surface px-4 py-3"
            onPress={() => open({ kind: "artifact", id: artifact.id })}
          >
            <Text className="text-foreground">{artifact.name}</Text>
          </Pressable>
        ))}
        {notebook.history.length ? (
          <View className="gap-2">
            <Text className="font-t3-medium text-foreground">Update history</Text>
            {notebook.history
              .slice(-5)
              .reverse()
              .map((item) => (
                <View key={item.id} className="gap-1">
                  <Text className="text-xs text-foreground-muted">{item.summary}</Text>
                  <MaterialButton
                    tone="text"
                    label={item.undone ? "Undone" : "Undo"}
                    disabled={item.undone}
                    onPress={() => void edit({ kind: "update.undo", id: item.id })}
                  />
                </View>
              ))}
          </View>
        ) : null}
      </ScrollView>
      {tabs
        .filter((tab) => "id" in tab)
        .map((tab) => (
          <View
            key={tabKey(tab)}
            style={{ flex: 1, display: selected === tabKey(tab) ? "flex" : "none" }}
          >
            {tab.kind === "entry" ? (
              <ScrollView
                contentContainerClassName="gap-4 p-5"
                contentOffset={{ x: 0, y: readIdeaPosition(workspaceKey, tabKey(tab)) }}
                onScroll={(event) =>
                  saveIdeaPosition(workspaceKey, tabKey(tab), event.nativeEvent.contentOffset.y)
                }
                scrollEventThrottle={100}
              >
                <NativeEditor
                  workspaceKey={workspaceKey}
                  notebook={notebook}
                  resource={`entry:${tab.id}`}
                  edit={edit}
                  onEntry={openEntry}
                />
                {notebook.entries
                  .find((entry) => entry.id === tab.id)
                  ?.sources.map((source) => (
                    <MaterialButton
                      key={`${source.kind}:${source.kind === "artifact" ? source.artifactId : source.kind === "message" ? source.messageId : source.activityId}`}
                      tone="text"
                      label={
                        source.kind === "message"
                          ? "Open source message"
                          : source.kind === "activity"
                            ? "Question answer in thread"
                            : (notebook.artifacts.find((item) => item.id === source.artifactId)
                                ?.name ?? "Removed document")
                      }
                      onPress={() => {
                        if (source.kind === "artifact")
                          open({ kind: "artifact", id: source.artifactId });
                        else if (source.kind === "activity") {
                          setMessageRequest({
                            activityId: source.activityId,
                            requestId: (messageRequest?.requestId ?? 0) + 1,
                          });
                          setSelected("thread");
                        } else {
                          setMessageRequest({
                            messageId: source.messageId,
                            requestId: (messageRequest?.requestId ?? 0) + 1,
                          });
                          setSelected("thread");
                        }
                      }}
                    />
                  ))}
                <NativeChoice
                  label="Merge into another note"
                  choices={notebook.entries
                    .filter((item) => item.id !== tab.id)
                    .map((item) => ({ id: item.id, label: item.title }))}
                  onChoose={(id) => {
                    const entry = notebook.entries.find((item) => item.id === tab.id);
                    const target = notebook.entries.find((item) => item.id === id);
                    if (entry && target)
                      void edit({
                        kind: "entry.merge",
                        id: entry.id,
                        targetId: target.id,
                        baseRevision: entry.document.revision,
                        targetRevision: target.document.revision,
                        markdown: `${target.document.markdown}\n\n${entry.document.markdown}`,
                      }).then((saved) => {
                        if (saved) openEntry(target.id);
                      });
                  }}
                />
                {notebook.artifacts.length ? (
                  <Text className="font-t3-medium text-foreground">Attached documents</Text>
                ) : null}
                {notebook.artifacts.map((artifact) => {
                  const entry = notebook.entries.find((item) => item.id === tab.id);
                  if (!entry) return null;
                  const attached = entry.sources.some(
                    (source) => source.kind === "artifact" && source.artifactId === artifact.id,
                  );
                  return (
                    <View key={artifact.id} className="flex-row items-center gap-3">
                      <Text className="flex-1 text-foreground">{artifact.name}</Text>
                      <Switch
                        accessibilityLabel={`Attach ${artifact.name}`}
                        value={attached}
                        onValueChange={(checked) =>
                          void edit({
                            kind: "entry.save",
                            id: entry.id,
                            baseRevision: entry.document.revision,
                            title: entry.title,
                            categoryId: entry.categoryId,
                            markdown: entry.document.markdown,
                            sources: checked
                              ? [...entry.sources, { kind: "artifact", artifactId: artifact.id }]
                              : entry.sources.filter(
                                  (source) =>
                                    source.kind !== "artifact" || source.artifactId !== artifact.id,
                                ),
                          })
                        }
                      />
                    </View>
                  );
                })}
                {notebook.entries.find((entry) => entry.id === tab.id) ? (
                  <MaterialButton
                    tone="danger"
                    label="Delete note"
                    onPress={() => {
                      const entry = notebook.entries.find((item) => item.id === tab.id);
                      if (entry)
                        Alert.alert(
                          `Delete “${entry.title}”?`,
                          "Old discussion will not recreate the deleted note.",
                          [
                            { text: "Cancel", style: "cancel" },
                            {
                              text: "Delete note",
                              style: "destructive",
                              onPress: () =>
                                void edit({
                                  kind: "entry.delete",
                                  id: entry.id,
                                  baseRevision: entry.document.revision,
                                }),
                            },
                          ],
                        );
                    }}
                  />
                ) : null}
              </ScrollView>
            ) : tab.kind === "artifact" ? (
              <NativeArtifact
                threadRef={threadRef}
                artifact={notebook.artifacts.find((artifact) => artifact.id === tab.id)}
                edit={edit}
              />
            ) : null}
          </View>
        ))}
    </View>
  );
}

function NativeMarkdown({ text, onEntry }: { text: string; onEntry: (id: string) => void }) {
  const onLink = useCallback(
    (href: string) => {
      if (href.startsWith("idea-entry:")) {
        try {
          onEntry(decodeURIComponent(href.slice("idea-entry:".length)));
        } catch {
          onEntry(href.slice("idea-entry:".length));
        }
      } else void tryOpenExternalUrl(href, "markdown-link");
    },
    [onEntry],
  );
  return <MarkdownDocument markdown={text} onLinkPress={onLink} />;
}

function NativeEditor({
  workspaceKey,
  notebook,
  resource,
  edit,
  onEntry,
}: {
  workspaceKey: string;
  notebook: IdeaNotebook;
  resource: string;
  edit: Edit;
  onEntry: (id: string) => void;
}) {
  const entry =
    resource === "pitch"
      ? undefined
      : notebook.entries.find((item) => `entry:${item.id}` === resource);
  const document = resource === "pitch" ? notebook.pitch : entry?.document;
  const [draft, setDraft] = useIdeaValue<{
    markdown: string;
    title: string;
    categoryId: string;
    revision: number;
  } | null>(workspaceKey, `draft:${resource}`, null);
  const lease = useRef(uuidv4());
  const selection = useRef({ start: 0, end: 0 });
  const editing = draft !== null;
  useEffect(() => {
    if (!editing) return;
    const leaseId = lease.current;
    const begin = () =>
      void edit({ kind: "edit.begin", resource: resource as "pitch" | `entry:${string}`, leaseId });
    begin();
    const timer = setInterval(begin, 60_000);
    return () => {
      clearInterval(timer);
      void edit({ kind: "edit.end", leaseId });
    };
  }, [edit, editing, resource]);
  if (!document) return <Text className="text-foreground-muted">This note was removed.</Text>;
  return (
    <View className="gap-3">
      {draft ? (
        <>
          {entry ? (
            <TextInput
              accessibilityLabel="Note title"
              value={draft.title}
              onChangeText={(title) => setDraft({ ...draft, title })}
              className="rounded-lg border border-border bg-surface px-3 py-2 text-foreground"
            />
          ) : null}
          <TextInput
            accessibilityLabel={entry ? "Note content" : "Pitch"}
            onSelectionChange={(event) => {
              selection.current = event.nativeEvent.selection;
            }}
            multiline
            textAlignVertical="top"
            value={draft.markdown}
            onChangeText={(markdown) => setDraft({ ...draft, markdown })}
            className="min-h-64 rounded-lg border border-border bg-surface p-3 text-foreground"
          />
          <NativeChoice
            label="Link a phrase to a note"
            choices={notebook.entries.map((item) => ({ id: item.id, label: item.title }))}
            onChoose={(id) => {
              const target = notebook.entries.find((item) => item.id === id);
              if (!target) return;
              const { start, end } = selection.current;
              const label = (draft.markdown.slice(start, end) || target.title).replace(
                /([\\[\]])/g,
                "\\$1",
              );
              setDraft({
                ...draft,
                markdown:
                  draft.markdown.slice(0, start) +
                  `[${label}](idea-entry:${encodeURIComponent(target.id).replace(/\(/g, "%28").replace(/\)/g, "%29")})` +
                  draft.markdown.slice(end),
              });
            }}
          />
          {entry ? (
            <NativeChoice
              label={`Category: ${notebook.categories.find((item) => item.id === draft.categoryId)?.name ?? "Choose"}`}
              choices={notebook.categories.map((item) => ({ id: item.id, label: item.name }))}
              onChoose={(categoryId) => setDraft({ ...draft, categoryId })}
            />
          ) : null}
          {draft.revision !== document.revision ? (
            <>
              <Text className="text-sm text-foreground-muted">
                The saved version changed. Your draft is preserved.
              </Text>
              <NativeMarkdown text={document.markdown} onEntry={onEntry} />
              <MaterialButton
                label="Keep my draft against this version"
                onPress={() => setDraft({ ...draft, revision: document.revision })}
              />
            </>
          ) : null}
          <View className="flex-row gap-2">
            <MaterialButton
              label="Save"
              disabled={
                draft.revision !== document.revision || (entry !== undefined && !draft.title.trim())
              }
              onPress={async () => {
                const change: IdeaEdit = entry
                  ? {
                      kind: "entry.save",
                      id: entry.id,
                      baseRevision: draft.revision,
                      title: draft.title,
                      categoryId: IdeaCategoryId.make(draft.categoryId),
                      markdown: draft.markdown,
                      sources: entry.sources,
                    }
                  : { kind: "pitch.save", baseRevision: draft.revision, markdown: draft.markdown };
                if (await edit(change)) setDraft(null);
              }}
            />
            <MaterialButton label="Cancel" tone="text" onPress={() => setDraft(null)} />
          </View>
        </>
      ) : (
        <>
          {entry ? (
            <Text className="text-lg font-t3-semibold text-foreground">{entry.title}</Text>
          ) : null}
          <NativeMarkdown
            text={document.markdown || "The pitch starts blank and grows with the conversation."}
            onEntry={onEntry}
          />
          <MaterialButton
            label="Edit"
            tone="text"
            onPress={() =>
              setDraft({
                markdown: document.markdown,
                title: entry?.title ?? "",
                categoryId: entry?.categoryId ?? "",
                revision: document.revision,
              })
            }
          />
        </>
      )}
    </View>
  );
}

function NativePromotion({
  notebook,
  edit,
  onRevise,
}: {
  notebook: IdeaNotebook;
  edit: Edit;
  onRevise: () => void;
}) {
  const promotion = notebook.promotion;
  if (!promotion) return null;
  return (
    <View className="gap-3 rounded-xl bg-surface p-4">
      <Text className="font-t3-semibold text-foreground">Review issues</Text>
      <Text className="text-xs text-foreground-muted">
        {promotion.target.host}/{promotion.target.repository} · Notebook revision{" "}
        {promotion.sourceRevision}
      </Text>
      {promotion.drafts.map((draft) => (
        <View key={draft.id} className="gap-2">
          <Text className="font-t3-medium text-foreground">{draft.title}</Text>
          <Text selectable className="text-sm text-foreground">
            {draft.body}
          </Text>
        </View>
      ))}
      {promotion.error ? <Text className="text-danger">{promotion.error}</Text> : null}
      {promotion.issues.map((issue) => (
        <Pressable key={issue.url} onPress={() => void Linking.openURL(issue.url)}>
          <Text className="text-primary-text">
            #{issue.number} {issue.title}
          </Text>
        </Pressable>
      ))}
      {["review", "partial", "failed"].includes(promotion.status) ? (
        <>
          <MaterialButton
            label={promotion.issues.length ? "Retry remaining issues" : "Publish issues"}
            onPress={() =>
              void edit({
                kind: promotion.status === "review" ? "promotion.approve" : "promotion.retry",
                id: promotion.id,
                sourceRevision: promotion.sourceRevision,
              })
            }
          />
          <MaterialButton
            label="Revise in thread"
            tone="text"
            onPress={async () => {
              if (await edit({ kind: "promotion.reject", id: promotion.id })) onRevise();
            }}
          />
        </>
      ) : (
        <Text className="text-sm text-foreground-muted">
          {promotion.status === "complete"
            ? "Published issues are independent of this idea."
            : "Publishing reviewed issues…"}
        </Text>
      )}
    </View>
  );
}

function NativeArtifact({
  threadRef,
  artifact,
  edit,
}: {
  threadRef: ScopedThreadRef;
  artifact: IdeaArtifact | undefined;
  edit: Edit;
}) {
  const query = useEnvironmentQuery(
    artifact
      ? ideaEnvironment.readArtifact({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, artifactId: artifact.id },
        })
      : null,
  );
  const [shareError, setShareError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const controller = useRef(new AbortController());
  useEffect(() => {
    const current = controller.current;
    return () => current.abort();
  }, []);
  if (!artifact)
    return <Text className="p-5 text-foreground-muted">This document was removed.</Text>;
  const data = query.data;
  const text =
    data && (artifact.mediaType.startsWith("text/") || /\.(md|txt|json|html)$/i.test(artifact.name))
      ? new TextDecoder().decode(
          Uint8Array.from(atob(data.contentBase64), (character) => character.charCodeAt(0)),
        )
      : null;
  return (
    <View className="flex-1 gap-3 p-4">
      <Text className="font-t3-medium text-foreground">{artifact.name}</Text>
      {query.error ? (
        <Text className="text-danger">{query.error}</Text>
      ) : !data ? (
        <Text className="text-foreground-muted">Loading document…</Text>
      ) : artifact.mediaType.startsWith("image/") ? (
        <Image
          accessibilityLabel={artifact.name}
          resizeMode="contain"
          style={{ flex: 1 }}
          source={{ uri: `data:${artifact.mediaType};base64,${data.contentBase64}` }}
        />
      ) : artifact.mediaType === "text/html" && text !== null ? (
        <WebView
          source={{
            html: ideaDocumentHtml(text),
          }}
          javaScriptEnabled
          javaScriptCanOpenWindowsAutomatically={false}
          setSupportMultipleWindows={false}
          cacheEnabled={false}
          incognito
          sharedCookiesEnabled={false}
          thirdPartyCookiesEnabled={false}
          allowUniversalAccessFromFileURLs={false}
          allowFileAccessFromFileURLs={false}
          allowFileAccess={false}
          originWhitelist={["about:blank", "about:srcdoc"]}
          onShouldStartLoadWithRequest={(request) =>
            request.url === "about:blank" || request.url === "about:srcdoc"
          }
        />
      ) : text !== null ? (
        <ScrollView>
          <Text selectable className="text-sm leading-6 text-foreground">
            {text}
          </Text>
        </ScrollView>
      ) : (
        <Text className="text-sm text-foreground-muted">
          This format has no preview. Save or share the original to open it in another app.
        </Text>
      )}
      {shareError ? <Text className="text-danger">{shareError}</Text> : null}
      <MaterialButton
        label={sharing ? "Opening share sheet…" : "Save or share original"}
        disabled={!data || sharing}
        onPress={async () => {
          if (!data) return;
          setSharing(true);
          setShareError(null);
          try {
            await shareAttachmentBytes({
              bytes: Uint8Array.from(atob(data.contentBase64), (character) =>
                character.charCodeAt(0),
              ),
              attachment: { name: artifact.name, mimeType: artifact.mediaType },
              ownerKey: scopedThreadKey(threadRef.environmentId, threadRef.threadId),
              signal: controller.current.signal,
            });
          } catch (cause) {
            setShareError(
              cause instanceof Error ? cause.message : "Could not share this document.",
            );
          } finally {
            setSharing(false);
          }
        }}
      />
      <MaterialButton
        tone="danger"
        label="Delete document"
        onPress={() =>
          Alert.alert(`Delete “${artifact.name}”?`, "Only the copy in this idea will be removed.", [
            { text: "Cancel", style: "cancel" },
            {
              text: "Delete",
              style: "destructive",
              onPress: () => void edit({ kind: "artifact.delete", id: artifact.id }),
            },
          ])
        }
      />
    </View>
  );
}

function NativeChoice({
  label,
  choices,
  onChoose,
}: {
  label: string;
  choices: ReadonlyArray<{ id: string; label: string }>;
  onChoose: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <MaterialButton
        tone="text"
        label={label}
        disabled={!choices.length}
        onPress={() => setOpen(true)}
      />
      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}
      >
        <View className="flex-1 bg-screen px-5 pt-8">
          <Text className="text-lg font-t3-semibold text-foreground">{label}</Text>
          <ScrollView contentContainerClassName="gap-2 py-4">
            {choices.map((choice) => (
              <MaterialButton
                key={choice.id}
                label={choice.label}
                tone="text"
                onPress={() => {
                  setOpen(false);
                  onChoose(choice.id);
                }}
              />
            ))}
          </ScrollView>
          <View className="pb-8">
            <MaterialButton label="Cancel" onPress={() => setOpen(false)} />
          </View>
        </View>
      </Modal>
    </>
  );
}

function NativeCategories({
  workspaceKey,
  notebook,
  edit,
}: {
  workspaceKey: string;
  notebook: IdeaNotebook;
  edit: Edit;
}) {
  const [expanded, setExpanded] = useState(false);
  const [newName, setNewName] = useIdeaValue(workspaceKey, "category:new", "");
  return (
    <View className="gap-3">
      <MaterialButton
        tone="text"
        label="Organize categories"
        onPress={() => setExpanded((value) => !value)}
      />
      {expanded ? (
        <>
          {notebook.categories.map((category) => (
            <NativeCategory
              key={category.id}
              workspaceKey={workspaceKey}
              notebook={notebook}
              category={category}
              edit={edit}
            />
          ))}
          <TextInput
            accessibilityLabel="New category name"
            value={newName}
            onChangeText={setNewName}
            className="rounded-lg border border-border bg-surface px-3 py-2 text-foreground"
          />
          <MaterialButton
            label="Add category"
            disabled={!newName.trim()}
            onPress={async () => {
              if (
                await edit({
                  kind: "category.save",
                  id: IdeaCategoryId.make(uuidv4()),
                  baseRevision: 0,
                  name: newName.trim(),
                })
              )
                setNewName("");
            }}
          />
        </>
      ) : null}
    </View>
  );
}

function NativeCategory({
  workspaceKey,
  notebook,
  category,
  edit,
}: {
  workspaceKey: string;
  notebook: IdeaNotebook;
  category: IdeaNotebook["categories"][number];
  edit: Edit;
}) {
  const [draft, setDraft] = useIdeaValue<{ name: string; revision: number } | null>(
    workspaceKey,
    `category:${category.id}`,
    null,
  );
  const lease = useRef(uuidv4());
  const editing = draft !== null;
  useEffect(() => {
    if (!editing) return;
    const id = lease.current;
    const begin = () => void edit({ kind: "edit.begin", resource: "categories", leaseId: id });
    begin();
    const timer = setInterval(begin, 60_000);
    return () => {
      clearInterval(timer);
      void edit({ kind: "edit.end", leaseId: id });
    };
  }, [edit, editing]);
  return (
    <View className="gap-2 rounded-xl bg-surface p-3">
      <TextInput
        accessibilityLabel={`Category ${category.name}`}
        value={draft?.name ?? category.name}
        onChangeText={(name) => setDraft({ name, revision: draft?.revision ?? category.revision })}
        className="rounded-lg border border-border px-3 py-2 text-foreground"
      />
      {draft ? (
        <View className="flex-row gap-2">
          <MaterialButton
            label="Save"
            disabled={!draft.name.trim() || draft.revision !== category.revision}
            onPress={async () => {
              if (
                await edit({
                  kind: "category.save",
                  id: category.id,
                  baseRevision: draft.revision,
                  name: draft.name.trim(),
                })
              )
                setDraft(null);
            }}
          />
          <MaterialButton label="Cancel" tone="text" onPress={() => setDraft(null)} />
        </View>
      ) : null}
      {draft && draft.revision !== category.revision ? (
        <Text className="text-sm text-foreground-muted">
          This category changed. Cancel to reload its current name.
        </Text>
      ) : null}
      <NativeChoice
        label="Merge into category"
        choices={notebook.categories
          .filter((item) => item.id !== category.id)
          .map((item) => ({ id: item.id, label: item.name }))}
        onChoose={(id) => {
          const target = notebook.categories.find((item) => item.id === id);
          if (target)
            void edit({
              kind: "category.merge",
              id: category.id,
              targetId: target.id,
              baseRevision: category.revision,
              targetRevision: target.revision,
            });
        }}
      />
      <MaterialButton
        tone="danger"
        label="Delete empty category"
        disabled={notebook.entries.some((entry) => entry.categoryId === category.id)}
        onPress={() =>
          void edit({ kind: "category.delete", id: category.id, baseRevision: category.revision })
        }
      />
    </View>
  );
}
