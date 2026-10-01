import { clearDeletedIdea } from "./ideaDeletion";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Checkbox } from "../ui/checkbox";
import { ThreadAudienceContext } from "../../state/threadAudience";
import { randomUUID } from "../../lib/utils";
import {
  CommandId,
  EnvironmentId,
  IdeaCategoryId,
  IdeaEntryId,
  ThreadId,
  type IdeaArtifact,
  type IdeaEdit,
  type IdeaEntry,
  type IdeaNotebook,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import {
  BrainIcon,
  FileTextIcon,
  MessageSquareIcon,
  PanelRightIcon,
  PaperclipIcon,
  PencilIcon,
  PlusIcon,
  LinkIcon,
  TrashIcon,
} from "lucide-react";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

import { isElectron } from "../../env";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { ideaEnvironment } from "../../state/ideas";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useComposerDraftStore } from "../../composerDraftStore";
import ChatView from "../ChatView";
import { RightPanelSheet } from "../RightPanelSheet";
import { PreviewPanelShell } from "../preview/PreviewPanelShell";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { SidebarInset, useSidebar } from "../ui/sidebar";
import { PanelTabCloseButton } from "../ui/panel-tab-close-button";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "../ui/alert-dialog";
import {
  ideaTabKey,
  readIdeaPosition,
  saveIdeaPosition,
  useIdeaWorkspace,
  useIdeaWorkspaceStore,
  type IdeaEditorDraft,
} from "./ideaWorkspaceStore";

