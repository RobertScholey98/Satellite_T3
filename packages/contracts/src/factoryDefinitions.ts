import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import {
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { ProviderOptionSelections } from "./model.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

/**
 * The portable factory config: definitions stored as files under `<T3 home>/factory/` rather than
 * database rows, so one config can serve many projects and travel between machines. Nothing here
 * names a project, a provider instance, a machine path or a secret.
 */

/** A definition's file or folder name. Derived from its name at creation and never changed. */
export const FactoryDefinitionId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
);
export type FactoryDefinitionId = typeof FactoryDefinitionId.Type;

/**
 * A model named by driver rather than provider instance, since instance ids differ between
 * machines. Files write it as `driver/model`; the model part may itself contain slashes.
 */
export const FactoryModelRef = Schema.Struct({
  driver: ProviderDriverKind,
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ProviderOptionSelections),
});
export type FactoryModelRef = typeof FactoryModelRef.Type;

/**
 * A priority order by default: the first model the environment can run is used. A dynamic list is
 * a menu the starter of the agent picks from per task.
 */
export const FactoryModelList = Schema.Struct({
  dynamic: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  models: Schema.Array(FactoryModelRef).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type FactoryModelList = typeof FactoryModelList.Type;

const DefinitionName = TrimmedNonEmptyString.check(Schema.isMaxLength(80));
const DefinitionText = TrimmedString.check(Schema.isMaxLength(20_000));

const WorkerFields = {
  id: FactoryDefinitionId,
  name: DefinitionName,
  models: FactoryModelList,
  /** What the worker is and does: its whole brief before the project section. */
  description: DefinitionText,
};

/** Added to the fixed lead or manager protocol, never replacing it. */
const ProtocolFields = {
  id: FactoryDefinitionId,
  name: DefinitionName,
  models: FactoryModelList,
  instructions: DefinitionText,
};

export const FactoryWorkerDefinition = Schema.Struct(WorkerFields);
export type FactoryWorkerDefinition = typeof FactoryWorkerDefinition.Type;

export const FactoryLeadDefinition = Schema.Struct(ProtocolFields);
export type FactoryLeadDefinition = typeof FactoryLeadDefinition.Type;

export const FactoryManagerDefinition = Schema.Struct(ProtocolFields);
export type FactoryManagerDefinition = typeof FactoryManagerDefinition.Type;

/** A team's own copy of a worker. Its name is what a lead delegates by, unique in the team. */
export const FactoryTeamMemberDefinition = Schema.Struct({
  ...WorkerFields,
  count: PositiveInt.check(Schema.isLessThanOrEqualTo(8)),
});
export type FactoryTeamMemberDefinition = typeof FactoryTeamMemberDefinition.Type;

export const FactoryTeamDefinition = Schema.Struct({
  id: FactoryDefinitionId,
  name: DefinitionName,
  /** Free text the manager matches against a ticket. */
  useWhen: TrimmedString.check(Schema.isMaxLength(1000)),
  /** How the team works together; the lead follows it. */
  workflow: DefinitionText,
  /** The team may edit the paths the project protects. */
  mayEditProtectedPaths: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  createdBy: Schema.Literals(["user", "manager"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("user" as const)),
  ),
  /** The team's own copy of a lead. */
  lead: FactoryLeadDefinition,
  members: Schema.Array(FactoryTeamMemberDefinition).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(12),
  ),
});
export type FactoryTeamDefinition = typeof FactoryTeamDefinition.Type;

export const FACTORY_CONFIG_FORMAT_VERSION = 1;

/** `factory.yaml`: what applies to the whole factory config rather than one definition. */
export const FactoryConfigSettings = Schema.Struct({
  version: Schema.Literal(FACTORY_CONFIG_FORMAT_VERSION),
  /** The factory-wide allow-list. Every model a definition lists must be in it. */
  modelPool: Schema.Array(FactoryModelRef).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Diagnosis-and-replan cycles per assignment. */
  recoveryAllowance: NonNegativeInt.check(Schema.isLessThanOrEqualTo(10)).pipe(
    Schema.withDecodingDefault(Effect.succeed(1)),
  ),
});
export type FactoryConfigSettings = typeof FactoryConfigSettings.Type;

/** A file that could not be used. The rest of the config still loads. */
export const FactoryConfigProblem = Schema.Struct({
  /** Relative to the factory config directory, with forward slashes. */
  path: Schema.String,
  message: Schema.String,
});
export type FactoryConfigProblem = typeof FactoryConfigProblem.Type;

export const FactoryDefinitions = Schema.Struct({
  settings: FactoryConfigSettings,
  workers: Schema.Array(FactoryWorkerDefinition),
  leads: Schema.Array(FactoryLeadDefinition),
  managers: Schema.Array(FactoryManagerDefinition),
  teams: Schema.Array(FactoryTeamDefinition),
});
export type FactoryDefinitions = typeof FactoryDefinitions.Type;

/** What the environment read from its factory config directory. */
export const FactoryDefinitionsView = Schema.Struct({
  ...FactoryDefinitions.fields,
  /** False while `factory.yaml` is missing: nothing has been saved or migrated yet. */
  configured: Schema.Boolean,
  problems: Schema.Array(FactoryConfigProblem),
});
export type FactoryDefinitionsView = typeof FactoryDefinitionsView.Type;

export const FactoryDefinitionKind = Schema.Literals(["worker", "lead", "manager", "team"]);
export type FactoryDefinitionKind = typeof FactoryDefinitionKind.Type;

/** A team member as edited: a new member has no id yet and gets one from its name. */
export const FactoryTeamMemberDraft = FactoryTeamMemberDefinition.mapFields(
  Struct.assign({ id: Schema.optionalKey(FactoryDefinitionId) }),
);
export type FactoryTeamMemberDraft = typeof FactoryTeamMemberDraft.Type;

const withoutId = <Fields extends { readonly id: unknown }>(fields: Fields) =>
  Struct.omit(fields, ["id"]);

/**
 * A definition to save. Without an `id` it is created, with an id derived from its name; with
 * one, that definition is replaced and its id is kept.
 */
export const FactoryDefinitionSaveInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("worker"),
    id: Schema.optionalKey(FactoryDefinitionId),
    definition: FactoryWorkerDefinition.mapFields(withoutId),
  }),
  Schema.Struct({
    kind: Schema.Literal("lead"),
    id: Schema.optionalKey(FactoryDefinitionId),
    definition: FactoryLeadDefinition.mapFields(withoutId),
  }),
  Schema.Struct({
    kind: Schema.Literal("manager"),
    id: Schema.optionalKey(FactoryDefinitionId),
    definition: FactoryManagerDefinition.mapFields(withoutId),
  }),
  Schema.Struct({
    kind: Schema.Literal("team"),
    id: Schema.optionalKey(FactoryDefinitionId),
    definition: FactoryTeamDefinition.mapFields((fields) => ({
      ...withoutId(fields),
      members: Schema.Array(FactoryTeamMemberDraft).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(12),
      ),
    })),
  }),
]);
export type FactoryDefinitionSaveInput = typeof FactoryDefinitionSaveInput.Type;

