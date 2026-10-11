import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { makeProviderAdapter } from "../orchestration-v2/testkit/SatelliteTestRuntime.ts";
import * as ProcessRunner from "../processRunner.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import * as FactoryExecution from "./FactoryExecution.ts";
import { FACTORY_CODEX_DOCKERFILE, FactoryExecutionProfile } from "./FactoryExecutionProfile.ts";
import { FactoryStore } from "./FactoryStore.ts";
import * as FactorySource from "./FactorySource.ts";

const decodeProfile = Schema.decodeUnknownEffect(Schema.fromJsonString(FactoryExecutionProfile));
const unavailable = () => Effect.die("Unexpected provider model invocation");
const instanceId = ProviderInstanceId.make("factory-qualification");
const driverKind = ProviderDriverKind.make("codex");
const now = "2026-10-10T12:00:00.000Z";
const providerSnapshot: ServerProvider = {
  instanceId,
  driver: driverKind,
  enabled: true,
  installed: true,
  version: "0.161.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: now,
  models: [],
  slashCommands: [],
  skills: [],
};
const instance: ProviderInstance = {
  instanceId,
  driverKind,
  continuationIdentity: { driverKind, continuationKey: "factory-test" },
  displayName: "Test model account",
  enabled: true,
  snapshot: {
    getSnapshot: Effect.succeed(providerSnapshot),
    resolveMaintenance: unavailable,
    refresh: unavailable(),
    streamChanges: Stream.empty,
    applyUsageLimits: unavailable,
  },
  orchestrationAdapter: makeProviderAdapter(instanceId),
  textGeneration: {
    generateBranchName: unavailable,
    generateCommitMessage: unavailable,
    generatePrContent: unavailable,
    generateThreadTitle: unavailable,
    generateIdeaUpdate: unavailable,
  },
};

