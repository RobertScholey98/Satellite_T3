import type {
  FactoryOnboardingResult,
  FactoryRole,
  FactoryRoleBrief,
  ModelSelection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { DEFAULT_ROLE_SKILLS } from "./roles/index.ts";

export interface RoleSkillFill {
  readonly modelPool: ReadonlyArray<ModelSelection>;
  readonly allowedModels: ReadonlyArray<ModelSelection>;
  readonly protectedPaths: ReadonlyArray<string>;
  readonly completionCondition: string | null;
}

export type RoleSkillSource = Pick<FactoryRoleBrief, "text" | "source">;

const NONE = "(none configured)";

const list = (items: ReadonlyArray<string>) =>
  items.length === 0 ? NONE : items.map((item) => `- ${item}`).join("\n");

const models = (selections: ReadonlyArray<ModelSelection>) =>
  list(selections.map((selection) => `${selection.instanceId}/${selection.model}`));

/** Fills every placeholder a role skill may use; unknown `{{...}}` text is left alone. */
export const renderRoleSkill = (text: string, fill: RoleSkillFill): string => {
  const values: Record<string, string> = {
    modelPool: models(fill.modelPool),
    allowedModels: models(fill.allowedModels),
    protectedPaths: list(fill.protectedPaths),
    completionCondition: fill.completionCondition?.trim() || "(no assignment yet)",
    // Role files written before guidance moved onto the onboarding result still name it.
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
 * A role's skill: the project's own file, then the environment's, then the built-in default.
 * An unreadable file falls through like a missing one so a bad override cannot stop the factory.
 */
export const roleSkillSource = Effect.fn("FactoryRoleSkills.source")(function* (
  role: FactoryRole,
  roots: { readonly projectRoot: string; readonly baseDir: string },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const read = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.map((text): string | null => text),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
      Effect.catch((cause) =>
        Effect.logDebug("factory role skill unreadable", { file, cause }).pipe(Effect.as(null)),
      ),
    );
  const project = yield* read(
    path.join(roots.projectRoot, ".satellite", "factory", "roles", `${role}.md`),
  );
  if (project !== null) return { text: project, source: "project" } satisfies RoleSkillSource;
  const environment = yield* read(path.join(roots.baseDir, "factory", "roles", `${role}.md`));
  if (environment !== null)
    return { text: environment, source: "environment" } satisfies RoleSkillSource;
  return { text: DEFAULT_ROLE_SKILLS[role], source: "default" } satisfies RoleSkillSource;
});
