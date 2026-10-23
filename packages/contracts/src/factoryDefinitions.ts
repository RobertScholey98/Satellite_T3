import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

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