export const FactoryDefinitionSaveResult = Schema.Struct({
  /** The saved definition's id: the given one, or the one it was created with. */
  id: FactoryDefinitionId,
  view: FactoryDefinitionsView,
});
export type FactoryDefinitionSaveResult = typeof FactoryDefinitionSaveResult.Type;

export const FactoryDefinitionRemoveInput = Schema.Struct({
  kind: FactoryDefinitionKind,
  id: FactoryDefinitionId,
});
export type FactoryDefinitionRemoveInput = typeof FactoryDefinitionRemoveInput.Type;

/**
 * A factory config as files, for export and import. The client zips and unzips it; the server
 * never archives the config directory, so nothing outside the definitions can leak.
 */
export const FactoryConfigBundle = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      /** Inside the factory layout with forward slashes, such as `workers/reviewer.md`. */
      path: Schema.String,
      contents: Schema.String,
    }),
  ),
});
export type FactoryConfigBundle = typeof FactoryConfigBundle.Type;

/** Selected teams also bring the workers and leads whose ids match their members and lead. */
export const FactoryExportSelection = Schema.Union([
  Schema.Struct({ scope: Schema.Literal("all") }),
  Schema.Struct({
    scope: Schema.Literal("teams"),
    teamIds: Schema.Array(FactoryDefinitionId).check(Schema.isMinLength(1)),
  }),
]);
export type FactoryExportSelection = typeof FactoryExportSelection.Type;

export const FactoryImportStatus = Schema.Literals(["new", "same", "differs"]);
export type FactoryImportStatus = typeof FactoryImportStatus.Type;

