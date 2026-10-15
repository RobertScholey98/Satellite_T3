// @vitest-environment jsdom
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EMPTY_THREAD_HISTORY_META,
  type EnvironmentThreadState,
} from "@t3tools/client-runtime/state/threads";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, type Atom } from "effect/reactivity";
import { act, createRef, memo, Profiler, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useRouter: () => ({ navigate: async () => {}, state: { matches: [] } }),
  useNavigate: () => async () => {},
  useParams: () => ({}),
  useLocation: () => ({ pathname: "/" }),
}));

// The thread detail store runs on a writable source instead of a server
// subscription; every selector above it is the real one.
vi.mock("../../state/threads", async (original) => {
  const actual = await original<typeof import("../../state/threads")>();
  const { Atom } = await import("effect/reactivity");
  const { createEnvironmentThreadDetailAtoms } =
    await import("@t3tools/client-runtime/state/threads");
  const testThreadSource = Atom.make(
    AsyncResult.success<EnvironmentThreadState>({
      data: Option.none(),
      status: "empty",
      error: Option.none(),
      history: EMPTY_THREAD_HISTORY_META,
    }),
  );
  const details = createEnvironmentThreadDetailAtoms(() => testThreadSource);
  return {
    ...actual,
    testThreadSource,
    environmentThreadDetails: details,
    environmentIdeaThreadDetails: details,
  };
});

import * as threads from "../../state/threads";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { useThreadProjection } from "../../state/entities";
import { useThreadContextWindow, useThreadPendingRequests } from "../../state/threadViewModel";
import { ChatComposer, type ChatComposerProps } from "./ChatComposer";
import { ChatHeader } from "./ChatHeader";

const testThreadSource = (
  threads as unknown as {
    readonly testThreadSource: Atom.Writable<AsyncResult.AsyncResult<EnvironmentThreadState>>;
  }
).testThreadSource;

const now = DateTime.makeUnsafe("2026-10-15T00:00:00.000Z");
const environmentId = EnvironmentId.make("environment-streaming");
const threadId = ThreadId.make("thread-streaming");
const threadRef = scopeThreadRef(environmentId, threadId);
const runId = RunId.make("run-streaming");
const providerInstanceId = ProviderInstanceId.make("codex");

function assistantItem(text: string): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make("item-assistant"),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "running",
    title: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    type: "assistant_message",
    messageId: MessageId.make("message-assistant"),
    text,
    streaming: true,
  };
}

