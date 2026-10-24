import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  FactoryAssignmentState,
  FactoryManagerState,
  FactoryMember,
  FactoryRole,
  FactoryWorkspaceAssignment,
  FactoryWorkspaceFeed,
  FactoryWorkspaceManager,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import type { TimelineEntry } from "~/session-logic";
import type { ChatMessage } from "~/types";

export const FACTORY_MANAGER_STATE_LABEL: Record<FactoryManagerState, string> = {
  onboarding: "Onboarding",
  ready: "Ready",
  active: "Active",
  "manager-paused": "Paused",
  "project-paused": "Paused with teams",
  retired: "Retired",
};

export const FACTORY_ASSIGNMENT_STATE_LABEL: Record<FactoryAssignmentState, string> = {
  active: "Active",
  blocked: "Blocked",
  "waiting-user": "Waiting for you",
  stalled: "Stalled",
  retro: "Retro",
  completed: "Completed",
  cancelled: "Cancelled",
};

const FACTORY_ROLE_LABEL: Record<FactoryRole, string> = {
  manager: "Manager",
  lead: "Lead",
  implementer: "Implementer",
  reviewer: "Reviewer",
  verifier: "Verifier",
  worker: "Worker",
};

/** A member delegated by name, on a team built from definitions, is shown by that name. */
export const factoryMemberLabel = (member: {
  readonly role: FactoryRole;
  readonly memberName?: string;
}) => member.memberName ?? FACTORY_ROLE_LABEL[member.role];

export const isLiveAssignment = (assignment: Pick<FactoryWorkspaceAssignment, "state">) =>
  assignment.state !== "completed" && assignment.state !== "cancelled";

/** `retro` holds the manager but frees its slot under the concurrency cap. */
export const takesAssignmentSlot = (assignment: Pick<FactoryWorkspaceAssignment, "state">) =>
  isLiveAssignment(assignment) && assignment.state !== "retro";

/**
 * Lead and team threads of every live manager. The sidebar shows only the manager's thread; the
 * rest live in its workspace panel. A retired manager's members come back to the sidebar.
 */
export function factoryMemberThreadKeys(
  feeds: ReadonlyMap<EnvironmentId, FactoryWorkspaceFeed>,
): Set<string> {
  const keys = new Set<string>();
  for (const [environmentId, feed] of feeds) {
    const liveManagers = new Set(
      feed.managers.filter((manager) => manager.state !== "retired").map((manager) => manager.id),
    );
    for (const member of feed.members) {
      if (member.role === "manager" || member.endedAt !== null) continue;
      if (!liveManagers.has(member.managerId)) continue;
      keys.add(scopedThreadKey(scopeThreadRef(environmentId, member.threadId)));
    }
  }
  return keys;
}

export type FactoryThreadPlace =
  | { readonly kind: "manager"; readonly manager: FactoryWorkspaceManager }
  | {
      readonly kind: "lead" | "member";
      readonly manager: FactoryWorkspaceManager;
      readonly member: FactoryMember;
      readonly assignment: FactoryWorkspaceAssignment | null;
    };

/** Where a thread sits in the factory: a manager, a lead, another team member, or nowhere. */
export function resolveFactoryThreadPlace(
  feed: FactoryWorkspaceFeed | undefined,
  threadId: ThreadId,
): FactoryThreadPlace | null {
  if (!feed) return null;
  const manager = feed.managers.find(
    (candidate) => candidate.threadId === threadId && candidate.state !== "retired",
  );
  if (manager) return { kind: "manager", manager };
  const member = feed.members.find(
    (candidate) =>
      candidate.threadId === threadId && candidate.role !== "manager" && candidate.endedAt === null,
  );
  if (!member) return null;
  const owner = feed.managers.find(
    (candidate) => candidate.id === member.managerId && candidate.state !== "retired",
  );
  if (!owner) return null;
  const assignment =
    member.assignmentId === null
      ? null
      : (feed.assignments.find((candidate) => candidate.id === member.assignmentId) ?? null);
  const isLead = member.role === "lead" && assignment?.leadThreadId === member.threadId;
  return { kind: isLead ? "lead" : "member", manager: owner, member, assignment };
}

export interface FactoryWorkspaceTeam {
  readonly assignment: FactoryWorkspaceAssignment;
  /** The lead first, then the other members in the order the feed lists them. */
  readonly threads: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly role: FactoryRole;
    readonly memberName?: string;
  }>;
}

