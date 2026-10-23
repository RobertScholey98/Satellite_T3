import type { FactoryRole, FactoryRoleBrief, ModelSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { DEFAULT_ROLE_SKILLS } from "./roles/index.ts";

export interface RoleSkillFill {
  readonly modelPool: ReadonlyArray<ModelSelection>;
  readonly allowedModels: ReadonlyArray<ModelSelection>;
  readonly protectedPaths: ReadonlyArray<string>;
  readonly completionCondition: string | null;
  readonly pickupGuidance: string;
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
    pickupGuidance: fill.pickupGuidance.trim() || "(none: nothing auto-starts)",
  };
  return text.replace(/\{\{(\w+)\}\}/g, (token, name: string) => values[name] ?? token);
};

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
