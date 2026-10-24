import type { FactoryTeamUses } from "@t3tools/contracts";

/**
 * The confirmation for deleting a team. It names the managers whose onboarding result lists the
 * team, and says when it is the last team, but never blocks: deleting stays the user's call.
 * `uses` is null when the check itself failed.
 */
export function factoryTeamDeleteMessage(input: {
  readonly name: string;
  readonly uses: FactoryTeamUses | null;
  readonly lastTeam: boolean;
}): string {
  const managers = input.uses?.managers ?? [];
  return [
    `Delete the team ${input.name}? Its lead and member copies go with it. Workers and leads stay.`,
    input.uses === null
      ? "Satellite could not check which managers use it."
      : managers.length === 0
        ? null
        : `Used by: ${managers.map((manager) => `${manager.name} (${manager.projectTitle})`).join(", ")}. Those managers can no longer pick it.`,
    input.lastTeam
      ? "No teams will be left; managers can't commission work until you add one."
      : null,
  ]
    .filter((sentence) => sentence !== null)
    .join(" ");
}
