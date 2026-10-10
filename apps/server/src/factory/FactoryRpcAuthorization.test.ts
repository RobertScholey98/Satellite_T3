import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  CommandId,
  FACTORY_WS_METHODS,
  FactoryAssignmentId,
  type FactoryCommand,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";

const method = FACTORY_WS_METHODS.dispatchCommand;
const group = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (tag): tag is Exclude<keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES, typeof method> =>
      tag !== method,
  ),
);
const managerId = ThreadId.make("manager-web");
const settingsCommands: ReadonlyArray<FactoryCommand> = [
  {
    type: "delivery.rules.configure",
    commandId: CommandId.make("merge-rules"),
    projectId: ProjectId.make("web"),
    enabled: true,
    kinds: ["implementation"],
    allowedPaths: ["src"],
    excludedPaths: ["src/security"],
    allowEstablishedPatterns: true,
  },
  {
    type: "delivery.preview.configure",
    commandId: CommandId.make("preview-runtime"),
    projectId: ProjectId.make("web"),
    configuration: {
      imageId: `sha256:${"a".repeat(64)}`,
      executable: "/usr/local/bin/node",
      args: ["/workspace/server.js"],
      port: 3000,
      data: "ephemeral",
    },
  },
  {
    type: "delivery.preview.publication.configure",
    commandId: CommandId.make("preview-publication"),
    projectId: ProjectId.make("web"),
    enabled: true,
  },
  {
    type: "policy.defaults.configure",
    commandId: CommandId.make("defaults"),
    defaults: {
      delivery: "project-rule",
      projectImprovements: "project-rule",
      sharedWorkflow: "investigate-and-recommend",
      authorizeRuleWeakening: true,
      recoveryCycles: 3,
    },
  },
  {
    type: "assignments.extend-grant",
    commandId: CommandId.make("extend"),
    assignmentIds: [FactoryAssignmentId.make("assignment-web")],
  },
  {
    type: "manager.configure",
    commandId: CommandId.make("configure"),
    managerId,
    overrides: { delivery: "project-rule" },
  },
  {
    type: "manager.approve-onboarding",
    commandId: CommandId.make("approve"),
    managerId,
    configuration: {
      protectedPaths: ["AGENTS.md"],
      writablePaths: ["src/app.ts"],
      creatableDirectories: ["src/features"],
      gates: [],
    },
  },
  {
    type: "models.defaults.configure",
    commandId: CommandId.make("models"),
    policy: { approvedModels: [], preferences: [] },
  },
  {
    type: "manager.models.configure",
    commandId: CommandId.make("manager-models"),
    managerId,
    overrides: { approvedModels: [] },
  },
  {
    type: "assignment.commission",
    commandId: CommandId.make("rule-change"),
    managerId,
    title: "Change the lint rule",
    kind: "rule-change",
    complexity: "small",
    scope: {
      description: "Adjust one approved rule",
      completionCondition: "Rule reviewed",
      requiresPullRequest: true,
    },
    sourcePaths: [],
    creatableDirectories: [],
    controlPaths: ["eslint.config.js"],
  },
];
const create: FactoryCommand = {
  type: "manager.create",
  commandId: CommandId.make("create"),
  projectId: ProjectId.make("web"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "approved-model" },
  workflow: { repositoryRoot: "/owned-workflow", revision: "approved-commit" },
};

describe("factory RPC authority", () => {
  it.effect("lets an operator create a manager while denying authority-setting commands", () =>
    Effect.gen(function* () {
      const handled: string[] = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(method, ({ command }) =>
              Effect.sync(() => {
                handled.push(command.type);
                return { revision: handled.length };
              }),
            ),
            RpcAuthorization.layer([AuthOrchestrationOperateScope]),
          ),
        ),
      );
      for (const command of settingsCommands) {
        const error = yield* client[method]({ command }).pipe(Effect.flip);
        assert.equal(error._tag, "EnvironmentAuthorizationError");
        if (error._tag === "EnvironmentAuthorizationError")
          assert.equal(error.requiredPermission, AuthSettingsWriteScope);
      }
      assert.deepStrictEqual(yield* client[method]({ command: create }), { revision: 1 });
      assert.deepStrictEqual(handled, ["manager.create"]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "allows all authority-setting commands when settings and operation scopes are present",
    () =>
      Effect.gen(function* () {
        const handled: string[] = [];
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.mergeAll(
              group.toLayerHandler(method, ({ command }) =>
                Effect.sync(() => {
                  handled.push(command.type);
                  return { revision: handled.length };
                }),
              ),
              RpcAuthorization.layer([AuthOrchestrationOperateScope, AuthSettingsWriteScope]),
            ),
          ),
        );
        for (const [index, command] of settingsCommands.entries()) {
          assert.deepStrictEqual(yield* client[method]({ command }), { revision: index + 1 });
        }
        assert.deepStrictEqual(handled, [
          "delivery.rules.configure",
          "delivery.preview.configure",
          "delivery.preview.publication.configure",
          "policy.defaults.configure",
          "assignments.extend-grant",
          "manager.configure",
          "manager.approve-onboarding",
          "models.defaults.configure",
          "manager.models.configure",
          "assignment.commission",
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect("does not let a settings-only token operate managers", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(method, () => Effect.succeed({ revision: 1 })),
            RpcAuthorization.layer([AuthSettingsWriteScope]),
          ),
        ),
      );
      for (const command of [...settingsCommands, create]) {
        const error = yield* client[method]({ command }).pipe(Effect.flip);
        assert.equal(error._tag, "EnvironmentAuthorizationError");
        if (error._tag === "EnvironmentAuthorizationError")
          assert.equal(error.requiredPermission, AuthOrchestrationOperateScope);
      }
    }).pipe(Effect.scoped),
  );
});
