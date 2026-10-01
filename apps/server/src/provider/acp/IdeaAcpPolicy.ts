import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as AcpSchema from "effect-acp/schema";
import { IDEA_TOOL_NAMES } from "../../ideas/IdeaExecution.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

export type IdeaAcpPurpose = "thread" | "updates";

const encodeCursorPermissions = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isGrokMcpInput = Schema.is(
  Schema.Struct({ variant: Schema.Literal("MCPTool"), tool_name: Schema.String }),
);

export const prepareCursorIdeaEnvironment = Effect.fn("prepareCursorIdeaEnvironment")(function* (
  cwd: string,
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const home = (platform === "win32" ? environment.USERPROFILE : environment.HOME) || "";
  const credentials =
    platform === "win32"
      ? path.join(environment.APPDATA || path.join(home, "AppData", "Roaming"), "Cursor")
      : platform === "darwin"
        ? path.join(home, ".cursor")
        : path.join(environment.XDG_CONFIG_HOME || path.join(home, ".config"), "cursor");
  const directory = path.join(cwd, ".cursor");
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  const ownedAuth = path.join(directory, "auth.json");
  let copiedAuth = false;
  for (const source of [environment.CURSOR_CONFIG_DIR, credentials]) {
    if (!source) continue;
    const auth = path.join(source, "auth.json");
    if (!(yield* fs.exists(auth))) continue;
    yield* fs.copyFile(auth, ownedAuth);
    copiedAuth = true;
    break;
  }
  if (!copiedAuth) yield* fs.remove(ownedAuth, { force: true });
  const prepared: NodeJS.ProcessEnv & { readonly CURSOR_CONFIG_DIR: string } = {
    ...environment,
    CURSOR_CONFIG_DIR: directory,
  };
  return prepared;
});

export const prepareGrokIdeaEnvironment = Effect.fn("prepareGrokIdeaEnvironment")(function* (
  directory: string,
  environment: NodeJS.ProcessEnv,
  purpose: IdeaAcpPurpose,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = path.join(directory, "runtime", `grok-${purpose}`);
  yield* fs.makeDirectory(home, { recursive: true, mode: 0o700 });
  const sourceHome =
    environment.GROK_HOME || path.join(environment.HOME || environment.USERPROFILE || "", ".grok");
  const sourceAuth = path.join(sourceHome, "auth.json");
  if (yield* fs.exists(sourceAuth)) {
    yield* fs.copyFile(sourceAuth, path.join(home, "auth.json"));
  } else {
    yield* fs.remove(path.join(home, "auth.json"), { force: true });
  }
  const isolatedEnvironment = Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) => key !== "GROK_CONFIG" && key !== "GROK_CONFIG_PATH",
    ),
  );
  const prepared: NodeJS.ProcessEnv & { readonly GROK_HOME: string } = {
    ...isolatedEnvironment,
    GROK_HOME: home,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
  };
  return prepared;
});

export const prepareAntigravityIdeaProfile = Effect.fn("prepareAntigravityIdeaProfile")(function* (
  directory: string,
  sourceProfile: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const profileDirectory = path.join(directory, "runtime", "antigravity-profile");
  const authDirectory = path.join(profileDirectory, "antigravity-acp");
  yield* fs.makeDirectory(authDirectory, { recursive: true, mode: 0o700 });
  const sourceToken = path.join(sourceProfile, "antigravity-acp", "acp_token.json");
  if (yield* fs.exists(sourceToken)) {
    yield* fs.copyFile(sourceToken, path.join(authDirectory, "acp_token.json"));
  } else {
    yield* fs.remove(path.join(authDirectory, "acp_token.json"), { force: true });
  }
  return profileDirectory;
});

export const prepareCursorIdeaWorkspace = Effect.fn("prepareCursorIdeaWorkspace")(function* (
  directory: string,
  purpose: IdeaAcpPurpose,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = path.join(directory, "runtime", `cursor-${purpose}`);
  const configDirectory = path.join(cwd, ".cursor");
  yield* fs.makeDirectory(configDirectory, { recursive: true });
  yield* fs.writeFileString(
    path.join(configDirectory, "cli.json"),
    encodeCursorPermissions({
      permissions: {
        allow: purpose === "thread" ? IDEA_TOOL_NAMES.map((name) => `Mcp(t3-code:${name})`) : [],
        deny: [
          "Shell(*)",
          "Read(**)",
          "Write(**)",
          "WebFetch(*)",
          ...(purpose === "updates" ? ["Mcp(*:*)"] : []),
        ],
      },
    }),
  );
  return cwd;
});

export function grokIdeaArguments(purpose: IdeaAcpPurpose): ReadonlyArray<string> {
  return [
    "--permission-mode",
    "default",
    "--deny",
    "Bash",
    "--deny",
    "Edit",
    "--deny",
    "Read",
    "--deny",
    "Grep",
    "--no-subagents",
    "--no-plan",
    "--no-memory",
    "--disable-web-search",
    ...(purpose === "updates" ? ["--disallowed-tools", "*"] : []),
    "agent",
    "stdio",
  ];
}

export function ideaAcpPermissionResponse(
  request: AcpSchema.RequestPermissionRequest,
): AcpSchema.RequestPermissionResponse {
  const name = request.toolCall.title?.replace(/^(?:Run |Running )/, "").replace(/\?$/, "");
  const grokName = isGrokMcpInput(request.toolCall.rawInput)
    ? request.toolCall.rawInput.tool_name
    : undefined;
  const scoped = IDEA_TOOL_NAMES.some(
    (tool) =>
      name === `mcp__t3-code__${tool}` ||
      name === `t3-code_${tool}` ||
      grokName === `t3-code__${tool}` ||
      (request.toolCall._meta?.is_mcp_tool_call === true && name === tool),
  );
  const option = scoped ? request.options.find((item) => item.kind === "allow_once") : undefined;
  return option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } };
}
