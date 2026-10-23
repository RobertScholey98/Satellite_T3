import { expect, it } from "vite-plus/test";

import { isFactoryOnboardingProposalTool } from "./factoryOnboardingCard.logic";

it("recognises the onboarding proposal tool behind each harness prefix", () => {
  for (const name of [
    "factory_propose_onboarding",
    "mcp__t3-code__factory_propose_onboarding",
    "t3-code.factory_propose_onboarding",
    "t3-code-thread_1_factory_propose_onboarding",
  ]) {
    expect(isFactoryOnboardingProposalTool(name), name).toBe(true);
  }
  for (const name of ["factory_propose_onboarding_v2", "myfactory_propose_onboardingx", null]) {
    expect(isFactoryOnboardingProposalTool(name), String(name)).toBe(false);
  }
});
