import {
  FactoryError,
  type FactoryWorkflowVersion,
  type ProviderInstanceMutation,
  type ServerSettings as ServerSettingsValue,
  type ServerSettingsError,
  type ServerSettingsPatch,
  SkillsRepositoryError,
} from "@t3tools/contracts";
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
    /**
     * Applies a client's settings write. A non-empty skills repository must be a Git repository
     * with `skills/` committed at HEAD, and is stored as its real absolute path.
     */
    readonly updateSettings: (
      patch: ServerSettingsPatch,
      providerInstanceMutation?: ProviderInstanceMutation,
    ) => Effect.Effect<ServerSettingsValue, ServerSettingsError | SkillsRepositoryError>;
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
      updateSettings: Effect.fn("FactorySkills.updateSettings")(function* (
        patch: ServerSettingsPatch,
        providerInstanceMutation?: ProviderInstanceMutation,
      ) {
        const requested = patch.engineeringManagersSkillsRepository;
        const repository = requested
          ? yield* sources.skillsHead(requested).pipe(
              Effect.mapError(
                (cause) =>
                  new SkillsRepositoryError({
                    repositoryPath: requested,
                    reason: cause.detail ?? cause.message,
                  }),
              ),
            )
          : undefined;
        const next =
          repository === undefined
            ? patch
            : { ...patch, engineeringManagersSkillsRepository: repository.repositoryRoot };
        return yield* providerInstanceMutation === undefined
          ? settings.updateSettings(next)
          : settings.updateProviderInstance(providerInstanceMutation, next);
      }),
    });
  }),
);
