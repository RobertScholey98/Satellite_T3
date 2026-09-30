import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { IDEA_SESSION_INSTRUCTIONS, IDEA_TOOL_NAMES } from "./IdeaExecution.ts";

export function constrainClaudeIdeaOptions(options: Options): Options {
  const {
    resume: _resume,
    continue: _continue,
    agent: _agent,
    agents: _agents,
    ...safeOptions
  } = options;
  return {
    ...safeOptions,
    tools: ["AskUserQuestion"],
    allowedTools: IDEA_TOOL_NAMES.map((name) => `mcp__t3-code__${name}`),
    additionalDirectories: [],
    settingSources: [],
    settings: { disableAllHooks: true, enabledPlugins: {}, syncSkills: false, syncPlugins: false },
    systemPrompt: IDEA_SESSION_INSTRUCTIONS,
    hooks: {},
    plugins: [],
    strictMcpConfig: true,
    permissionMode: "default",
    allowDangerouslySkipPermissions: false,
    persistSession: false,
    forkSession: false,
    enableFileCheckpointing: false,
    extraArgs: { bare: null, "disable-slash-commands": null },
    env: {
      ...options.env,
      CLAUDE_CODE_SIMPLE: "1",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_DISABLE_AGENT_VIEW: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
  };
}