it.effect(
  "qualifies a pinned tracked snapshot without repository credentials or uncommitted workflow changes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runner = yield* ProcessRunner.ProcessRunner;
      const root = yield* fs.makeTempDirectoryScoped();
      const repository = path.join(root, "repository");
      yield* fs.makeDirectory(path.join(repository, "skills", "retro"), { recursive: true });
      yield* fs.makeDirectory(path.join(repository, ".github"), { recursive: true });
      yield* fs.writeFileString(
        path.join(repository, ".github", "control.yml"),
        "unchanged protected control\n",
      );
      yield* fs.writeFileString(
        path.join(repository, ".gitattributes"),
        ".github export-ignore\nskills/** export-ignore\nversion.txt export-subst\nREADME.md filter=untrusted\n",
      );
      yield* fs.writeFileString(path.join(repository, "version.txt"), "$Format:%H$\n");
      yield* fs.writeFileString(path.join(repository, "README.md"), "tracked source");
      yield* fs.writeFileString(path.join(repository, ".env"), "SYNTHETIC_SECRET=must-not-mount");
      yield* fs.writeFileString(
        path.join(repository, "skills", "retro", "SKILL.md"),
        "committed workflow",
      );
      const git = (args: ReadonlyArray<string>) =>
        runner.run({ command: "git", args, cwd: repository });
      for (const args of [
        ["init", "--quiet"],
        ["add", "--all"],
        [
          "-c",
          "user.name=Factory Test",
          "-c",
          "user.email=factory@example.invalid",
          "commit",
          "--quiet",
          "--message",
          "fixture",
        ],
      ]) {
        assert.equal((yield* git(args)).code, 0);
      }
      const revision = (yield* git(["rev-parse", "HEAD"])).stdout.trim();
      yield* fs.writeFileString(
        path.join(repository, "skills", "retro", "SKILL.md"),
        "newer committed workflow",
      );
      assert.equal((yield* git(["add", "skills/retro/SKILL.md"])).code, 0);
      assert.equal(
        (yield* git([
          "-c",
          "user.name=Factory Test",
          "-c",
          "user.email=factory@example.invalid",
          "commit",
          "--quiet",
          "--message",
          "newer workflow",
        ])).code,
        0,
      );
      assert.equal((yield* git(["config", "filter.untrusted.smudge", "exit 91"])).code, 0);
      assert.equal((yield* git(["config", "filter.untrusted.clean", "exit 92"])).code, 0);
      assert.equal((yield* git(["config", "filter.untrusted.required", "true"])).code, 0);
      yield* fs.writeFileString(
        path.join(repository, "skills", "retro", "SKILL.md"),
        "uncommitted workflow",
      );
      const successfulProcess = yield* git(["--version"]);
      const failedProcess = yield* git(["rev-parse", "--verify", "--quiet", "missing-ref"]);
      let imageBuilt = false;
      const imageBuilds: Array<string | undefined> = [];
      let probeCount = 0;
      let acceptProbe = true;
      const executionRunner = ProcessRunner.ProcessRunner.of({
        run: (input) => {
          if (input.command !== "docker" || process.env.SATELLITE_FACTORY_LIVE_TEST === "1")
            return runner.run(input);
          const args = input.args;
          let stdout: string;
          if (args.includes("show")) stdout = "test-local";
          else if (args.includes("context") && args.includes("inspect"))
            stdout = "unix:///var/run/docker.sock";
          else if (args.includes("info")) stdout = "linux";
          else if (args.includes("build")) {
            imageBuilds.push(input.stdin);
            imageBuilt = true;
            stdout = "";
          } else if (args.includes("image")) {
            if (!imageBuilt) return Effect.succeed({ ...failedProcess, stdout: "" });
            stdout = `sha256:${"a".repeat(64)}`;
          } else {
            probeCount++;
            stdout = acceptProbe ? "factory-boundary-ok" : "";
          }
          return Effect.succeed({ ...successfulProcess, stdout });
        },
      });
      const projectId = ProjectId.make("qualification-project");
      const dependencies = Layer.mergeAll(
        Layer.mock(FactoryStore)({}),
        Layer.mock(ProjectionStoreV2)({}),
        Layer.succeed(ProcessRunner.ProcessRunner, executionRunner),
        Layer.mock(ProviderInstanceRegistry)({ getInstance: () => Effect.succeed(instance) }),
        Layer.mock(ProjectStoreV2)({
          get: () =>
            Effect.succeed(
              Option.some({
                projectId,
                title: "Fixture",
                workspaceRoot: repository,
                defaultModelSelection: null,
                defaultThreadEnvMode: null,
                autoPull: false,
                faviconPath: null,
                projectIcon: null,
                scripts: [],
                createdAt: now,
                updatedAt: now,
                deletedAt: null,
              }),
            ),
        }),
        ServerConfig.layerTest(root, root),
      );
      yield* Effect.gen(function* () {
        const execution = yield* FactoryExecution.FactoryExecution;
        const config = yield* ServerConfig.ServerConfig;
        const input = {
          projectId,
          modelSelection: { instanceId, model: "test-model" },
          workflow: { repositoryRoot: repository, revision },
        };
        const result = yield* execution.qualify(input);
        if (result.status !== "qualified") return assert.fail(result.reason);
        const profile = yield* fs
          .readFileString(
            path.join(config.stateDir, "factory", "execution", result.profileId, "profile.json"),
          )
          .pipe(Effect.flatMap(decodeProfile));
        assert.equal(
          yield* fs.readFileString(path.join(profile.projectSnapshotPath, "README.md")),
          "tracked source",
        );
        assert.equal(
          yield* fs.readFileString(
            path.join(profile.workflowSnapshotPath, "skills", "retro", "SKILL.md"),
          ),
          "committed workflow",
        );
        assert.equal(
          yield* fs.readFileString(
            path.join(profile.projectSnapshotPath, ".github", "control.yml"),
          ),
          "unchanged protected control\n",
        );
        assert.equal(
          yield* fs.readFileString(path.join(profile.projectSnapshotPath, "version.txt")),
          "$Format:%H$\n",
        );
        const sources = yield* FactorySource.FactorySource;
        const starting = yield* sources.capture({
          requestId: CommandId.make("same-baseline"),
          projectId,
        });
        const artifact = yield* sources.read(starting.id);
        for (const file of artifact.files) {
          assert.deepStrictEqual(
            Buffer.from(yield* fs.readFile(path.join(profile.projectSnapshotPath, file.path))),
            Buffer.from(file.content, "base64"),
          );
        }
        assert.isFalse(yield* fs.exists(path.join(profile.projectSnapshotPath, ".env")));
        assert.isFalse(yield* fs.exists(path.join(profile.projectSnapshotPath, ".git")));
        assert.include(
          yield* fs.readFileString(
            path.join(profile.projectSnapshotPath, "SATELLITE_DISCOVERY.md"),
          ),
          ".env",
        );
        if (process.env.SATELLITE_FACTORY_LIVE_TEST !== "1") {
          assert.equal(probeCount, 1);
          // A missing runner image is built from the bundled recipe, once.
          assert.deepStrictEqual(imageBuilds, [FACTORY_CODEX_DOCKERFILE]);
          acceptProbe = false;
          const rejected = yield* execution.qualify(input);
          assert.equal(rejected.status, "unavailable");
          assert.equal(probeCount, 2);
          assert.equal(imageBuilds.length, 1);
        }
      }).pipe(
        Effect.provide(
          FactoryExecution.layer.pipe(
            Layer.provideMerge(FactorySource.layer),
            Layer.provideMerge(dependencies),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(ProcessRunner.layer), Effect.provide(NodeServices.layer)),
);
