import type {
  FactoryTeamDefinition,
  FactoryTeamMemberDefinition,
  FactoryTeamSpec,
} from "@t3tools/contracts";

/**
 * Which factory team an assignment is staffed by. Teams come from the factory config; a manager
 * staffs only the teams its onboarding result lists, and an empty list allows every team.
 */

const NO_LEGACY_TEAMS =
  "Teams come from the factory config. Pick a team id from factory_definitions.";

type TeamPick =
  | { readonly kind: "team"; readonly team: FactoryTeamDefinition }
  | { readonly kind: "refused"; readonly message: string };

const ids = (teams: ReadonlyArray<FactoryTeamDefinition>) =>
  teams.map((team) => team.id).join(", ") || "none";

export function pickFactoryTeam(
  teams: ReadonlyArray<FactoryTeamDefinition>,
  allowedTeamIds: ReadonlyArray<string>,
  request: { readonly teamId?: string | undefined; readonly team: FactoryTeamSpec },
): TeamPick {
  const allowed =
    allowedTeamIds.length === 0 ? teams : teams.filter((team) => allowedTeamIds.includes(team.id));
  const staff = (team: FactoryTeamDefinition | undefined, asked: string): TeamPick => {
    if (team === undefined)
      return { kind: "refused", message: `There is no team "${asked}". Teams: ${ids(teams)}.` };
    return allowed.includes(team)
      ? { kind: "team", team }
      : {
          kind: "refused",
          message: `You may not staff ${team.name}. Your teams: ${ids(allowed)}.`,
        };
  };

  if (request.teamId !== undefined)
    return staff(
      teams.find((team) => team.id === request.teamId),
      request.teamId,
    );
  // An older caller names a team by its preset name; a factory team with that id or name serves.
  const { preset, members } = request.team;
  if (preset !== "custom") {
    const wanted = preset.toLowerCase();
    const named = teams.find((team) => team.id === preset || team.name.toLowerCase() === wanted);
    return named === undefined
      ? { kind: "refused", message: NO_LEGACY_TEAMS }
      : staff(named, preset);
  }
  if (members.length > 0) return { kind: "refused", message: NO_LEGACY_TEAMS };
  const first = allowed[0];
  return first === undefined
    ? {
        kind: "refused",
        message:
          teams.length === 0
            ? "The factory config has no teams. Ask the user to add one in Settings."
            : `None of your teams are in the factory config. Your teams: ${allowedTeamIds.join(", ")}.`,
      }
    : { kind: "team", team: first };
}

/** A lead delegates to a member by its name, which is unique in the team; case does not matter. */
export function findTeamMember(
  team: FactoryTeamDefinition,
  name: string,
): FactoryTeamMemberDefinition | undefined {
  const wanted = name.trim().toLowerCase();
  return team.members.find((member) => member.name.toLowerCase() === wanted);
}
