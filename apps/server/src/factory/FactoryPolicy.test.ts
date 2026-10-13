import { assert, describe, it } from "@effect/vitest";
import type { FactoryPolicy } from "@t3tools/contracts";

import { constrainAssignmentPolicy, resolveManagerPolicy } from "./FactoryPolicy.ts";

const supervised = {
  delivery: "human-approval",
  projectImprovements: "create-tickets",
  sharedWorkflow: "investigate-and-recommend",
  authorizeRuleWeakening: false,
  recoveryCycles: 1,
} satisfies FactoryPolicy;

const delegated = {
  delivery: "project-rule",
  projectImprovements: "project-rule",
  sharedWorkflow: "investigate-and-recommend",
  authorizeRuleWeakening: true,
  recoveryCycles: 3,
} satisfies FactoryPolicy;

describe("manager policy inheritance", () => {
  it("follows current defaults when no dimensions are overridden", () => {
    assert.deepStrictEqual(resolveManagerPolicy(delegated, {}), {
      delivery: "project-rule",
      projectImprovements: "project-rule",
      sharedWorkflow: "investigate-and-recommend",
      authorizeRuleWeakening: true,
      recoveryCycles: 3,
    });
  });

  it("preserves explicit overrides while other dimensions follow changed defaults", () => {
    const overrides = { delivery: "human-approval", recoveryCycles: 2 } as const;
    assert.deepStrictEqual(resolveManagerPolicy(supervised, overrides), {
      delivery: "human-approval",
      projectImprovements: "create-tickets",
      sharedWorkflow: "investigate-and-recommend",
      authorizeRuleWeakening: false,
      recoveryCycles: 2,
    });
    assert.deepStrictEqual(resolveManagerPolicy(delegated, overrides), {
      delivery: "human-approval",
      projectImprovements: "project-rule",
      sharedWorkflow: "investigate-and-recommend",
      authorizeRuleWeakening: true,
      recoveryCycles: 2,
    });
  });

  it("keeps explicit false and zero overrides until they are cleared", () => {
    assert.deepStrictEqual(
      resolveManagerPolicy(delegated, { authorizeRuleWeakening: false, recoveryCycles: 0 }),
      {
        delivery: "project-rule",
        projectImprovements: "project-rule",
        sharedWorkflow: "investigate-and-recommend",
        authorizeRuleWeakening: false,
        recoveryCycles: 0,
      },
    );
    assert.deepStrictEqual(resolveManagerPolicy(delegated, {}), {
      delivery: "project-rule",
      projectImprovements: "project-rule",
      sharedWorkflow: "investigate-and-recommend",
      authorizeRuleWeakening: true,
      recoveryCycles: 3,
    });
  });
});

describe("assignment permission ceilings", () => {
  it("applies reductions immediately to an existing broad grant", () => {
    assert.deepStrictEqual(constrainAssignmentPolicy(delegated, supervised), {
      delivery: "human-approval",
      projectImprovements: "create-tickets",
      sharedWorkflow: "investigate-and-recommend",
      authorizeRuleWeakening: false,
      recoveryCycles: 1,
    });
  });

  it("keeps an existing narrow grant when the manager gains more authority", () => {
    assert.deepStrictEqual(constrainAssignmentPolicy(supervised, delegated), {
      delivery: "human-approval",
      projectImprovements: "create-tickets",
      sharedWorkflow: "investigate-and-recommend",
      authorizeRuleWeakening: false,
      recoveryCycles: 1,
    });
  });

  it("retains delegated permissions only when both ceilings permit them", () => {
    assert.deepStrictEqual(constrainAssignmentPolicy(delegated, delegated), {
      delivery: "project-rule",
      projectImprovements: "project-rule",
      sharedWorkflow: "investigate-and-recommend",
      authorizeRuleWeakening: true,
      recoveryCycles: 3,
    });
  });

  it("resolves each dimension independently and can prohibit further recovery cycles", () => {
    assert.deepStrictEqual(
      constrainAssignmentPolicy(
        { ...delegated, delivery: "human-approval", recoveryCycles: 2 },
        { ...delegated, projectImprovements: "create-tickets", recoveryCycles: 0 },
      ),
      {
        delivery: "human-approval",
        projectImprovements: "create-tickets",
        sharedWorkflow: "investigate-and-recommend",
        authorizeRuleWeakening: true,
        recoveryCycles: 0,
      },
    );
  });

  it("does not restore a revoked grant when defaults rise again", () => {
    const reducedGrant = constrainAssignmentPolicy(delegated, supervised);
    assert.deepStrictEqual(constrainAssignmentPolicy(reducedGrant, delegated), {
      delivery: "human-approval",
      projectImprovements: "create-tickets",
      sharedWorkflow: "investigate-and-recommend",
      authorizeRuleWeakening: false,
      recoveryCycles: 1,
    });
  });
});
