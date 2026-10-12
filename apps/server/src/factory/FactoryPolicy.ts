import type { FactoryPolicy, FactoryPolicyOverrides } from "@t3tools/contracts";

export const resolveManagerPolicy = (
  defaults: FactoryPolicy,
  overrides: FactoryPolicyOverrides,
) => ({ ...defaults, ...overrides });

/**
 * Narrows an assignment's granted policy to whatever the manager's current policy still allows.
 * Each field takes the stricter of the two, so a later manager policy change can only tighten
 * an existing assignment, never widen it. Shared workflow changes are always limited to
 * investigation.
 */
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
