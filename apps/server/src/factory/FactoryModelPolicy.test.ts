import { assert, describe, it } from "@effect/vitest";
import {
  FactoryModelPolicy,
  FactoryModelPolicyOverrides,
  ProviderInstanceId,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  constrainFactoryModelPolicy,
  isFactoryModelApproved,
  resolveFactoryModelPolicy,
  selectFactoryModel,
} from "./FactoryModelPolicy.ts";

const bootstrap = { instanceId: ProviderInstanceId.make("codex"), model: "chosen-manager" };
const quick = { instanceId: ProviderInstanceId.make("codex"), model: "quick" };
const thorough = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "thorough",
  options: [
    { id: "reasoningEffort", value: "high" },
    { id: "serviceTier", value: "priority" },
  ],
} satisfies ModelSelection;
const defaults = {
  approvedModels: [quick, thorough],
  preferences: [
    { role: "lead", complexity: "complex", selection: thorough },
    { role: "worker", complexity: "small", selection: quick },
    { role: "reviewer", complexity: "standard", selection: thorough },
  ],
} satisfies FactoryModelPolicy;

describe("factory model policy inheritance", () => {
  it("bootstraps only the human-selected model when defaults are absent", () => {
    assert.deepStrictEqual(resolveFactoryModelPolicy(undefined, undefined, bootstrap), {
      approvedModels: [bootstrap],
      preferences: [],
    });
    assert.deepStrictEqual(resolveFactoryModelPolicy(defaults, undefined, bootstrap), defaults);
  });

  it("overrides preferences per role and complexity and clears them by omission", () => {
    const overrides = {
      preferences: [{ role: "reviewer", complexity: "standard", selection: quick }],
    } satisfies FactoryModelPolicyOverrides;
    const resolved = resolveFactoryModelPolicy(defaults, overrides, bootstrap);
    assert.deepStrictEqual(resolved, {
      approvedModels: [quick, thorough],
      preferences: [
        { role: "lead", complexity: "complex", selection: thorough },
        { role: "worker", complexity: "small", selection: quick },
        { role: "reviewer", complexity: "standard", selection: quick },
      ],
    });
    assert.deepStrictEqual(
      resolveFactoryModelPolicy(defaults, { preferences: [] }, bootstrap),
      defaults,
    );
    assert.deepStrictEqual(resolveFactoryModelPolicy(defaults, {}, bootstrap), defaults);
  });

  it("preserves an explicit empty pool across default changes until cleared", () => {
    const empty = resolveFactoryModelPolicy(defaults, { approvedModels: [] }, bootstrap);
    assert.deepStrictEqual(empty.approvedModels, []);
    const denied = selectFactoryModel({ policy: empty, role: "lead", complexity: "complex" });
    assert.isTrue(Result.isFailure(denied));
    assert.deepStrictEqual(
      resolveFactoryModelPolicy(undefined, { approvedModels: [] }, bootstrap).approvedModels,
      [],
    );
    assert.deepStrictEqual(resolveFactoryModelPolicy(defaults, {}, bootstrap).approvedModels, [
      quick,
      thorough,
    ]);
  });

  it("rejects ambiguous duplicate preference keys at the contract boundary", () => {
    const decode = Schema.decodeUnknownResult(FactoryModelPolicyOverrides);
    assert.isTrue(
      Result.isFailure(
        decode({
          preferences: [
            { role: "lead", complexity: "small", selection: quick },
            { role: "lead", complexity: "small", selection: thorough },
          ],
        }),
      ),
    );
    assert.isTrue(Result.isSuccess(decode({ preferences: defaults.preferences })));
  });
});

describe("factory model selection", () => {
  it("records explicit selection independently from the preferred model", () => {
    assert.deepStrictEqual(
      Result.getOrThrow(
        selectFactoryModel({
          policy: defaults,
          role: "lead",
          complexity: "complex",
          selection: quick,
        }),
      ),
      {
        selection: quick,
        source: "explicit",
        reason: "The requested lead model and its options are approved for this assignment.",
      },
    );
    assert.deepStrictEqual(defaults.preferences[0]?.selection, thorough);
  });

  it("explains manager and inherited default preferences", () => {
    const overrides = {
      preferences: [{ role: "reviewer", complexity: "standard", selection: quick }],
    } satisfies FactoryModelPolicyOverrides;
    const policy = resolveFactoryModelPolicy(defaults, overrides, bootstrap);
    const managerChoice = Result.getOrThrow(
      selectFactoryModel({ policy, overrides, role: "reviewer", complexity: "standard" }),
    );
    assert.equal(managerChoice.source, "manager-preference");
    assert.deepStrictEqual(managerChoice.selection, quick);
    const inherited = Result.getOrThrow(
      selectFactoryModel({ policy, overrides, role: "lead", complexity: "complex" }),
    );
    assert.equal(inherited.source, "default-preference");
    assert.deepStrictEqual(inherited.selection, thorough);
  });

  it("uses the first approved fallback when a preference is absent or no longer approved", () => {
    for (const policy of [
      { approvedModels: [quick], preferences: [] },
      { approvedModels: [quick], preferences: defaults.preferences },
    ]) {
      const choice = Result.getOrThrow(
        selectFactoryModel({ policy, role: "lead", complexity: "complex" }),
      );
      assert.equal(choice.source, "approved-fallback");
      assert.deepStrictEqual(choice.selection, quick);
    }
  });

  it("matches full account, model and options while ignoring option order", () => {
    assert.isTrue(
      isFactoryModelApproved(defaults, { ...thorough, options: thorough.options.toReversed() }),
    );
    assert.isTrue(isFactoryModelApproved(defaults, { ...quick, options: [] }));
    for (const selection of [
      { ...quick, instanceId: ProviderInstanceId.make("other-account") },
      { ...quick, model: "unapproved" },
      { ...thorough, options: [{ id: "reasoningEffort", value: "high" }] },
      { ...thorough, options: [...thorough.options, { id: "fastMode", value: true }] },
      { ...thorough, options: [{ id: "reasoningEffort", value: "low" }] },
    ]) {
      assert.isFalse(isFactoryModelApproved(defaults, selection));
      const denied = selectFactoryModel({
        policy: defaults,
        role: "worker",
        complexity: "small",
        selection,
      });
      if (Result.isSuccess(denied)) return assert.fail("The unapproved selection was accepted.");
      assert.equal(denied.failure.code, "permission-denied");
    }
  });
});

describe("assignment model grants", () => {
  it("keeps pinned approval order and options while applying current removals", () => {
    const constrained = constrainFactoryModelPolicy(defaults, {
      approvedModels: [thorough, { ...quick, instanceId: ProviderInstanceId.make("another") }],
      preferences: [],
    });
    assert.deepStrictEqual(constrained.approvedModels, [thorough]);
    assert.deepStrictEqual(constrained.preferences, defaults.preferences);
  });

  it("does not extend pinned grants or resurrect removed approval after a later increase", () => {
    const initial = { approvedModels: [quick], preferences: [] };
    assert.deepStrictEqual(constrainFactoryModelPolicy(initial, defaults), initial);
    const reduced = constrainFactoryModelPolicy(defaults, initial);
    assert.deepStrictEqual(constrainFactoryModelPolicy(reduced, defaults).approvedModels, [quick]);
    const denied = constrainFactoryModelPolicy(reduced, { approvedModels: [], preferences: [] });
    assert.deepStrictEqual(constrainFactoryModelPolicy(denied, defaults).approvedModels, []);
  });
});
