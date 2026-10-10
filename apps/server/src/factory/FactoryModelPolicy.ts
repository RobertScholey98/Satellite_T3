import {
  FactoryError,
  type FactoryModelChoice,
  type FactoryModelPolicy,
  type FactoryModelPolicyOverrides,
  type FactoryModelRole,
  type FactoryTaskComplexity,
  type ModelSelection,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as Result from "effect/Result";

export const isFactoryModelApproved = (policy: FactoryModelPolicy, selection: ModelSelection) =>
  policy.approvedModels.some((approved) => modelSelectionsEqual(approved, selection));

export const resolveFactoryModelPolicy = (
  defaults: FactoryModelPolicy | undefined,
  overrides: FactoryModelPolicyOverrides | undefined,
  bootstrap: ModelSelection,
) => {
  const preferences = new Map(
    (defaults?.preferences ?? []).map((entry) => [`${entry.role}:${entry.complexity}`, entry]),
  );
  for (const entry of overrides?.preferences ?? []) {
    preferences.set(`${entry.role}:${entry.complexity}`, entry);
  }
  return {
    approvedModels: overrides?.approvedModels ?? defaults?.approvedModels ?? [bootstrap],
    preferences: Array.from(preferences.values()),
  } satisfies FactoryModelPolicy;
};

export const constrainFactoryModelPolicy = (
  pinned: FactoryModelPolicy,
  current: FactoryModelPolicy,
) => ({
  approvedModels: pinned.approvedModels.filter((selection) =>
    isFactoryModelApproved(current, selection),
  ),
  preferences: pinned.preferences,
});

export const selectFactoryModel = (input: {
  readonly policy: FactoryModelPolicy;
  readonly overrides?: FactoryModelPolicyOverrides;
  readonly role: FactoryModelRole;
  readonly complexity: FactoryTaskComplexity;
  readonly selection?: ModelSelection;
}): Result.Result<FactoryModelChoice, FactoryError> => {
  if (input.selection !== undefined) {
    return isFactoryModelApproved(input.policy, input.selection)
      ? Result.succeed({
          selection: input.selection,
          source: "explicit",
          reason: `The requested ${input.role} model and its options are approved for this assignment.`,
        } satisfies FactoryModelChoice)
      : Result.fail(
          new FactoryError({
            code: "permission-denied",
            detail:
              "The requested model, provider account, or options are outside the approved model policy.",
          }),
        );
  }
  const preference = input.policy.preferences.find(
    (entry) => entry.role === input.role && entry.complexity === input.complexity,
  );
  if (preference !== undefined && isFactoryModelApproved(input.policy, preference.selection)) {
    const managerPreference = input.overrides?.preferences?.some(
      (entry) =>
        entry.role === input.role &&
        entry.complexity === input.complexity &&
        modelSelectionsEqual(entry.selection, preference.selection),
    );
    return Result.succeed({
      selection: preference.selection,
      source: managerPreference ? "manager-preference" : "default-preference",
      reason: `The ${managerPreference ? "manager" : "default"} preference selects this approved model for ${input.complexity} ${input.role} work.`,
    } satisfies FactoryModelChoice);
  }
  const fallback = input.policy.approvedModels[0];
  if (fallback === undefined) {
    return Result.fail(
      new FactoryError({
        code: "permission-denied",
        detail:
          "No model is approved for this assignment. Configure an approved model before commissioning work.",
      }),
    );
  }
  return Result.succeed({
    selection: fallback,
    source: "approved-fallback",
    reason: `No approved preference matches ${input.complexity} ${input.role} work, so the first approved model is selected.`,
  } satisfies FactoryModelChoice);
};
