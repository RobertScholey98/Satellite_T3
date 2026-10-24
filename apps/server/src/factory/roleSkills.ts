import type {
  FactoryModelList,
  FactoryModelRef,
  FactoryOnboardingResult,
  FactoryRole,
  FactoryRoleBrief,
  FactoryTeamDefinition,
  ModelSelection,
} from "@t3tools/contracts";

import { DEFAULT_ROLE_SKILLS } from "./roles/index.ts";

/** A model named by a provider instance, or portably by driver as definitions name it. */
type NamedModel = ModelSelection | FactoryModelRef;

export interface RoleSkillFill {
  readonly modelPool: ReadonlyArray<NamedModel>;
  readonly allowedModels: ReadonlyArray<NamedModel>;
  readonly protectedPaths: ReadonlyArray<string>;
  readonly completionCondition: string | null;
}

export type RoleSkillSource = Pick<FactoryRoleBrief, "text" | "source">;

const NONE = "(none configured)";

const list = (items: ReadonlyArray<string>) =>
  items.length === 0 ? NONE : items.map((item) => `- ${item}`).join("\n");

const modelLabel = (model: NamedModel) =>
  "driver" in model ? `${model.driver}/${model.model}` : `${model.instanceId}/${model.model}`;

const models = (selections: ReadonlyArray<NamedModel>) => list(selections.map(modelLabel));

/** Fills every placeholder a role skill may use; unknown `{{...}}` text is left alone. */
export const renderRoleSkill = (text: string, fill: RoleSkillFill): string => {
  const values: Record<string, string> = {
    modelPool: models(fill.modelPool),
    allowedModels: models(fill.allowedModels),
    protectedPaths: list(fill.protectedPaths),
    completionCondition: fill.completionCondition?.trim() || "(no assignment yet)",
    // Text written before guidance moved onto the onboarding result still names it.
    pickupGuidance: "(see the Project section)",
  };
  return text.replace(/\{\{(\w+)\}\}/g, (token, name: string) => values[name] ?? token);
};

/**
 * What the user approved for this project, appended after a manager's or lead's rendered role
 * skill. It stays one block, apart from the role text, so a rebuilt role skill can compose it.
 */
export const projectSection = (result: FactoryOnboardingResult): string => {
  const purpose = result.purpose.trim();
  const guidance = result.pickup.guidance.trim();
  const pickup = result.pickup.enabled
    ? `Pickup is on. Judge each ticket you are offered against this guidance:\n\n${guidance || "Recommend every ticket to the user; start none on your own."}`
    : "Pickup is off. No ticket is offered on its own; work starts when the user asks for it.";
  const rules = result.rules.map((rule) => `- ${rule.question}: ${rule.answer}`);
  return [
    "# Project",
    ...(purpose === "" ? [] : [purpose]),
    `## Pickup\n\n${pickup}`,
    ...(rules.length === 0 ? [] : [`## Project rules\n\n${rules.join("\n")}`]),
  ].join("\n\n");
};

/** A rendered role skill with the project section after it, once onboarding is approved. */
export const withProjectSection = (rendered: string, result: FactoryOnboardingResult | null) =>
  result === null ? rendered : `${rendered}\n\n${projectSection(result)}`;

/**
 * A role's built-in text. Managers and leads have fixed protocols that definitions only add to;
 * the named worker roles keep the starter workers' built-in descriptions for assignments staffed
 * by role. A `worker` has no built-in text: its definition's description is its whole brief.
 * Override files are retired, so nothing here reads the disk.
 */
export const roleSkillSource = (role: FactoryRole): RoleSkillSource => ({
  text: DEFAULT_ROLE_SKILLS[role],
  source: "default",
});

/**
 * A fixed protocol followed by the instructions its definition copy adds, with placeholders in
 * both filled. Empty instructions add nothing.
 */
export const protocolBrief = (
  protocol: string,
  instructions: string | null | undefined,
  fill: RoleSkillFill,
): string => {
  const added = instructions?.trim() ?? "";
  return renderRoleSkill(added === "" ? protocol : `${protocol}\n\n${added}`, fill);
};

/** The manager's brief: protocol, its definition's instructions, then the project section. */
export const managerBrief = (input: {
  readonly protocol: string;
  readonly instructions: string | null | undefined;
  readonly fill: RoleSkillFill;
  readonly result: FactoryOnboardingResult | null;
}): string =>
  withProjectSection(protocolBrief(input.protocol, input.instructions, input.fill), input.result);

/**
 * A lead's first message: protocol, the team's lead instructions, the project section, the
 * assignment, then the team it staffs.
 */
export const leadBrief = (input: {
  readonly protocol: string;
  readonly instructions: string | null | undefined;
  readonly fill: RoleSkillFill;
  readonly result: FactoryOnboardingResult | null;
  readonly assignment: {
    readonly title: string;
    readonly brief: string;
    readonly completionCondition: string;
  };
  readonly team: string | null;
}): string =>
  [
    withProjectSection(protocolBrief(input.protocol, input.instructions, input.fill), input.result),
    `# Assignment\n\n## ${input.assignment.title}\n\n${input.assignment.brief}\n\n## Completion condition\n\n${input.assignment.completionCondition}`,
    ...(input.team === null ? [] : [input.team]),
  ].join("\n\n");

const modelListLine = (list: FactoryModelList) => {
  const named = list.models.map(modelLabel).join(", ");
  if (list.dynamic)
    return named === "" ? "any pool model, you pick per task" : `${named} (you pick per task)`;
  return named === "" ? "any pool model" : `${named} (in this order)`;
};

/** The lead's view of a team built from definitions: who it delegates to, by name. */
export const definitionTeamSection = (team: FactoryTeamDefinition): string => {
  const members = team.members.map(
    (member) => `- ${member.name}, up to ${member.count} at once: ${modelListLine(member.models)}`,
  );
  return [
    `# Team\n\n${team.name}`,
    ...(team.workflow.trim() === "" ? [] : [team.workflow.trim()]),
    `## Members\n\nDelegate to a member by its name with \`factory_delegate\`.\n\n${members.join("\n")}`,
    team.mayEditProtectedPaths
      ? "This team may edit the project's protected paths."
      : "This team may not edit the project's protected paths.",
  ].join("\n\n");
};

/**
 * Rules every worker gets whatever its definition says, since users keep their own copies of the
 * starter descriptions.
 */
const WORKER_RULES = `# Working on the team

- Your final turn result is your handback to the lead. Do not message other sessions, even to
  reach the lead.
- Write content that holds escape sequences or template literals with the Write or Edit tool.
  Keep shell one-liners to plain search and replace: on Windows, heredocs and \`node -e\` turn
  \`\\n\` inside strings into real newlines.
- A test or reproduction you write only to check something is not a change to the code: run it
  in a throwaway worktree outside the lead's, and never commit it.`;

/** The end of every worker's first message: the fixed worker rules, then the lead's task. */
export const workerTask = (task: string): string => `${WORKER_RULES}\n\n# Task\n\n${task}`;

/**
 * A team member's first message: its description with placeholders filled, the project section,
 * the worker rules, then the task.
 */
export const workerBrief = (
  member: { readonly description: string },
  fill: RoleSkillFill & {
    readonly result: FactoryOnboardingResult | null;
    readonly task: string;
  },
): string =>
  `${withProjectSection(renderRoleSkill(member.description, fill), fill.result)}\n\n${workerTask(fill.task)}`;
