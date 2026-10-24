import type { FactoryRole } from "@t3tools/contracts";

import { IMPLEMENTER_SKILL } from "./implementer.ts";
import { LEAD_SKILL } from "./lead.ts";
import { MANAGER_SKILL } from "./manager.ts";
import { REVIEWER_SKILL } from "./reviewer.ts";
import { VERIFIER_SKILL } from "./verifier.ts";

export { ONBOARDING_BRIEF } from "./onboardingBrief.ts";

// TypeScript constants rather than .md files: the server also ships as a single executable, where
// sibling files next to the module are not reliably on disk. The worker roles are the starter
// workers' built-in descriptions; a `worker` has none, because its definition is its brief.
export const DEFAULT_ROLE_SKILLS: Record<FactoryRole, string> = {
  manager: MANAGER_SKILL,
  lead: LEAD_SKILL,
  implementer: IMPLEMENTER_SKILL,
  reviewer: REVIEWER_SKILL,
  verifier: VERIFIER_SKILL,
  worker: "",
};
