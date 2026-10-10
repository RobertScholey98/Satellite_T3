import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  buildCodexTurnStartParams,
  codexThreadRuntimeParams,
} from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import type { ProviderAdapterV2RuntimePolicy } from "../orchestration-v2/ProviderAdapter.ts";
import * as McpProviderSession from "../mcp/McpProviderSession.ts";

const profile = {
  boundaryId: "assignment:thread",
  dockerContext: "local",
  imageId: "sha256:verified",
  projectSnapshotPath: "C:/state/project",
  workflowSnapshotPath: "C:/state/workflow",
  runtimePath: "C:/state/runtime",
};
const runtimePolicy: ProviderAdapterV2RuntimePolicy = {
  cwd: profile.projectSnapshotPath,
  runtimeMode: "full-access",
  interactionMode: "default",
  approvalPolicy: "on-request",
  sandboxPolicy: { type: "dangerFullAccess" },
  factoryExecution: profile,
};

it.effect(
  "managed Codex turns retain their outer execution boundary regardless of runtime-mode overrides",
  () =>
    Effect.gen(function* () {
      const params = yield* buildCodexTurnStartParams({
        nativeThreadId: "native-thread",
        codexInput: [{ type: "text", text: "inspect" }],
        runtimePolicy,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
      });
      assert.equal(params.cwd, "/workspace");
      assert.equal(params.approvalPolicy, "never");
      assert.deepEqual(params.sandboxPolicy, { type: "externalSandbox", networkAccess: "enabled" });
    }),
);

it("start and resume map only the managed endpoint and workspace to the provider container", () => {
  const threadId = ThreadId.make("factory-adapter-test");
  McpProviderSession.setMcpProviderSession({
    threadId,
    environmentId: EnvironmentId.make("factory-environment"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: "factory-scoped",
    endpoint: "http://127.0.0.1:4000/mcp",
    authorizationHeader: "Bearer scoped-test",
    browserToolsAvailable: false,
  });
  try {
    const params = codexThreadRuntimeParams({ threadId, runtimePolicy });
    assert.equal(params.cwd, "/workspace");
    assert.deepEqual(params.config.mcp_servers, {
      "t3-code": {
        url: "http://host.docker.internal:4000/mcp",
        http_headers: { Authorization: "Bearer scoped-test" },
      },
    });
    assert.equal(runtimePolicy.cwd, "C:/state/project");
  } finally {
    McpProviderSession.clearMcpProviderSession(threadId);
  }
});

it("managed starts and resumes disable both native agent backends without changing ordinary sessions", () => {
  const managed = codexThreadRuntimeParams({ threadId: null, runtimePolicy });
  assert.equal(managed.config["agents.enabled"], false);
  assert.equal(managed.config["features.multi_agent"], false);
  assert.equal(managed.config["features.multi_agent_v2"], false);
  const ordinary = codexThreadRuntimeParams({ threadId: null });
  assert.isUndefined(ordinary.config["agents.enabled"]);
  assert.isUndefined(ordinary.config["features.multi_agent"]);
  assert.isUndefined(ordinary.config["features.multi_agent_v2"]);
});
