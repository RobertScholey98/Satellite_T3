import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type IssueAttemptLink,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, type Atom } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { QueuedThreadMessage } from "./thread-outbox-model";

const state = vi.hoisted(() => ({
  cleanups: [] as Array<() => void>,
  start: vi.fn(),
  getIssue: vi.fn(),
  reserve: vi.fn(),
  prepare: vi.fn(),
  manager: null as unknown as ReturnType<
    typeof import("./thread-outbox-manager").createThreadOutboxManager
  >,
  config: {
    providers: [{ instanceId: "codex", driver: "codex" }],
    environment: { label: "Laptop", capabilities: {} },
  },
}));
vi.mock("react", () => ({
  useCallback: <A>(callback: A) => callback,
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) state.cleanups.push(cleanup);
  },
  useRef: <A>(value: A) => ({ current: value }),
  useState: <A>(initial: A) => [initial, vi.fn()],
}));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("@effect/atom-react", async () => {
  const { appAtomRegistry } = await import("./atom-registry");
  return { useAtomValue: <A>(atom: Atom.Atom<A>) => appAtomRegistry.get(atom) };
});
vi.mock("./session", () => ({
  readEnvironmentScope: (_environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope,
  useEnvironmentsWithScope: () => new Set(["laptop"]),
}));
vi.mock("./entities", () => ({
  useProjects: () => [],
  useServerConfigs: () => new Map([["laptop", state.config]]),
}));
vi.mock("./server", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    serverEnvironment: { configValueAtom: Atom.family((_id: string) => Atom.make(state.config)) },
  };
});
vi.mock("./threads", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    threadEnvironment: { startTurn: state.start },
    environmentThreadShells: { threadShellsAtom: Atom.make([]) },
  };
});
vi.mock("./issues", () => ({
  issuesEnvironment: { get: state.getIssue, reserveAttempt: state.reserve },
}));
vi.mock("./use-atom-command", () => ({ useAtomCommand: <A>(command: A) => command }));
vi.mock("../lib/modelOptions", () => ({ isModelSelectionUnavailable: () => false }));
vi.mock("../lib/uuid", () => ({ uuidv4: () => "uuid", randomHex: () => "abcd" }));
vi.mock("../lib/attachmentUpload", () => ({ prepareTurnAttachments: state.prepare }));
vi.mock("./use-remote-environment-registry", () => ({
  useRemoteConnectionStatus: () => ({
    connectedEnvironments: [{ environmentId: "laptop", connectionState: "connected" }],
  }),
}));
vi.mock("./thread-outbox", async () => {
  const { createThreadOutboxManager } = await import("./thread-outbox-manager");
  const { appAtomRegistry } = await import("./atom-registry");
  state.manager = createThreadOutboxManager({
    registry: appAtomRegistry,
    storage: {
      load: async () => ({ messages: [], errors: [] }),
      write: async () => {},
      remove: async () => {},
    },
  });
  return {
    threadOutboxManager: state.manager,
    threadOutboxRevision: (id: MessageId) => state.manager.revisionOf(id),
    confirmThreadOutboxMessageQueued: (message: QueuedThreadMessage) =>
      state.manager.confirmQueued(message),
    updateThreadOutboxMessage: (message: QueuedThreadMessage, revision?: number) =>
      state.manager.update(message, revision),
  };
});
vi.mock("./thread-outbox-removal", () => ({
  removeThreadOutboxMessage: (message: QueuedThreadMessage, revision?: number) =>
    state.manager.remove(message, revision),
}));
vi.mock("./use-thread-outbox", async () => {
  const { Atom } = await import("effect/reactivity");
  const { appAtomRegistry } = await import("./atom-registry");
  await import("./thread-outbox");
  return {
    editingQueuedMessageIdsAtom: Atom.make({}).pipe(Atom.keepAlive),
    dispatchingQueuedMessageIdAtom: Atom.make<MessageId | null>(null).pipe(Atom.keepAlive),
    useThreadOutboxMessages: () => appAtomRegistry.get(state.manager.queuedMessagesByThreadKeyAtom),
    useThreadOutboxShellStatuses: () => new Map([["laptop", "live"]]),
  };
});
vi.mock("./use-composer-drafts", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    composerDraftsAtom: Atom.make({}),
    removeDeliveredCloudQueuedMessage: async () => {},
  };
});

import { appAtomRegistry } from "./atom-registry";
import { dispatchingQueuedMessageIdAtom } from "./use-thread-outbox";
import { useThreadOutboxDrain } from "./use-thread-outbox-drain";

