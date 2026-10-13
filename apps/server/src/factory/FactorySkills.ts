import { FactoryError, type FactoryWorkflowVersion } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as FactorySource from "./FactorySource.ts";

const factorySkillsRequired = "Set the skills repository in Settings → General first.";

/**
 * The environment's skills repository, set in Settings → General. Committing to it is how a skill
 * change is adopted: whatever a command creates records `head` as its pin, and a running
 * assignment keeps the commit it started with.
 */
export class FactorySkills extends Context.Service<
  FactorySkills,
  {
    /** The commit at HEAD of the configured repository now. Refuses a missing or unusable one. */
    readonly head: Effect.Effect<FactoryWorkflowVersion, FactoryError>;
    /** Refuses a path that is not a Git repository with `skills/` at HEAD. */
    readonly validate: (repositoryRoot: string) => Effect.Effect<void, FactoryError>;
  }
>()("t3/factory/FactorySkills") {}

export const layer = Layer.effect(
  FactorySkills,
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const sources = yield* FactorySource.FactorySource;
    return FactorySkills.of({
      head: Effect.gen(function* () {
        const { engineeringManagersSkillsRepository: root } = yield* settings.getSettings.pipe(
          Effect.mapError((cause) => new FactoryError({ code: "persistence", cause })),
        );
        if (root === "")
          return yield* new FactoryError({ code: "invalid-state", detail: factorySkillsRequired });
        return yield* sources.skillsHead(root).pipe(
          Effect.mapError(
            (cause) =>
              new FactoryError({
                code: "invalid-state",
                detail: `${factorySkillsRequired} ${cause.detail ?? ""}`.trim(),
              }),
          ),
        );
      }),
      validate: (repositoryRoot) => sources.skillsHead(repositoryRoot).pipe(Effect.asVoid),
    });
  }),
);