function decodeIdeaLink(id: string) {
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

const IdeaEntryContext = createContext<(id: string) => void>(() => {});

function IdeaMarkdownLink({ href, children }: { href?: string | undefined; children?: ReactNode }) {
  const onEntry = use(IdeaEntryContext);
  return href?.startsWith("idea-entry:") ? (
    <button
      type="button"
      className="cursor-pointer text-primary underline decoration-dotted underline-offset-4"
      onClick={() => onEntry(decodeIdeaLink(href.slice("idea-entry:".length)))}
    >
      {children}
    </button>
  ) : (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

const ideaMarkdownComponents = { a: IdeaMarkdownLink };

function IdeaMarkdown({ text, onEntry }: { text: string; onEntry: (id: string) => void }) {
  return (
    <IdeaEntryContext value={onEntry}>
      <div className="space-y-3 text-sm leading-7 break-words [&_h2]:mt-5 [&_h2]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_a]:text-primary [&_a]:underline [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          urlTransform={(url) => (url.startsWith("idea-entry:") ? url : defaultUrlTransform(url))}
          components={ideaMarkdownComponents}
        >
          {text}
        </ReactMarkdown>
      </div>
    </IdeaEntryContext>
  );
}

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]) {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "The idea could not be updated.";
}

export function IdeasPage({
  environment,
  idea,
}: {
  environment?: string | undefined;
  idea?: string | undefined;
}) {
  const { isMobile, setOpen, setOpenMobile } = useSidebar();
  const selected =
    environment && idea
      ? { environmentId: EnvironmentId.make(environment), threadId: ThreadId.make(idea) }
      : null;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron}>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <BrainIcon className="size-4 text-muted-foreground" />
          <h1 className="text-sm font-medium">Ideas</h1>
        </div>
      </WorkspacePageHeader>
      <div className="flex min-h-0 flex-1">
        {selected ? (
          <IdeaWorkspace key={scopedThreadKey(selected)} threadRef={selected} />
        ) : (
          <div className="flex flex-1 items-center justify-center p-8">
            <div className="max-w-sm space-y-3">
              <h2 className="text-lg font-medium">Room to think</h2>
              <p className="text-sm leading-6 text-muted-foreground">
                Open an idea to continue its conversation, read the pitch, or work through its
                notes. Your implementation threads stay separate.
              </p>
              <Button
                variant="outline"
                onClick={() => (isMobile ? setOpenMobile(true) : setOpen(true))}
              >
                Open ideas
              </Button>
            </div>
          </div>
        )}
      </div>
    </SidebarInset>
  );
}
function IdeaWorkspace({ threadRef }: { threadRef: ScopedThreadRef }) {
  const query = useEnvironmentQuery(
    ideaEnvironment.get({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const dispatch = useAtomCommand(ideaEnvironment.dispatch, { reportFailure: false });
  const upload = useAtomCommand(ideaEnvironment.writeArtifact, { reportFailure: false });
  const navigate = useNavigate();
  const key = scopedThreadKey(threadRef);
  const workspace = useIdeaWorkspace(key);
  const list = useEnvironmentQuery(
    ideaEnvironment.list({ environmentId: threadRef.environmentId, input: {} }),
  );
  const title =
    list.data?.ideas.find((item) => item.threadId === threadRef.threadId)?.title ?? "Idea";
  useEffect(() => {
    useIdeaWorkspaceStore.getState().select(threadRef.environmentId, threadRef.threadId);
  }, [threadRef.environmentId, threadRef.threadId]);
  const [error, setError] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [settleOpen, setSettleOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const compact = useMediaQuery("max-lg");
  const notebook = query.data?.notebook;
  const composerDraft = useComposerDraftStore((state) => state.draftsByThreadKey[key]);
  useEffect(() => {
    if (notebook && composerDraft && composerDraft.purpose !== "idea")
      useComposerDraftStore.setState((state) => ({
        draftsByThreadKey: {
          ...state.draftsByThreadKey,
          [key]: { ...composerDraft, purpose: "idea" },
        },
      }));
  }, [notebook, composerDraft, key]);
  const refreshNotebook = query.refresh;
  const sendEdit = useCallback(
    async (edit: IdeaEdit) => {
      const result = await dispatch({
        environmentId: threadRef.environmentId,
        input: {
          type: "idea.edit",
          commandId: CommandId.make(randomUUID()),
          threadId: threadRef.threadId,
          edit,
        },
      });
      if (result._tag === "Failure") {
        setError(failureMessage(result));
        return false;
      }
      setError(null);
      if (edit.kind !== "edit.begin" && edit.kind !== "edit.end") refreshNotebook();
      return true;
    },
    [dispatch, refreshNotebook, threadRef.environmentId, threadRef.threadId],
  );
  const openEntry = useCallback(
    (id: string) => {
      let resolved = id;
      const seen = new Set<string>();
      while (!seen.has(resolved)) {
        seen.add(resolved);
        const alias = notebook?.aliases.find((item) => item.from === resolved);
        if (!alias) break;
        resolved = alias.to;
      }
      useIdeaWorkspaceStore.getState().open(key, { kind: "entry", id: IdeaEntryId.make(resolved) });
    },
    [key, notebook?.aliases],
  );
  useEffect(() => {
    if (query.isSuccess && notebook === null)
      clearDeletedIdea({ environmentId: threadRef.environmentId, threadId: threadRef.threadId });
  }, [threadRef.environmentId, threadRef.threadId, notebook, query.isSuccess]);
  const promote = () => {
    const store = useComposerDraftStore.getState();
    const current = store.getComposerDraft(threadRef)?.prompt ?? "";
    if (!current.startsWith("/promote"))
      store.setPrompt(threadRef, current ? `/promote\n\n${current}` : "/promote");
    useIdeaWorkspaceStore.getState().open(key, { kind: "thread", id: "thread" });
  };
  if (!notebook)
    return (
      <div className="flex-1 p-8 text-sm text-muted-foreground">
        {query.error ?? (query.isPending ? "Opening idea…" : "This idea is no longer available.")}{" "}
        {query.error ? (
          <Button size="sm" variant="outline" onClick={query.refresh}>
            Retry
          </Button>
        ) : null}
      </div>
    );
  const deleteIdea = async () => {
    setBusy(true);
    const result = await dispatch({
      environmentId: threadRef.environmentId,
      input: {
        type: "idea.delete",
        commandId: CommandId.make(randomUUID()),
        threadId: threadRef.threadId,
      },
    });
    setBusy(false);
    setDeleteOpen(false);
    if (result._tag === "Failure") setError(failureMessage(result));
    else {
      useIdeaWorkspaceStore.getState().remove(key);
      query.refresh();
    }
  };
  if (notebook.status === "deleting")
    return (
      <div className="flex-1 space-y-3 p-8 text-sm">
        <p>
          {notebook.deletionError ? "Deletion is incomplete." : "Removing this idea and its files…"}
        </p>
        {notebook.deletionError ? (
          <>
            <p className="text-muted-foreground">{notebook.deletionError}</p>
            <Button onClick={() => void deleteIdea()} disabled={busy}>
              Retry deletion
            </Button>
          </>
        ) : null}
        <Button
          variant="ghost"
          onClick={() =>
            void navigate({ to: "/ideas", search: { environment: undefined, idea: undefined } })
          }
        >
          Back to ideas
        </Button>
      </div>
    );
  const activeEntry = workspace.tabs.find(
    (tab) => ideaTabKey(tab) === workspace.activeTab && tab.kind === "entry",
  );
  const panel = (
    <>
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2">
        <div
          role="tablist"
          aria-label="Idea documents"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-auto"
        >
          {workspace.tabs.map((tab) => (
            <div className="flex shrink-0 items-center" key={ideaTabKey(tab)}>
              <Button
                role="tab"
                aria-selected={workspace.activeTab === ideaTabKey(tab)}
                variant={workspace.activeTab === ideaTabKey(tab) ? "secondary" : "ghost-muted"}
                size="xs"
                onClick={() => useIdeaWorkspaceStore.getState().open(key, tab)}
              >
                {tab.kind === "thread" ? <MessageSquareIcon /> : <FileTextIcon />}
                <span className="max-w-32 truncate">
                  {tab.kind === "thread"
                    ? "Thread"
                    : tab.kind === "entry"
                      ? (notebook.entries.find((entry) => entry.id === tab.id)?.title ??
                        "Deleted note")
                      : (notebook.artifacts.find((artifact) => artifact.id === tab.id)?.name ??
                        "Deleted file")}
                </span>
              </Button>
              {tab.kind !== "thread" ? (
                <PanelTabCloseButton
                  label="Close tab"
                  onClick={() => useIdeaWorkspaceStore.getState().close(key, ideaTabKey(tab))}
                >
                  <FileTextIcon className="size-3" />
                </PanelTabCloseButton>
              ) : null}
            </div>
          ))}
        </div>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Collapse idea sidebar"
          onClick={() => useIdeaWorkspaceStore.getState().toggle(key)}
        >
          <PanelRightIcon />
        </Button>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          className={workspace.activeTab === "thread" ? "flex min-h-0 flex-1 flex-col" : "hidden"}
        >
          <ThreadAudienceContext value="idea">
            <ChatView
              environmentId={threadRef.environmentId}
              threadId={threadRef.threadId}
              routeKind="server"
              ideaWorkspace
              revealMessage={workspace.messageRequest}
            />
          </ThreadAudienceContext>
        </div>
        {workspace.tabs
          .filter((tab) => tab.kind !== "thread")
          .map((tab) => (
            <IdeaReader
              key={ideaTabKey(tab)}
              threadKey={key}
              resource={ideaTabKey(tab)}
              className={
                workspace.activeTab === ideaTabKey(tab)
                  ? "flex min-h-0 flex-1 flex-col overflow-auto"
                  : "hidden"
              }
            >
              {tab.kind === "entry" ? (
                <EntryPanel
                  entry={notebook.entries.find((entry) => entry.id === tab.id)}
                  notebook={notebook}
                  threadKey={key}
                  sendEdit={sendEdit}
                  openEntry={openEntry}
                />
              ) : tab.kind === "artifact" ? (
                <ArtifactPanel
                  threadRef={threadRef}
                  artifact={notebook.artifacts.find((artifact) => artifact.id === tab.id)}
                  onDelete={(artifact) => sendEdit({ kind: "artifact.delete", id: artifact.id })}
                />
              ) : null}
            </IdeaReader>
          ))}
      </div>
    </>
  );
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <IdeaReader
        threadKey={key}
        resource="notebook"
        className="min-w-0 flex-1 overflow-auto"
        label="Idea notebook"
      >
        <div className="mx-auto max-w-3xl space-y-7 px-5 py-5 md:px-8">
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-auto text-xs text-muted-foreground">
              {notebook.status === "settled" ? "Settled" : "Notebook"}
            </span>
            <Button variant="outline" size="sm" onClick={promote}>
              Promote to issues
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Open idea sidebar"
              onClick={() => useIdeaWorkspaceStore.getState().toggle(key)}
            >
              <PanelRightIcon />
            </Button>
            <Button
              variant="ghost-destructive"
              size="icon-sm"
              aria-label="Delete idea"
              onClick={() => setDeleteOpen(true)}
            >
              <TrashIcon />
            </Button>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            {titleDraft === null ? (
              <>
                <h2 className="mr-auto truncate text-lg font-semibold">{title}</h2>
                <Button size="sm" variant="ghost" onClick={() => setTitleDraft(title)}>
                  Rename
                </Button>
              </>
            ) : (
              <form
                className="mr-auto flex items-center gap-2"
                onSubmit={async (event) => {
                  event.preventDefault();
                  const result = await dispatch({
                    environmentId: threadRef.environmentId,
                    input: {
                      type: "thread.meta.update",
                      commandId: CommandId.make(randomUUID()),
                      threadId: threadRef.threadId,
                      title: titleDraft.trim(),
                    },
                  });
                  if (result._tag === "Failure") setError(failureMessage(result));
                  else {
                    setTitleDraft(null);
                    list.refresh();
                  }
                }}
              >
                <Input
                  aria-label="Idea title"
                  value={titleDraft}
                  maxLength={240}
                  onChange={(event) => setTitleDraft(event.target.value)}
                />
                <Button type="submit" size="sm" disabled={!titleDraft.trim()}>
                  Save title
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setTitleDraft(null)}>
                  Cancel
                </Button>
              </form>
            )}
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                notebook.status === "settled"
                  ? void sendEdit({
                      kind: "idea.reopen",
                      reviewedContentRevision: notebook.contentRevision,
                    })
                  : setSettleOpen(true)
              }
            >
              {notebook.status === "settled" ? "Reopen idea" : "Settle idea"}
            </Button>
          </div>
          <section className="space-y-3">
            <h2 className="text-xl font-semibold">Pitch</h2>
            <NotebookEditor
              threadKey={key}
              resource="pitch"
              entries={notebook.entries}
              document={notebook.pitch}
              sendEdit={sendEdit}
              onEntry={openEntry}
            />
          </section>
          <UpdateStatus notebook={notebook} sendEdit={sendEdit} />
          {notebook.promotion ? (
            <PromotionReview
              notebook={notebook}
              sendEdit={sendEdit}
              onRevise={() => {
                const draft = useComposerDraftStore.getState().draftsByThreadKey[key]?.prompt ?? "";
                useComposerDraftStore
                  .getState()
                  .setPrompt(threadRef, `Revise the proposed issues. ${draft}`);
                useIdeaWorkspaceStore.getState().open(key, { kind: "thread", id: "thread" });
              }}
            />
          ) : null}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Notebook</h2>
              <Button
                size="xs"
                variant="ghost"
                onClick={async () => {
                  const category = notebook.categories[0];
                  if (!category) return;
                  const id = IdeaEntryId.make(randomUUID());
                  if (
                    await sendEdit({
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
              >
                <PlusIcon />
                Add note
              </Button>
            </div>
            {notebook.categories.map((category) => (
              <div key={category.id} className="space-y-1">
                <div className="flex items-center gap-2">
                  <h3 className="py-2 text-xs font-medium text-muted-foreground">
                    {category.name}
                  </h3>
                </div>
                {notebook.entries
                  .filter((entry) => entry.categoryId === category.id)
                  .map((entry) => (
                    <button
                      key={entry.id}
                      className={`flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-accent ${activeEntry?.id === entry.id ? "bg-accent" : ""}`}
                      onClick={() => openEntry(entry.id)}
                    >
                      <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0">
                        <span className="block truncate text-sm">{entry.title}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {entry.document.markdown.slice(0, 110)}
                        </span>
                      </span>
                    </button>
                  ))}
              </div>
            ))}
            <CategoryManager notebook={notebook} sendEdit={sendEdit} />
            {!notebook.entries.length ? (
              <p className="text-sm leading-6 text-muted-foreground">
                Notes will appear as you discuss the idea. The agent keeps related thinking
                together.
              </p>
            ) : null}
          </section>
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Documents and images</h2>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => fileInput.current?.click()}
              >
                <PaperclipIcon />
                Attach
              </Button>
            </div>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={async (event) => {
                const files = [...(event.target.files ?? [])];
                event.target.value = "";
                setBusy(true);
                try {
                  for (const file of files) {
                    if (file.size > 20_000_000)
                      throw new Error("Files must be smaller than 20 MB.");
                    const bytes = new Uint8Array(await file.arrayBuffer());
                    let binary = "";
                    for (let offset = 0; offset < bytes.length; offset += 8192)
                      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
                    const result = await upload({
                      environmentId: threadRef.environmentId,
                      input: {
                        threadId: threadRef.threadId,
                        name: file.name,
                        mediaType: file.type || "application/octet-stream",
                        contentBase64: btoa(binary),
                      },
                    });
                    if (result._tag === "Failure") throw new Error(failureMessage(result));
                  }
                  query.refresh();
                } catch (failure) {
                  setError(failure instanceof Error ? failure.message : "Upload failed.");
                } finally {
                  setBusy(false);
                }
              }}
            />
            {notebook.artifacts.map((artifact) => (
              <button
                key={artifact.id}
                className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-accent"
                onClick={() =>
                  useIdeaWorkspaceStore.getState().open(key, { kind: "artifact", id: artifact.id })
                }
              >
                <FileTextIcon className="size-4 text-muted-foreground" />
                <span className="flex-1 truncate text-sm">{artifact.name}</span>
                <span className="text-xs text-muted-foreground">
                  {Math.ceil(artifact.sizeBytes / 1024)} KB
                </span>
              </button>
            ))}
            {!notebook.artifacts.length ? (
              <p className="text-sm text-muted-foreground">
                Attach references here. Documents the agent creates stay with this idea.
              </p>
            ) : null}
          </section>
        </div>
      </IdeaReader>
      {compact ? (
        <RightPanelSheet
          animationDurationMs={150}
          open={workspace.panelOpen}
          onClose={() => useIdeaWorkspaceStore.getState().toggle(key)}
        >
          {panel}
        </RightPanelSheet>
      ) : (
        <PreviewPanelShell
          mode="inline"
          open={workspace.panelOpen}
          widthStorageKey="t3code:idea-panel-width"
          defaultWidth={500}
        >
          {panel}
        </PreviewPanelShell>
      )}
      <AlertDialog open={settleOpen} onOpenChange={setSettleOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Settle “{title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Move it to settled ideas. Any remaining scope will be set aside. Published issues stay
              available, and you can reopen the idea later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setSettleOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={async () => {
                if (
                  await sendEdit({
                    kind: "idea.settle",
                    reviewedContentRevision: notebook.contentRevision,
                  })
                )
                  setSettleOpen(false);
              }}
            >
              Settle idea
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{title}” permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              Its thread, notebook, documents, images and update history will be removed. This
              cannot be undone. Published issues and their independent attachments will remain.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void deleteIdea()}>
              Delete idea
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

type SendEdit = (edit: IdeaEdit) => Promise<boolean>;

function NotebookEditor({
  threadKey,
  resource,
  document,
  entry,
  categories,
  entries,
  sendEdit,
  onEntry,
}: {
  threadKey: string;
  resource: string;
  document: IdeaNotebook["pitch"];
  entry?: IdeaEntry | undefined;
  categories?: IdeaNotebook["categories"];
  entries?: IdeaNotebook["entries"];
  sendEdit: SendEdit;
  onEntry: (id: string) => void;
}) {
  const workspace = useIdeaWorkspace(threadKey);
  const draft = workspace.drafts[resource];
  const [saving, setSaving] = useState(false);
  const leaseId = useRef(randomUUID());
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const selection = useRef({ start: 0, end: 0 });
  const editing = draft !== undefined;
  useEffect(() => {
    if (!editing) return;
    const id = leaseId.current;
    const begin = () =>
      void sendEdit({
        kind: "edit.begin",
        resource: resource as "pitch" | `entry:${string}` | "categories",
        leaseId: id,
      });
    begin();
    const timer = window.setInterval(begin, 60_000);
    return () => {
      window.clearInterval(timer);
      void sendEdit({ kind: "edit.end", leaseId: id });
    };
  }, [editing, resource, sendEdit]);
  const setDraft = (next: IdeaEditorDraft | null) =>
    useIdeaWorkspaceStore.getState().setDraft(threadKey, resource, next);
  if (!draft)
    return (
      <div className="space-y-3">
        {document.markdown ? (
          <IdeaMarkdown text={document.markdown} onEntry={onEntry} />
        ) : (
          <p className="text-sm leading-6 text-muted-foreground">
            The pitch starts blank. As you discuss the idea, the agent will bring the current
            thinking together here.
          </p>
        )}
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            setDraft({
              baseRevision: document.revision,
              markdown: document.markdown,
              title: entry?.title ?? "",
              categoryId: entry?.categoryId ?? "",
            })
          }
        >
          <PencilIcon />
          Edit
        </Button>
      </div>
    );
  const changedElsewhere = draft.baseRevision !== document.revision;
  return (
    <div className="space-y-3">
      {entry ? (
        <>
          <Input
            aria-label="Note title"
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          />
          <Select
            value={draft.categoryId}
            onValueChange={(value) => {
              if (value) setDraft({ ...draft, categoryId: value });
            }}
          >
            <SelectTrigger aria-label="Note category">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {categories?.map((category) => (
                <SelectItem key={category.id} value={category.id}>
                  {category.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </>
      ) : null}
      <Textarea
        ref={editorRef}
        onSelect={(event) => {
          selection.current = {
            start: event.currentTarget.selectionStart,
            end: event.currentTarget.selectionEnd,
          };
        }}
        aria-label={entry ? "Note content" : "Pitch"}
        value={draft.markdown}
        rows={12}
        onChange={(event) => setDraft({ ...draft, markdown: event.target.value })}
      />
      {entries?.length ? (
        <div className="flex items-center gap-2">
          <LinkIcon className="size-3.5 text-muted-foreground" />
          <Select
            value={null}
            onValueChange={(id) => {
              const target = entries.find((item) => item.id === id);
              if (!target) return;
              const { start, end } = selection.current;
              const label = (draft.markdown.slice(start, end) || target.title).replace(
                /([\\[\]])/g,
                "\\$1",
              );
              const link = `[${label}](idea-entry:${encodeURIComponent(target.id).replace(/\(/g, "%28").replace(/\)/g, "%29")})`;
              setDraft({
                ...draft,
                markdown: draft.markdown.slice(0, start) + link + draft.markdown.slice(end),
              });
              requestAnimationFrame(() => {
                editorRef.current?.focus();
                editorRef.current?.setSelectionRange(start + link.length, start + link.length);
              });
            }}
          >
            <SelectTrigger aria-label="Link selected phrase to a note">
              <SelectValue placeholder="Link a phrase to a note" />
            </SelectTrigger>
            <SelectPopup>
              {entries.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      ) : null}
      {changedElsewhere ? (
        <div role="status" className="space-y-2 text-xs text-muted-foreground">
          <p>
            This {entry ? "note" : "pitch"} changed while you were editing. Your draft is preserved.
          </p>
          <IdeaDisclosure title={<>Read the saved version</>}>
            <pre className="mt-2 whitespace-pre-wrap">{document.markdown}</pre>
          </IdeaDisclosure>
          <Button
            size="xs"
            variant="outline"
            onClick={() => setDraft({ ...draft, baseRevision: document.revision })}
          >
            Keep my draft against this version
          </Button>
        </div>
      ) : null}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={saving || changedElsewhere || (entry !== undefined && !draft.title.trim())}
          onClick={async () => {
            setSaving(true);
            const edit: IdeaEdit = entry
              ? {
                  kind: "entry.save",
                  id: entry.id,
                  baseRevision: draft.baseRevision,
                  title: draft.title,
                  categoryId: IdeaCategoryId.make(draft.categoryId),
                  markdown: draft.markdown,
                  sources: entry.sources,
                }
              : { kind: "pitch.save", baseRevision: draft.baseRevision, markdown: draft.markdown };
            if (await sendEdit(edit)) setDraft(null);
            setSaving(false);
          }}
        >
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function CategoryManager({ notebook, sendEdit }: { notebook: IdeaNotebook; sendEdit: SendEdit }) {
  const [newName, setNewName] = useState("");
  return (
    <IdeaDisclosure title="Organize categories">
      <div className="space-y-3 py-3">
        {notebook.categories.map((category) => (
          <CategoryEditor
            key={category.id}
            category={category}
            notebook={notebook}
            sendEdit={sendEdit}
          />
        ))}
        <div className="flex gap-2">
          <Input
            aria-label="New category name"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!newName.trim()}
            onClick={async () => {
              if (
                await sendEdit({
                  kind: "category.save",
                  id: IdeaCategoryId.make(randomUUID()),
                  baseRevision: 0,
                  name: newName.trim(),
                })
              )
                setNewName("");
            }}
          >
            Add category
          </Button>
        </div>
      </div>
    </IdeaDisclosure>
  );
}

function CategoryEditor({
  category,
  notebook,
  sendEdit,
}: {
  category: IdeaNotebook["categories"][number];
  notebook: IdeaNotebook;
  sendEdit: SendEdit;
}) {
  const [draft, setDraft] = useState<{ name: string; revision: number } | null>(null);
  const leaseId = useRef(randomUUID());
  const editing = draft !== null;
  useEffect(() => {
    if (!editing) return;
    const id = leaseId.current;
    const begin = () => void sendEdit({ kind: "edit.begin", resource: "categories", leaseId: id });
    begin();
    const timer = window.setInterval(begin, 60_000);
    return () => {
      window.clearInterval(timer);
      void sendEdit({ kind: "edit.end", leaseId: id });
    };
  }, [editing, sendEdit]);
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          aria-label={`Category ${category.name}`}
          value={draft?.name ?? category.name}
          onChange={(event) =>
            setDraft({ name: event.target.value, revision: draft?.revision ?? category.revision })
          }
        />
        {draft ? (
          <>
            <Button
              size="xs"
              disabled={!draft.name.trim() || draft.revision !== category.revision}
              onClick={async () => {
                if (
                  await sendEdit({
                    kind: "category.save",
                    id: category.id,
                    baseRevision: draft.revision,
                    name: draft.name.trim(),
                  })
                )
                  setDraft(null);
              }}
            >
              Save
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </>
        ) : null}
      </div>
      {draft && draft.revision !== category.revision ? (
        <p className="text-xs text-muted-foreground">
          This category changed. Cancel to load its current name before renaming.
        </p>
      ) : null}
      <div className="flex gap-2">
        <Select
          value={null}
          onValueChange={(id) => {
            const target = notebook.categories.find((item) => item.id === id);
            if (target)
              void sendEdit({
                kind: "category.merge",
                id: category.id,
                targetId: target.id,
                baseRevision: category.revision,
                targetRevision: target.revision,
              });
          }}
        >
          <SelectTrigger size="sm" aria-label={`Merge ${category.name} into category`}>
            <SelectValue placeholder="Merge into…" />
          </SelectTrigger>
          <SelectPopup>
            {notebook.categories
              .filter((item) => item.id !== category.id)
              .map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}
                </SelectItem>
              ))}
          </SelectPopup>
        </Select>
        <Button
          size="xs"
          variant="ghost-destructive"
          disabled={notebook.entries.some((entry) => entry.categoryId === category.id)}
          onClick={() =>
            void sendEdit({
              kind: "category.delete",
              id: category.id,
              baseRevision: category.revision,
            })
          }
        >
          Delete empty category
        </Button>
      </div>
    </div>
  );
}

function EntryPanel({
  entry,
  notebook,
  threadKey,
  sendEdit,
  openEntry,
}: {
  entry?: IdeaEntry | undefined;
  notebook: IdeaNotebook;
  threadKey: string;
  sendEdit: SendEdit;
  openEntry: (id: string) => void;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  if (!entry)
    return (
      <p className="p-5 text-sm text-muted-foreground">
        This note was removed. Any unsaved draft remains in this session.
      </p>
    );
  return (
    <div className="space-y-5 p-5">
      <div className="flex items-start gap-2">
        <h2 className="mr-auto text-lg font-semibold">{entry.title}</h2>
        <Button
          size="icon-xs"
          variant="ghost-destructive"
          aria-label="Delete note"
          onClick={() => setDeleteOpen(true)}
        >
          <TrashIcon />
        </Button>
      </div>
      <NotebookEditor
        threadKey={threadKey}
        resource={`entry:${entry.id}`}
        document={entry.document}
        entry={entry}
        categories={notebook.categories}
        entries={notebook.entries}
        sendEdit={sendEdit}
        onEntry={openEntry}
      />
      {notebook.entries.length > 1 ? (
        <IdeaDisclosure title="Merge this note">
          <p className="py-2 text-xs text-muted-foreground">
            Append this note to another note. Links will follow the combined note.
          </p>
          <Select
            value={null}
            onValueChange={(id) => {
              const target = notebook.entries.find((item) => item.id === id);
              if (target)
                void sendEdit({
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
          >
            <SelectTrigger aria-label="Merge note into">
              <SelectValue placeholder="Choose destination note" />
            </SelectTrigger>
            <SelectPopup>
              {notebook.entries
                .filter((item) => item.id !== entry.id)
                .map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.title}
                  </SelectItem>
                ))}
            </SelectPopup>
          </Select>
        </IdeaDisclosure>
      ) : null}
      {notebook.artifacts.length ? (
        <IdeaDisclosure title="Attach a document to this note">
          <div className="space-y-2 py-2">
            {notebook.artifacts.map((artifact) => {
              const attached = entry.sources.some(
                (source) => source.kind === "artifact" && source.artifactId === artifact.id,
              );
              return (
                <label key={artifact.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={attached}
                    onCheckedChange={(checked) =>
                      void sendEdit({
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
                  {artifact.name}
                </label>
              );
            })}
          </div>
        </IdeaDisclosure>
      ) : null}
      {entry.sources.length ? (
        <div className="space-y-2 border-t border-border pt-3">
          <h3 className="text-xs text-muted-foreground">Sources</h3>
          {entry.sources.map((source) => (
            <Button
              key={`${source.kind}:${source.kind === "artifact" ? source.artifactId : source.kind === "message" ? source.messageId : source.activityId}`}
              size="xs"
              variant="ghost"
              onClick={() => {
                const store = useIdeaWorkspaceStore.getState();
                if (source.kind === "message") store.openMessage(threadKey, source.messageId);
                else if (source.kind === "artifact")
                  store.open(threadKey, { kind: "artifact", id: source.artifactId });
                else store.openActivity(threadKey, source.activityId);
              }}
            >
              {source.kind === "artifact"
                ? (notebook.artifacts.find((item) => item.id === source.artifactId)?.name ??
                  "Document")
                : source.kind === "activity"
                  ? "Question answer in thread"
                  : "Discussion"}
            </Button>
          ))}
        </div>
      ) : null}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{entry.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This note will be removed and its pitch links cleared. Old discussion will not
              recreate it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (
                  await sendEdit({
                    kind: "entry.delete",
                    id: entry.id,
                    baseRevision: entry.document.revision,
                  })
                ) {
                  useIdeaWorkspaceStore.getState().setDraft(threadKey, `entry:${entry.id}`, null);
                  setDeleteOpen(false);
                }
              }}
            >
              Delete note
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function UpdateStatus({ notebook, sendEdit }: { notebook: IdeaNotebook; sendEdit: SendEdit }) {
  return (
    <div className="space-y-3 text-xs text-muted-foreground" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <span>
          {notebook.update.status === "current"
            ? "Notebook is up to date"
            : notebook.update.status === "waiting"
              ? "Waiting for the conversation"
              : notebook.update.status === "failed"
                ? "Notebook is behind the conversation"
                : "Updating notebook…"}
        </span>
        {notebook.update.status === "failed" ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => void sendEdit({ kind: "update.retry" })}
          >
            Retry
          </Button>
        ) : null}
      </div>
      {notebook.update.error ? <p>{notebook.update.error}</p> : null}
      {notebook.proposals.map((proposal) => (
        <IdeaDisclosure
          key={proposal.id}
          className="rounded-md border border-border p-3"
          title={<>Update needs review</>}
        >
          <p className="mt-3">{proposal.reason}</p>
          <pre className="my-3 max-h-64 overflow-auto whitespace-pre-wrap">
            {proposal.edits
              .map((edit) =>
                "markdown" in edit ? edit.markdown : "name" in edit ? edit.name : edit.kind,
              )
              .join("\n\n")}
          </pre>
          <div className="flex gap-2">
            <Button
              size="xs"
              onClick={() =>
                void sendEdit({
                  kind: "proposal.accept",
                  id: proposal.id,
                  reviewedContentRevision: notebook.contentRevision,
                })
              }
            >
              Apply update
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => void sendEdit({ kind: "proposal.reject", id: proposal.id })}
            >
              Keep current
            </Button>
          </div>
        </IdeaDisclosure>
      ))}
      {notebook.history.length ? (
        <IdeaDisclosure title={<>Update history</>}>
          <div className="mt-2 space-y-2">
            {notebook.history
              .slice(-10)
              .toReversed()
              .map((item) => (
                <div key={item.id} className="flex items-center gap-2">
                  <span className="flex-1">{item.summary}</span>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={item.undone}
                    onClick={() => void sendEdit({ kind: "update.undo", id: item.id })}
                  >
                    {item.undone ? "Undone" : "Undo"}
                  </Button>
                </div>
              ))}
          </div>
        </IdeaDisclosure>
      ) : null}
    </div>
  );
}

function PromotionReview({
  notebook,
  sendEdit,
  onRevise,
}: {
  notebook: IdeaNotebook;
  sendEdit: SendEdit;
  onRevise: () => void;
}) {
  const promotion = notebook.promotion;
  if (!promotion) return null;
  return (
    <section className="space-y-3 rounded-md border border-border p-4">
      <h2 className="text-sm font-semibold">
        {promotion.status === "review" ? "Review issues before publishing" : "Promotion"}
      </h2>
      <p className="text-xs text-muted-foreground">
        {promotion.target.host}/{promotion.target.repository} · Notebook revision{" "}
        {promotion.sourceRevision}
      </p>
      {promotion.drafts.map((draft) => (
        <IdeaDisclosure key={draft.id} title={<>{draft.title}</>}>
          <div className="mt-3">
            <IdeaMarkdown text={draft.body} onEntry={() => {}} />
          </div>
        </IdeaDisclosure>
      ))}
      {promotion.error ? (
        <p role="alert" className="text-sm text-destructive">
          {promotion.error}
        </p>
      ) : null}
      {promotion.remainingScope ? (
        <p className="text-xs text-muted-foreground">Remaining scope: {promotion.remainingScope}</p>
      ) : null}
      {promotion.issues.map((issue) => (
        <a
          key={issue.url}
          className="block text-sm text-primary underline"
          href={issue.url}
          target="_blank"
          rel="noreferrer"
        >
          #{issue.number} {issue.title}
        </a>
      ))}
      {["review", "partial", "failed"].includes(promotion.status) ? (
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() =>
              void sendEdit({
                kind: promotion.status === "review" ? "promotion.approve" : "promotion.retry",
                id: promotion.id,
                sourceRevision: promotion.sourceRevision,
              })
            }
          >
            {promotion.issues.length ? "Retry remaining issues" : "Publish issues"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              if (await sendEdit({ kind: "promotion.reject", id: promotion.id })) onRevise();
            }}
          >
            Revise in thread
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {promotion.status === "complete"
            ? "Published issues are independent of this idea."
            : "Publishing reviewed issues…"}
        </p>
      )}
    </section>
  );
}

function ArtifactPanel({
  threadRef,
  artifact,
  onDelete,
}: {
  threadRef: ScopedThreadRef;
  artifact?: IdeaArtifact | undefined;
  onDelete: (artifact: IdeaArtifact) => Promise<boolean>;
}) {
  const query = useEnvironmentQuery(
    artifact
      ? ideaEnvironment.readArtifact({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, artifactId: artifact.id },
        })
      : null,
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const data = query.data;
  const content = useMemo(
    () =>
      data
        ? Uint8Array.from(atob(data.contentBase64), (character) => character.charCodeAt(0))
        : null,
    [data],
  );
  const text = useMemo(
    () =>
      content &&
      artifact &&
      (artifact.mediaType.startsWith("text/") || /\.(md|txt|json|html)$/i.test(artifact.name))
        ? new TextDecoder().decode(content)
        : null,
    [artifact, content],
  );
  const mediaType = artifact?.mediaType;
  const [blobResource, setBlobResource] = useState<{
    url: string;
    content: Uint8Array;
    mediaType: string;
  } | null>(null);
  const url =
    blobResource?.content === content && blobResource?.mediaType === mediaType
      ? blobResource.url
      : null;
  useEffect(() => {
    if (!content || !mediaType) return;
    const url = URL.createObjectURL(new Blob([content], { type: mediaType }));
    setBlobResource({ url, content, mediaType });
    return () => URL.revokeObjectURL(url);
  }, [mediaType, content]);
  if (!artifact)
    return <p className="p-5 text-sm text-muted-foreground">This document was removed.</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border p-3">
        <span className="min-w-0 flex-1 truncate text-sm">{artifact.name}</span>
        {url ? (
          <Button variant="ghost" size="xs" render={<a href={url} download={artifact.name} />}>
            Download
          </Button>
        ) : null}
        <Button
          variant="ghost-destructive"
          size="icon-xs"
          aria-label="Delete document"
          onClick={() => setConfirmDelete(true)}
        >
          <TrashIcon />
        </Button>
      </div>
      {query.error ? (
        <div className="space-y-2 p-5 text-sm">
          <p>{query.error}</p>
          <Button onClick={query.refresh}>Retry</Button>
        </div>
      ) : !data ? (
        <p className="p-5 text-sm text-muted-foreground">Loading document…</p>
      ) : artifact.mediaType === "text/html" && text !== null ? (
        <iframe
          title={artifact.name}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          className="min-h-96 w-full flex-1 border-0"
          srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none';">${text}`}
        />
      ) : artifact.mediaType.startsWith("image/") && url ? (
        <img alt={artifact.name} src={url} className="max-h-full w-full object-contain p-3" />
      ) : text !== null ? (
        <div className="overflow-auto p-5">
          <IdeaMarkdown text={text} onEntry={() => {}} />
        </div>
      ) : (
        <p className="p-5 text-sm text-muted-foreground">
          A preview is unavailable for this file. Download the original to open it.
        </p>
      )}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{artifact.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The copy stored in this idea will be removed. Your original file remains unchanged.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (await onDelete(artifact)) setConfirmDelete(false);
              }}
            >
              Delete document
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function IdeaReader({
  threadKey,
  resource,
  className,
  label,
  children,
}: {
  threadKey: string;
  resource: string;
  className: string;
  label?: string;
  children: React.ReactNode;
}) {
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    node.scrollTop = readIdeaPosition(threadKey, resource);
    const save = () => saveIdeaPosition(threadKey, resource, node.scrollTop);
    node.addEventListener("scroll", save, { passive: true });
    return () => {
      node.removeEventListener("scroll", save);
    };
  }, [threadKey, resource]);
  return (
    <div ref={element} aria-label={label} className={className}>
      {children}
    </div>
  );
}

function IdeaDisclosure({
  title,
  children,
  className,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <Collapsible>
        <CollapsibleTrigger render={<Button variant="ghost" size="xs" />}>
          {title}
        </CollapsibleTrigger>
        <CollapsiblePanel keepMounted>{children}</CollapsiblePanel>
      </Collapsible>
    </div>
  );
}
