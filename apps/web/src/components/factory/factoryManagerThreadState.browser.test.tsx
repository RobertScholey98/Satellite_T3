import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
  type FactoryManager,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  managers: undefined as ReadonlyArray<FactoryManager> | undefined,
}));
vi.mock(import("./factoryState"), async (importOriginal) => ({
  ...(await importOriginal()),
  useFactoryManagers: () => state.managers,
}));
// The workspace feed says which threads are a manager's; this suite is about the fold itself.
vi.mock(import("./factoryWorkspaceState"), async (importOriginal) => ({
  ...(await importOriginal()),
  useIsFactoryManagerThread: () => true,
}));

import type { LegendListRef } from "@legendapp/list/react";
import { createRef } from "react";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import type { TimelineEntry } from "~/session-logic";
import { render } from "../../../test/render";
import { MessagesTimeline } from "../chat/MessagesTimeline";
import { useIncrementalTimelineRows } from "../chat/useTimelineRows";
import { useFactoryPrimedTimelineEntries } from "./factoryManagerThreadState";

const environmentId = EnvironmentId.make("local");
const threadId = ThreadId.make("primed-thread");
const at = "2026-10-23T12:00:00.000Z";
const message = (id: string, role: "user" | "assistant", text: string): TimelineEntry => ({
  id,
  kind: "message",
  createdAt: at,
  message: {
    id: MessageId.make(id),
    role,
    text,
    runId: null,
    streaming: false,
    createdAt: at,
    updatedAt: at,
  },
});
const ENTRIES = [message("priming", "user", "Primed"), message("ready", "assistant", "Ready.")];
const NO_SUMMARIES: never[] = [];

const manager: FactoryManager = {
  id: "manager",
  projectId: ProjectId.make("project"),
  name: "Ada",
  state: "active",
  threadId,
  onboardingThreadId: ThreadId.make("onboarding-thread"),
  primingMessageId: MessageId.make("priming"),
  onboardingProposal: null,
  onboardingResult: null,
  modelSelection: null,
  activeAssignments: 0,
  waitingOnYou: 0,
  createdAt: at,
  updatedAt: at,
};

// The timeline's own path: the folded entries feed the incremental row derivation.
function PrimedTimeline(props: { readonly tick: number }) {
  const entries = useFactoryPrimedTimelineEntries(ENTRIES, scopeThreadRef(environmentId, threadId));
  const rows = useIncrementalTimelineRows("primed-thread", {
    timelineEntries: entries,
    latestRun: null,
    isWorking: false,
    turnDiffSummaries: NO_SUMMARIES,
    supportsConversationRollback: false,
  });
  return (
    <p>
      {rows.map((row) => row.kind).join(",")} · render {props.tick}
    </p>
  );
}

it("keeps a primed thread's rows stable across re-renders", async () => {
  state.managers = [manager];
  await using screen = await render(<PrimedTimeline tick={1} />);
  await expect.element(screen.getByText("factory-priming · render 1")).toBeVisible();

  await screen.rerender(<PrimedTimeline tick={2} />);
  await expect.element(screen.getByText("factory-priming · render 2")).toBeVisible();
});

it("shows a primed manager thread's conversation with its priming collapsed", async () => {
  state.managers = [manager];
  // The timeline sizes its virtualized list from the container.
  const container = document.createElement("div");
  container.style.cssText = "height: 1200px; width: 900px; display: flex; flex-direction: column;";
  await using screen = await render(
    <MessagesTimeline
      timelineEntries={ENTRIES}
      routeThreadKey={scopedThreadKey(scopeThreadRef(environmentId, threadId))}
      activeThreadEnvironmentId={environmentId}
      isWorking={false}
      activeTurnInProgress={false}
      listRef={createRef<LegendListRef | null>()}
      latestRun={null}
      turnDiffSummaries={NO_SUMMARIES}
      runs={[]}
      onOpenTurnDiff={() => {}}
      onOpenThread={() => {}}
      onForkFromRun={async () => {}}
      onRollbackCheckpoint={() => {}}
      supportsConversationRollback={false}
      onRevertToTurnCount={() => {}}
      isRevertingCheckpoint={false}
      onImageExpand={() => {}}
      markdownCwd={undefined}
      resolvedTheme="light"
      timestampFormat="locale"
      workspaceRoot={undefined}
      anchorMessageId={null}
      onAnchorReady={() => {}}
      onAnchorSizeChanged={() => {}}
      contentInsetEndAdjustment={0}
      emptyPlaceholderInset={0}
      liveFollowEnabled
      onIsAtEndChange={() => {}}
    />,
    { container },
  );

  const priming = screen.getByRole("button", {
    name: "Primed from the approved onboarding result",
  });
  await expect.element(priming).toHaveAttribute("aria-expanded", "false");
  await expect.element(screen.getByText("Primed", { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByText("Ready.")).not.toBeInTheDocument();

  await userEvent.click(priming);
  await expect.element(screen.getByText("Primed", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Ready.")).toBeVisible();
});

it("holds a manager's thread as loading until the managers feed arrives", async () => {
  state.managers = undefined;
  await using screen = await render(<PrimedTimeline tick={1} />);
  await expect.element(screen.getByText("factory-priming · render 1")).toBeVisible();
});