export interface FactoryWorkspaceView {
  readonly manager: FactoryWorkspaceManager & { readonly threadId: ThreadId };
  readonly teams: ReadonlyArray<FactoryWorkspaceTeam>;
  /** The team whose thread is open, so the workspace opens on it; `null` on the manager's thread. */
  readonly activeAssignmentId: string | null;
}

/** The manager workspace a thread belongs to, with each live work item's team. */
export function resolveFactoryWorkspaceView(
  feed: FactoryWorkspaceFeed | undefined,
  threadId: ThreadId,
): FactoryWorkspaceView | null {
  const place = resolveFactoryThreadPlace(feed, threadId);
  if (!feed || !place || place.manager.threadId === null) return null;
  const manager = { ...place.manager, threadId: place.manager.threadId };
  const teams = feed.assignments
    .filter((assignment) => assignment.managerId === manager.id && isLiveAssignment(assignment))
    .map((assignment) => {
      const members = feed.members.filter(
        (member) =>
          member.assignmentId === assignment.id &&
          member.endedAt === null &&
          member.threadId !== assignment.leadThreadId,
      );
      return {
        assignment,
        threads: [
          ...(assignment.leadThreadId === null
            ? []
            : [{ threadId: assignment.leadThreadId, role: "lead" as const }]),
          ...members.map((member) => ({
            threadId: member.threadId,
            role: member.role,
            ...(member.memberName === undefined ? {} : { memberName: member.memberName }),
          })),
        ],
      };
    });
  // A completed or cancelled assignment is not in `teams`, so its thread opens on no team.
  const open = place.kind === "manager" ? null : (place.assignment?.id ?? null);
  const activeAssignmentId =
    open !== null && teams.some((team) => team.assignment.id === open) ? open : null;
  return { manager, teams, activeAssignmentId };
}

/** The newest pickup or skip in a manager's log, which `log.list` returns newest first. */
export function describePickupDecision(entry: {
  readonly kind: string;
  readonly reason: string;
  readonly payload: unknown;
}): string {
  const payload = entry.payload as { readonly issue?: { readonly number?: unknown } } | null;
  const issueNumber = typeof payload?.issue?.number === "number" ? payload.issue.number : null;
  const verb = entry.kind === "skip" ? "Skipped" : "Picked up";
  const subject = issueNumber === null ? verb : `${verb} #${issueNumber}`;
  return entry.reason.trim() === "" ? subject : `${subject}: ${entry.reason.trim()}`;
}

// The timeline recomputes its rows whenever its entries change identity, and does so during
// render, so a fresh fold for the same input would loop. One fold is kept per entries array.
const primingFolds = new WeakMap<
  ReadonlyArray<TimelineEntry>,
  { readonly primingMessageId: MessageId; readonly entries: ReadonlyArray<TimelineEntry> }
>();

/**
 * Folds a primed manager thread's first exchange into one entry: the priming message the server
 * sent from the approved onboarding result, the work of that turn, and the manager's first reply.
 * The priming is found by id, never by position or text: history is windowed, so the first loaded
 * message may be a real request. Without the priming in the window, nothing folds. The same input
 * returns the same array.
 */
export function collapseFactoryPriming(
  entries: ReadonlyArray<TimelineEntry>,
  primingMessageId: MessageId,
): ReadonlyArray<TimelineEntry> {
  const cached = primingFolds.get(entries);
  if (cached?.primingMessageId === primingMessageId) return cached.entries;
  const folded = foldPriming(entries, primingMessageId);
  primingFolds.set(entries, { primingMessageId, entries: folded });
  return folded;
}

function foldPriming(
  entries: ReadonlyArray<TimelineEntry>,
  primingMessageId: MessageId,
): ReadonlyArray<TimelineEntry> {
  const start = entries.findIndex(
    (entry) => entry.kind === "message" && entry.message.id === primingMessageId,
  );
  const prompt = entries[start];
  if (prompt?.kind !== "message") return entries;
  // The fold ends at the reply, or before any later user message if the reply hasn't come.
  let end = start;
  let reply: ChatMessage | null = null;
  for (let index = start + 1; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.kind === "message" && entry.message.role === "user") break;
    end = index;
    if (entry.kind === "message" && entry.message.role === "assistant") {
      reply = entry.message;
      break;
    }
  }
  const rest = entries.slice(end + 1);
  return [
    ...entries.slice(0, start),
    {
      id: `factory-priming:${prompt.id}`,
      kind: "factory-priming",
      createdAt: prompt.createdAt,
      prompt: prompt.message,
      reply,
      continued: rest.some((entry) => entry.kind === "message" && entry.message.role === "user"),
    },
    ...rest,
  ];
}