export const FactoryImportPreview = Schema.Struct({
  /** Every definition in the bundle, compared by encoded bytes with the local one of its id. */
  items: Schema.Array(
    Schema.Struct({
      kind: FactoryDefinitionKind,
      id: FactoryDefinitionId,
      name: Schema.String,
      status: FactoryImportStatus,
      /**
       * Models this definition lists that the local pool lacks. Unless its pool addition is
       * accepted, the import drops each from the definition's model lists. Omitted when there are
       * none.
       */
      modelsNeedingPool: Schema.optionalKey(Schema.Array(FactoryModelRef)),
      /**
       * Some model list here names only models the local pool lacks. Dropping them would empty it,
       * and an empty list stands for the whole pool, so the definition, or the whole team, is not
       * imported unless those pool additions are accepted.
       */
      skippedUnlessPoolAdded: Schema.optionalKey(Schema.Literal(true)),
    }),
  ),
  /** Models in the bundle's pool that the local pool lacks. Each is added only when chosen. */
  poolAdditions: Schema.Array(FactoryModelRef),
  recoveryAllowance: Schema.Struct({ mine: NonNegativeInt, theirs: NonNegativeInt }),
  /** Files in the bundle that were rejected or could not be decoded. */
  problems: Schema.Array(FactoryConfigProblem),
});
export type FactoryImportPreview = typeof FactoryImportPreview.Type;

/** Keep the local definition, overwrite it, or keep both with theirs under a new id. */
export const FactoryImportChoice = Schema.Literals(["mine", "theirs", "both"]);
export type FactoryImportChoice = typeof FactoryImportChoice.Type;

export const FactoryImportDecision = Schema.Struct({
  /** Merge adds and resolves per definition; replace backs up, then swaps in the bundle. */
  mode: Schema.Literals(["merge", "replace"]),
  /** For merge: one per `differs` definition. A definition without a choice keeps mine. */
  choices: Schema.Array(
    Schema.Struct({
      kind: FactoryDefinitionKind,
      id: FactoryDefinitionId,
      choice: FactoryImportChoice,
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** The preview's pool additions the user accepted. Replace honours this too. */
  poolAdditions: Schema.Array(FactoryModelRef).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** For merge: which recovery allowance to keep. Replace always takes theirs. */
  recoveryAllowance: Schema.Literals(["mine", "theirs"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("mine" as const)),
  ),
});
export type FactoryImportDecision = typeof FactoryImportDecision.Type;

/** A file in the config directory that differs from the last commit. */
export const FactoryConfigRepoChange = Schema.Struct({
  /** Relative to the factory config directory, with forward slashes. */
  path: Schema.String,
  change: Schema.Literals(["added", "modified", "deleted"]),
});
export type FactoryConfigRepoChange = typeof FactoryConfigRepoChange.Type;

/** The config directory's own Git checkout, when the user connected one. */
export const FactoryConfigRepoStatus = Schema.Union([
  Schema.Struct({ connected: Schema.Literal(false) }),
  Schema.Struct({
    connected: Schema.Literal(true),
    remoteUrl: Schema.String,
    branch: Schema.String,
    localChanges: Schema.Array(FactoryConfigRepoChange),
    unpushedCommits: NonNegativeInt,
    /** Null until a check, pull or connect has fetched. */
    incomingCommits: Schema.NullOr(NonNegativeInt),
    /** A pull stopped on files changed on both sides, each settled as mine or theirs. */
    conflict: Schema.NullOr(Schema.Struct({ paths: Schema.Array(Schema.String) })),
  }),
]);
export type FactoryConfigRepoStatus = typeof FactoryConfigRepoStatus.Type;

export const FactoryConfigRepoConnectInput = Schema.Struct({
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(2000)),
  /** Needed when the repo already has content and this config has files of its own. */
  choice: Schema.optionalKey(Schema.Literals(["use-repo"])),
});
export type FactoryConfigRepoConnectInput = typeof FactoryConfigRepoConnectInput.Type;

export const FactoryConfigRepoConnectResult = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("connected"), status: FactoryConfigRepoStatus }),
  /** Both sides have a config: nothing was changed, and the user picks which to keep. */
  Schema.Struct({ outcome: Schema.Literal("needs-choice") }),
]);
export type FactoryConfigRepoConnectResult = typeof FactoryConfigRepoConnectResult.Type;

export const FactoryConfigRepoPushInput = Schema.Struct({
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
});
export type FactoryConfigRepoPushInput = typeof FactoryConfigRepoPushInput.Type;

export const FactoryConfigRepoResolveInput = Schema.Struct({
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(1000)),
  side: Schema.Literals(["mine", "theirs"]),
});
export type FactoryConfigRepoResolveInput = typeof FactoryConfigRepoResolveInput.Type;

export const FactoryConfigRepoDisconnectInput = Schema.Struct({
  /** Disconnect even though local changes or commits were never pushed. */
  force: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type FactoryConfigRepoDisconnectInput = typeof FactoryConfigRepoDisconnectInput.Type;
