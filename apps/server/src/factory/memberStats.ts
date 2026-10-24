/** What one member thread used, summed over its provider turns. */
interface ThreadUsage {
  readonly input: number;
  readonly cachedInput: number;
  readonly output: number;
  readonly agentMs: number;
}

interface MemberStatsInput {
  readonly threadId: string;
  /** Null for a lead, or a worker on a team staffed by role. */
  readonly memberName: string | null;
  readonly joined: string;
}

interface MemberStats {
  readonly name: string;
  /** Threads the lead delegated as this member; sub-agents are not delegations. */
  readonly delegations: number;
  readonly tokens: {
    readonly input: number;
    readonly cachedInput: number;
    readonly output: number;
  };
  readonly agentMs: number;
}

/**
 * Usage per team member, in the team's own member order, then any other name in the order it first
 * joined. A sub-agent joins under its parent's member name, so its tokens and time count toward
 * that member without counting as a delegation.
 */
export function rollupMemberStats(
  members: ReadonlyArray<MemberStatsInput>,
  usage: ReadonlyMap<string, ThreadUsage>,
  order: ReadonlyArray<string> = [],
): ReadonlyArray<MemberStats> {
  const byName = new Map<
    string,
    { delegations: number; input: number; cachedInput: number; output: number; agentMs: number }
  >();
  for (const member of members) {
    if (member.memberName === null) continue;
    const tally = byName.get(member.memberName) ?? {
      delegations: 0,
      input: 0,
      cachedInput: 0,
      output: 0,
      agentMs: 0,
    };
    byName.set(member.memberName, tally);
    if (member.joined === "created") tally.delegations += 1;
    const used = usage.get(member.threadId);
    if (used === undefined) continue;
    tally.input += used.input;
    tally.cachedInput += used.cachedInput;
    tally.output += used.output;
    tally.agentMs += used.agentMs;
  }
  const rank = (name: string) => {
    const index = order.indexOf(name);
    return index === -1 ? order.length : index;
  };
  // A stable sort keeps the join order among names the team does not list.
  return [...byName]
    .toSorted(([left], [right]) => rank(left) - rank(right))
    .map(([name, tally]) => ({
      name,
      delegations: tally.delegations,
      tokens: { input: tally.input, cachedInput: tally.cachedInput, output: tally.output },
      agentMs: tally.agentMs,
    }));
}