const LAPTOP = EnvironmentId.make("laptop");
const ISSUE_REF = {
  hostKind: "github" as const,
  host: "github.com",
  repository: "acme/app",
  id: "I_7",
  number: 7,
  url: "https://github.com/acme/app/issues/7",
};
const RESERVATION: IssueAttemptLink = {
  attemptId: "attempt-1",
  reservationId: "reservation-1",
  sourceEnvironmentId: LAPTOP,
  sourceProjectId: ProjectId.make("project"),
  boardId: "board",
  issue: ISSUE_REF,
  destinationEnvironmentId: LAPTOP,
  sourceGeneration: 0,
};
const QUEUED: QueuedThreadMessage = {
  environmentId: LAPTOP,
  threadId: ThreadId.make("issue-thread"),
  commandId: CommandId.make("command"),
  messageId: MessageId.make("message"),
  text: "Start work on issue #7",
  attachments: [],
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  creation: {
    projectId: ProjectId.make("project"),
    projectCwd: "/repo",
    workspaceMode: "worktree",
    branch: "main",
    worktreePath: null,
  },
  issue: {
    sourceEnvironmentId: LAPTOP,
    sourceProjectId: ProjectId.make("project"),
    boardId: "board",
    issue: ISSUE_REF,
    title: "Checkout fails",
    worktreeName: "issue-7",
    requestId: "request",
  },
  createdAt: "2026-10-15T10:00:00.000Z",
};

const remaining = () =>
  Object.values(appAtomRegistry.get(state.manager.queuedMessagesByThreadKeyAtom)).flat();

function runDrain() {
  const settled = Promise.withResolvers<void>();
  const release = appAtomRegistry.subscribe(dispatchingQueuedMessageIdAtom, (id) => {
    if (id === null) settled.resolve();
  });
  useThreadOutboxDrain();
  return settled.promise.finally(release);
}

beforeEach(() => {
  appAtomRegistry.set(state.manager.queuedMessagesByThreadKeyAtom, {});
  appAtomRegistry.set(dispatchingQueuedMessageIdAtom, null);
  state.start.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.getIssue.mockReset().mockResolvedValue(
    AsyncResult.success({
      ref: ISSUE_REF,
      title: "Checkout fails",
      state: "open",
      updatedAt: "2026-10-14T00:00:00.000Z",
      labels: [],
      body: "Paying with a saved card throws.",
    }),
  );
  state.reserve.mockReset().mockResolvedValue(AsyncResult.success(RESERVATION));
  state.prepare.mockReset().mockImplementation(async ({ attachments }) => ({
    status: "ready",
    attachments: [],
    draftAttachments: attachments,
    pendingAttachmentIds: [],
  }));
});
afterEach(() => {
  state.cleanups.splice(0).forEach((cleanup) => cleanup());
});

describe("queued issue work", () => {
  it("creates the thread in the issue's worktree with its attempt and issue text", async () => {
    await state.manager.enqueue(QUEUED);
    await runDrain();

    expect(state.start).toHaveBeenCalledOnce();
    const { input } = state.start.mock.calls[0]![0];
    expect(input.bootstrap.issueAttempt).toEqual(RESERVATION);
    expect(input.bootstrap.prepareWorktree).toEqual({
      projectCwd: "/repo",
      baseBranch: "main",
      branch: "issue-7",
      requireWorktree: true,
    });
    expect(input.message.text).toBe(
      "Start work on issue #7\n\n<attached_issue>\nRepository host: github.com\nIssue: #7 Checkout fails\nURL: https://github.com/acme/app/issues/7\n\nPaying with a saved card throws.\n</attached_issue>",
    );
    expect(remaining()).toEqual([]);
  });

  it("keeps the reservation when the socket drops and reuses it on the next attempt", async () => {
    state.start.mockResolvedValueOnce(
      AsyncResult.failure(
        Cause.fail(
          new EnvironmentRpcUnavailableError({ environmentId: LAPTOP, message: "Offline." }),
        ),
      ),
    );
    await state.manager.enqueue(QUEUED);
    await runDrain();

    expect(remaining()).toEqual([
      { ...QUEUED, issue: { ...QUEUED.issue!, reservation: RESERVATION } },
    ]);

    await runDrain();

    expect(state.reserve).toHaveBeenCalledOnce();
    expect(state.start).toHaveBeenCalledTimes(2);
    expect(state.start.mock.calls[1]![0].input.bootstrap.issueAttempt).toEqual(RESERVATION);
    expect(remaining()).toEqual([]);
  });
});
