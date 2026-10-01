import type { PermissionRuleset } from "@opencode-ai/sdk/v2";
import { IDEA_TOOL_NAMES } from "./IdeaExecution.ts";

export function openCodeIdeaPermissions(): PermissionRuleset {
  return [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "question", pattern: "*", action: "allow" },
    ...IDEA_TOOL_NAMES.map((name) => ({
      permission: `t3-code_${name}`,
      pattern: "*",
      action: "allow" as const,
    })),
  ];
}
