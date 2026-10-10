import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const FactoryModelRole = Schema.Literals(["lead", "worker", "reviewer"]);
export type FactoryModelRole = typeof FactoryModelRole.Type;

export const FactoryTaskComplexity = Schema.Literals(["small", "standard", "complex"]);
export type FactoryTaskComplexity = typeof FactoryTaskComplexity.Type;

export const FactoryModelPreference = Schema.Struct({
  role: FactoryModelRole,
  complexity: FactoryTaskComplexity,
  selection: ModelSelection,
});
export type FactoryModelPreference = typeof FactoryModelPreference.Type;

const preferences = Schema.Array(FactoryModelPreference).check(
  Schema.makeFilter(
    (entries) =>
      new Set(entries.map((entry) => `${entry.role}:${entry.complexity}`)).size === entries.length,
    { message: "Each role and complexity pair can have only one model preference." },
  ),
);

export const FactoryModelPolicy = Schema.Struct({
  approvedModels: Schema.Array(ModelSelection),
  preferences,
});
export type FactoryModelPolicy = typeof FactoryModelPolicy.Type;

export const FactoryModelPolicyOverrides = Schema.Struct({
  approvedModels: Schema.optionalKey(Schema.Array(ModelSelection)),
  preferences: Schema.optionalKey(preferences),
});
export type FactoryModelPolicyOverrides = typeof FactoryModelPolicyOverrides.Type;

export const FactoryModelChoice = Schema.Struct({
  selection: ModelSelection,
  reason: TrimmedNonEmptyString,
  source: Schema.Literals([
    "explicit",
    "manager-preference",
    "default-preference",
    "approved-fallback",
  ]),
});
export type FactoryModelChoice = typeof FactoryModelChoice.Type;
