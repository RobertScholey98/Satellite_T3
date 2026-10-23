import { scopeThreadRef } from "@t3tools/client-runtime/environment";
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

import type { TimelineEntry } from "~/session-logic";
import { render } from "../../../test/render";
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

// The timeline's own path: the folded entries feed the incremental row derivation. The probe opts
// out of the compiler so each render hands the hook a fresh thread ref, as an unmemoised caller does.
function PrimedTimeline(props: { readonly tick: number }) {
  // oxlint-disable-next-line t3code/no-manual-memo -- the test stands in for a caller the compiler leaves alone.
  "use no memo";
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

it("holds a manager's thread as loading until the managers feed arrives", async () => {
  state.managers = undefined;
  await using screen = await render(<PrimedTimeline tick={1} />);
  await expect.element(screen.getByText("factory-priming · render 1")).toBeVisible();
});
