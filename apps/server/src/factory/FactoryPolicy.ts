import type { FactoryPolicy, FactoryPolicyOverrides } from "@t3tools/contracts";

export const resolveManagerPolicy = (
  defaults: FactoryPolicy,
  overrides: FactoryPolicyOverrides,
) => ({ ...defaults, ...overrides });

export const constrainAssignmentPolicy = (
  grantedPolicy: FactoryPolicy,
  currentManagerPolicy: FactoryPolicy,
) =>
  ({
    delivery:
      grantedPolicy.delivery === "project-rule" && currentManagerPolicy.delivery === "project-rule"
        ? "project-rule"
        : "human-approval",
    projectImprovements:
      grantedPolicy.projectImprovements === "project-rule" &&
      currentManagerPolicy.projectImprovements === "project-rule"
        ? "project-rule"
        : "create-tickets",
    sharedWorkflow: "investigate-and-recommend",
    authorizeRuleWeakening:
      grantedPolicy.authorizeRuleWeakening && currentManagerPolicy.authorizeRuleWeakening,
    recoveryCycles: Math.min(grantedPolicy.recoveryCycles, currentManagerPolicy.recoveryCycles),
  }) satisfies FactoryPolicy;
