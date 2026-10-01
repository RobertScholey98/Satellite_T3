import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { IDEA_TOOL_NAMES } from "../../ideas/IdeaExecution.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  ideaAcpPermissionResponse,
  prepareAntigravityIdeaProfile,
  prepareCursorIdeaWorkspace,
  prepareCursorIdeaEnvironment,
  prepareGrokIdeaEnvironment,
} from "./IdeaAcpPolicy.ts";

it("rejects ambiguous tool permissions instead of treating a document name as a tool", () => {
  for (const title of [
    undefined,
    null,
    "Write mcp__t3-code__idea_write_document",
    "mcp__other__idea_read",
    "mcp__t3-code__idea_read_extra",
  ]) {
    expect(
      ideaAcpPermissionResponse({
        sessionId: "session",
        toolCall: { toolCallId: "call", ...(title === undefined ? {} : { title }) },
        options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
      }),
    ).toEqual({ outcome: { outcome: "cancelled" } });
  }
});

it.each(IDEA_TOOL_NAMES)("allows %s from native Grok and Antigravity MCP requests", (name) => {
  for (const toolCall of [
    {
      toolCallId: "grok",
      title: "Readable tool label",
      rawInput: { variant: "MCPTool", tool_name: `t3-code__${name}`, tool_input: {} },
    },
    {
      toolCallId: "antigravity",
      title: `Run ${name}?`,
      rawInput: { arguments: {} },
      _meta: { is_mcp_tool_call: true },
    },
  ]) {
    expect(
      ideaAcpPermissionResponse({
        sessionId: "session",
        toolCall,
        options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
      }),
    ).toEqual({ outcome: { outcome: "selected", optionId: "once" } });
  }
  expect(
    ideaAcpPermissionResponse({
      sessionId: "session",
      toolCall: { toolCallId: "other", title: `Run ${name}?` },
      options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
    }),
  ).toEqual({ outcome: { outcome: "cancelled" } });
});

it.layer(NodeServices.layer)("Idea native profiles", (it) => {
  it.effect("preserves configured Cursor and Grok authentication without copying hooks", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-idea-auth-" });
      const source = path.join(root, "source");
      const cwd = path.join(root, "idea");
      yield* fs.makeDirectory(source);
      yield* fs.writeFileString(path.join(source, "auth.json"), "test-credential");
      yield* fs.writeFileString(path.join(source, "hooks.json"), "must not execute");
      const cursor = yield* prepareCursorIdeaEnvironment(cwd, {
        CURSOR_CONFIG_DIR: source,
        CURSOR_API_KEY: "test-key",
        HOME: root,
      }).pipe(Effect.provideService(HostProcessPlatform, "linux"));
      expect(cursor.CURSOR_API_KEY).toBe("test-key");
      expect(cursor.HOME).toBe(root);
      expect(yield* fs.readFileString(path.join(cursor.CURSOR_CONFIG_DIR, "auth.json"))).toBe(
        "test-credential",
      );
      expect(yield* fs.exists(path.join(cursor.CURSOR_CONFIG_DIR, "hooks.json"))).toBe(false);
      const grok = yield* prepareGrokIdeaEnvironment(
        cwd,
        {
          GROK_HOME: source,
          GROK_AUTH: "test-token",
          GROK_CONFIG_PATH: path.join(source, "config.toml"),
        },
        "thread",
      );
      expect(grok.GROK_AUTH).toBe("test-token");
      expect(grok.GROK_CONFIG_PATH).toBeUndefined();
      expect(grok.HOME).toBe(grok.GROK_HOME);
      expect(yield* fs.readFileString(path.join(grok.GROK_HOME, "auth.json"))).toBe(
        "test-credential",
      );
      expect(yield* fs.exists(path.join(grok.GROK_HOME, "hooks.json"))).toBe(false);
      expect(yield* fs.readFileString(path.join(source, "hooks.json"))).toBe("must not execute");
      yield* fs.remove(path.join(source, "auth.json"));
      yield* prepareCursorIdeaEnvironment(cwd, { CURSOR_CONFIG_DIR: source, HOME: root }).pipe(
        Effect.provideService(HostProcessPlatform, "linux"),
      );
      yield* prepareGrokIdeaEnvironment(cwd, { GROK_HOME: source }, "thread");
      expect(yield* fs.exists(path.join(cursor.CURSOR_CONFIG_DIR, "auth.json"))).toBe(false);
      expect(yield* fs.exists(path.join(grok.GROK_HOME, "auth.json"))).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("copies only Antigravity authentication into the idea profile", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-idea-profile-" });
      const source = path.join(directory, "source");
      const idea = path.join(directory, "idea");
      yield* fs.makeDirectory(path.join(source, "antigravity-acp"), { recursive: true });
      yield* fs.makeDirectory(path.join(source, "config"));
      yield* fs.writeFileString(
        path.join(source, "antigravity-acp", "acp_token.json"),
        "test-credential",
      );
      yield* fs.writeFileString(path.join(source, "config", "hooks.json"), "must not execute");
      yield* fs.writeFileString(path.join(source, "config", "mcp_config.json"), "unrelated tools");
      const profile = yield* prepareAntigravityIdeaProfile(idea, source);
      expect(path.relative(idea, profile).startsWith("..")).toBe(false);
      expect(
        yield* fs.readFileString(path.join(profile, "antigravity-acp", "acp_token.json")),
      ).toBe("test-credential");
      expect(yield* fs.exists(path.join(profile, "config"))).toBe(false);
      expect(yield* fs.readFileString(path.join(source, "config", "hooks.json"))).toBe(
        "must not execute",
      );
      yield* fs.remove(path.join(source, "antigravity-acp", "acp_token.json"));
      yield* prepareAntigravityIdeaProfile(idea, source);
      expect(yield* fs.exists(path.join(profile, "antigravity-acp", "acp_token.json"))).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps simultaneous Cursor thread and updater policies separate", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-idea-cursor-" });
      const thread = yield* prepareCursorIdeaWorkspace(directory, "thread");
      const updates = yield* prepareCursorIdeaWorkspace(directory, "updates");
      const decode = Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            permissions: Schema.Struct({
              allow: Schema.Array(Schema.String),
              deny: Schema.Array(Schema.String),
            }),
          }),
        ),
      );
      const threadPolicy = (yield* decode(
        yield* fs.readFileString(path.join(thread, ".cursor", "cli.json")),
      )).permissions;
      const updatePolicy = (yield* decode(
        yield* fs.readFileString(path.join(updates, ".cursor", "cli.json")),
      )).permissions;
      expect(threadPolicy.allow).toContain("Mcp(t3-code:idea_write_document)");
      expect(threadPolicy.deny).toContain("Write(**)");
      expect(threadPolicy.deny).toContain("Shell(*)");
      expect(updatePolicy.allow).toEqual([]);
      expect(updatePolicy.deny).toContain("Mcp(*:*)");
    }).pipe(Effect.scoped),
  );
});