const baseProjection: OrchestrationV2ThreadProjection = {
  thread: {
    id: threadId,
    projectId: ProjectId.make("project-streaming"),
    title: "Streaming thread",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
  runs: [],
  attempts: [],
  nodes: [],
  subagents: [],
  providerSessions: [],
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [],
  messages: [
    {
      id: MessageId.make("message-user"),
      threadId,
      runId,
      nodeId: null,
      role: "user",
      createdBy: "user",
      creationSource: "web",
      text: "Explain the reducer",
      attachments: [],
      streaming: false,
      createdAt: now,
      updatedAt: now,
    },
  ],
  plans: [],
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems: [],
  updatedAt: now,
};

/** One streaming delta: the assistant text grows and nothing else the chrome shows moves. */
function streamText(text: string): OrchestrationV2ThreadProjection {
  const item = assistantItem(text);
  return {
    ...baseProjection,
    turnItems: [item],
    visibleTurnItems: [
      { position: 0, visibility: "local", sourceThreadId: threadId, sourceItemId: item.id, item },
    ],
    updatedAt: DateTime.add(now, { seconds: text.length }),
  };
}

function publish(projection: OrchestrationV2ThreadProjection) {
  appAtomRegistry.set(
    testThreadSource,
    AsyncResult.success({
      data: Option.some(projection),
      status: "live",
      error: Option.none(),
      history: EMPTY_THREAD_HISTORY_META,
    }),
  );
}

const noop = () => {};
const composerProps = {
  composerDraftTarget: threadRef,
  environmentId,
  canOperateThread: true,
  attachmentUploadsCapabilityKnown: true,
  supportsAttachmentUploads: true,
  supportsQuestionAttachments: true,
  maxFileAttachmentBytes: null,
  routeKind: "server",
  routeThreadRef: threadRef,
  draftId: null,
  multipleModelSelections: null,
  supportsMultipleModels: false,
  onMultipleModelSelectionsChange: noop,
  activeThreadId: threadId,
  activeThreadEnvironmentId: environmentId,
  activeThreadProviderInstanceId: providerInstanceId,
  activeThreadShell: null,
  isServerThread: true,
  isLocalDraftThread: false,
  forceExpandedOnMobile: false,
  projectSelectionRequired: false,
  phase: "running",
  canInterrupt: true,
  isConnecting: false,
  isSendBusy: false,
  canResume: false,
  sendDisabledReason: null,
  isPreparingWorktree: false,
  bannerItems: [],
  resumeCompactionTokens: null,
  onSendWithFullHistory: noop,
  environmentUnavailable: null,
  activePendingProgress: null,
  activePendingResolvedAnswers: null,
  activePendingIsResponding: false,
  activePendingDraftAnswers: {},
  activePendingQuestionIndex: 0,
  respondingRequestIds: [],
  showPlanFollowUpPrompt: false,
  activeProposedPlan: null,
  activeTasksProgress: null,
  activeTaskSteps: null,
  threadSyncPhase: null,
  runtimeMode: "full-access",
  interactionMode: "default",
  lockedProvider: null,
  providerStatuses: [],
  providerCatalogKnown: true,
  activeProjectDefaultModelSelection: null,
  activeThreadModelSelection: null,
  compactThreadUnavailable: false,
  compactDisabled: false,
  compactDisabledReason: null,
  resolvedTheme: "light",
  settings: DEFAULT_UNIFIED_SETTINGS,
  keybindings: [],
  terminalOpen: false,
  gitCwd: null,
  pullRequestProjectId: null,
  pullRequestRepository: null,
  restingControlsHost: null,
  restingControlsHaveLeadingContext: false,
  onRestingControlsVisibilityChange: noop,
  getTimelineScrollableNode: () => null,
  isTimelineAtLogicalEnd: () => true,
  timelineOverflows: false,
  onComposerOverlayHeightChange: noop,
  onRestingChange: noop,
  promptRef: { current: "" },
  composerImagesRef: { current: [] },
  composerFilesRef: { current: [] },
  composerTerminalContextsRef: { current: [] },
  composerRef: createRef(),
  onPageScrollKeyDown: noop,
  onPageScrollKeyUp: noop,
  onPageScrollRelease: noop,
  editingQueuedAttachments: null,
  onRemoveEditingQueuedAttachment: noop,
  onCompactContext: noop,
  onSend: noop,
  onResume: noop,
  onInterrupt: noop,
  onImplementPlanInNewThread: noop,
  onRespondToApproval: async () => undefined,
  onSelectActivePendingUserInputOption: noop,
  onAdvanceActivePendingUserInput: noop,
  onDismissActivePendingUserInput: noop,
  onPreviousActivePendingUserInputQuestion: noop,
  onChangeActivePendingUserInputCustomAnswer: noop,
  onProviderModelSelect: noop,
  onOpenProviderSetup: noop,
  getModelDisabledReason: () => null,
  toggleInteractionMode: noop,
  handleRuntimeModeChange: noop,
  handleInteractionModeChange: noop,
  focusComposer: noop,
  scheduleComposerFocus: noop,
  setThreadError: noop,
  onExpandImage: noop,
  onFileOpen: noop,
} satisfies Omit<
  ChatComposerProps,
  "pendingApprovals" | "pendingUserInputs" | "activePendingApproval" | "activeContextWindow"
>;

const commits = { chatView: 0, header: 0, composer: 0 };
const countChatView = () => (commits.chatView += 1);
const countHeader = () => (commits.header += 1);
const countComposer = () => (commits.composer += 1);

// A Profiler re-reports whenever its parent re-renders, even when the memoized
// child bails out. Placing it behind a memo boundary over the same props makes
// it report exactly the commits in which the chrome component itself rendered.
const ProfiledHeader = memo(function ProfiledHeader(props: ComponentProps<typeof ChatHeader>) {
  return (
    <Profiler id="header" onRender={countHeader}>
      <ChatHeader {...props} />
    </Profiler>
  );
});
const ProfiledComposer = memo(function ProfiledComposer(props: ChatComposerProps) {
  return (
    <Profiler id="composer" onRender={countComposer}>
      <ChatComposer {...props} />
    </Profiler>
  );
});

/**
 * Stands in for ChatView: it subscribes to the whole projection, so it
 * re-renders on every delta, and feeds the chrome its thread state through
 * the same view model selectors ChatView uses.
 */
function ChatViewStandIn() {
  useThreadProjection(threadRef);
  const pending = useThreadPendingRequests(threadRef);
  const activeContextWindow = useThreadContextWindow(threadRef);
  return (
    <>
      <ProfiledHeader
        activeThreadEnvironmentId={environmentId}
        activeThreadId={threadId}
        activeThreadTitle={baseProjection.thread.title}
        isServerThread
        activeProject={null}
        rightPanelOpen={false}
        onNewThreadInProject={noop}
      />
      <ProfiledComposer
        {...composerProps}
        pendingApprovals={pending.approvals}
        pendingUserInputs={pending.userInputs}
        activePendingApproval={pending.activeApproval}
        activeContextWindow={activeContextWindow}
      />
    </>
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = ((media: string) => ({
    matches: false,
    media,
    onchange: null,
    addEventListener: noop,
    removeEventListener: noop,
    addListener: noop,
    removeListener: noop,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { addEventListener: noop, removeEventListener: noop, ready: Promise.resolve() },
  });
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  commits.chatView = 0;
  commits.header = 0;
  commits.composer = 0;
  publish(baseProjection);
});

async function mountChatView() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <AppAtomRegistryProvider>
        <Profiler id="chat-view" onRender={countChatView}>
          <ChatViewStandIn />
        </Profiler>
      </AppAtomRegistryProvider>,
    );
  });
  return { mounted: { ...commits }, unmount: () => act(async () => root.unmount()) };
}

async function streamDeltas(count: number): Promise<string> {
  let text = "";
  for (let delta = 0; delta < count; delta += 1) {
    text += `token-${delta} `;
    await act(async () => publish(streamText(text)));
  }
  return text;
}

describe("chat chrome while a response streams", () => {
  it("re-renders neither the composer nor the header for message-content updates", async () => {
    const { mounted, unmount } = await mountChatView();
    await streamDeltas(20);
    expect({
      chatView: commits.chatView - mounted.chatView,
      header: commits.header - mounted.header,
      composer: commits.composer - mounted.composer,
    }).toEqual({ chatView: 20, header: 0, composer: 0 });
    await unmount();
  });

  it("re-renders the composer once when a sent prompt joins its recall history", async () => {
    const { mounted, unmount } = await mountChatView();
    const text = await streamDeltas(3);
    await act(async () =>
      publish({
        ...streamText(text),
        messages: [
          ...baseProjection.messages,
          {
            ...baseProjection.messages[0]!,
            id: MessageId.make("message-follow-up"),
            text: "And the projector?",
          },
        ],
      }),
    );
    expect(commits.composer - mounted.composer).toBe(1);
    await unmount();
  });
});
