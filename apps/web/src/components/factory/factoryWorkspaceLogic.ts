import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { OlderSettledScope } from "@t3tools/client-runtime/state/threads";
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
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import type { TimelineEntry } from "~/session-logic";
import type { ChatMessage } from "~/types";
import { DETAILS_CARD_CLEARANCE } from "../chat/chatCanvasLayout";
import {
  THREAD_DETAILS_CARD_GAP,
  THREAD_DETAILS_CARD_WIDTH,
} from "../chat/threadDetailsCardLayout";

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
  for (const { key } of factoryHiddenMembers(feeds)) keys.add(key);
  return keys;
}

export interface FactoryHiddenMember {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly key: string;
}

/** The threads `factoryMemberThreadKeys` hides, each with its manager's project. */
export function factoryHiddenMembers(
  feeds: ReadonlyMap<EnvironmentId, FactoryWorkspaceFeed>,
): Array<FactoryHiddenMember> {
  const hidden: Array<FactoryHiddenMember> = [];
  for (const [environmentId, feed] of feeds) {
    const liveManagers = new Map(
      feed.managers
        .filter((manager) => manager.state !== "retired")
        .map((manager) => [manager.id, manager] as const),
    );
    for (const member of feed.members) {
      if (member.role === "manager" || member.endedAt !== null) continue;
      const manager = liveManagers.get(member.managerId);
      if (manager === undefined) continue;
      hidden.push({
        environmentId,
        projectId: manager.projectId,
        key: scopedThreadKey(scopeThreadRef(environmentId, member.threadId)),
      });
    }
  }
  return hidden;
}

/**
 * Team threads the server counts as older settled but the sidebar never lists, to take off the
 * Settled shelf's count. The shell holds every thread but the older settled ones, so a hidden
 * member's thread the client does not hold is one of those.
 */
export function unloadedFactoryMemberCount(input: {
  readonly members: ReadonlyArray<FactoryHiddenMember>;
  readonly scopes: ReadonlyArray<OlderSettledScope>;
  readonly heldThreadKeys: ReadonlySet<string>;
  readonly omitsOlderSettled: (environmentId: EnvironmentId) => boolean;
}): number {
  let count = 0;
  for (const member of input.members) {
    if (input.heldThreadKeys.has(member.key)) continue;
    const scope = input.scopes.find((each) => each.environmentId === member.environmentId);
    if (scope === undefined || !input.omitsOlderSettled(member.environmentId)) continue;
    if (scope.projectIds !== null && !scope.projectIds.includes(member.projectId)) continue;
    count += 1;
  }
  return count;
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
  /** Live teams, the open thread's first and then the newest. */
  readonly teams: ReadonlyArray<FactoryWorkspaceTeam>;
  /** The team whose thread is open; `null` on the manager's thread. */
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
  // The feed lists assignments oldest first, so the newest come from the end.
  const teams = feed.assignments
    .toReversed()
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
  const active = open === null ? undefined : teams.find((team) => team.assignment.id === open);
  return {
    manager,
    teams: active ? [active, ...teams.filter((team) => team !== active)] : teams,
    activeAssignmentId: active?.assignment.id ?? null,
  };
}

/** What a factory thread shows beside its chat, apart from the details card. */
export interface FactoryWorkspacePlace {
  /** Team threads lead back to their manager's thread. */
  readonly backToManager: boolean;
  /** The right-hand column of team cards, shown while any team is live. */
  readonly teamColumn: boolean;
}

export const factoryWorkspacePlace = (
  view: FactoryWorkspaceView,
  threadId: ThreadId,
): FactoryWorkspacePlace => ({
  backToManager: threadId !== view.manager.threadId,
  teamColumn: view.teams.length > 0,
});

/** Back to manager's height above the details card, in whichever corner the card takes. */
export const FACTORY_BACK_CONTROL_HEIGHT = 44;

/** The manager's own thread, or one of its team threads. */
export type FactoryThreadKind = "manager" | "team";

export const factoryThreadKind = (place: FactoryWorkspacePlace): FactoryThreadKind =>
  place.backToManager ? "team" : "manager";

/** One card in the column around a factory thread's details card. */
export interface FactoryStackSlot {
  readonly key: string;
  readonly visibleOn: ReadonlyArray<FactoryThreadKind>;
  /**
   * A card above the details card needs a fixed height: the details card is placed from it before
   * anything renders. Cards below it are measured.
   */
  readonly height?: number;
}

/** The details card's slot. The chat view renders the card; the stack only leaves it room. */
export const FACTORY_DETAILS_SLOT = "details";

/** The stack's cards that show on a thread, either side of the details card, in order. */
export function resolveFactoryThreadStack<Slot extends FactoryStackSlot>(
  stack: ReadonlyArray<Slot>,
  kind: FactoryThreadKind,
) {
  const visible = stack.filter((slot) => slot.visibleOn.includes(kind));
  const details = visible.findIndex((slot) => slot.key === FACTORY_DETAILS_SLOT);
  const above = details < 0 ? visible : visible.slice(0, details);
  return {
    above,
    below: details < 0 ? [] : visible.slice(details + 1),
    /** How far below the column's top the details card starts. */
    detailsTopInset: above.reduce(
      (inset, slot) => inset + (slot.height ?? 0) + THREAD_DETAILS_CARD_GAP,
      0,
    ),
  };
}

/**
 * Whether a factory thread's details card takes the top-left gutter: only while the card, the
 * lane's clearance and a readable lane fit beside the team column. Otherwise it stays at the top
 * right, as on every other thread. Decided from the canvas width and the lane's padding and
 * minimum width, which the card does not change, so moving the card cannot flip the decision.
 */
export function resolveFactoryDetailsCardSide(input: {
  readonly container: { readonly width: number };
  readonly lane: { readonly padding: number; readonly minChatWidth: number };
  readonly teamColumn: boolean;
}): "left" | "right" {
  const cardEdge = THREAD_DETAILS_CARD_GAP + THREAD_DETAILS_CARD_WIDTH;
  const laneLeft = cardEdge + DETAILS_CARD_CLEARANCE;
  const laneRight = input.teamColumn
    ? input.container.width - cardEdge - DETAILS_CARD_CLEARANCE
    : input.container.width - input.lane.padding;
  return laneRight - laneLeft >= input.lane.minChatWidth ? "left" : "right";
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
 * Folds a primed manager thread's priming message, that turn's work, and the first reply into one
 * entry. The priming is found by id, never by position or text: history is windowed, so the first
 * loaded message may be a real request. Without the priming in the window, nothing folds.
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
