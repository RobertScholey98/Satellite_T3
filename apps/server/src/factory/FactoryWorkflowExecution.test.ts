import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as FactorySource from "./FactorySource.ts";
import * as Workflow from "./FactoryWorkflowExecution.ts";
import { factoryDockerArguments } from "./FactoryExecutionProfile.ts";

it.effect(
  "pins exact committed workflow bytes, rejects tampering, and recovers only exact legacy snapshots",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const root = yield* fs.makeTempDirectoryScoped();
      const version = { repositoryRoot: "/owned/workflow", revision: "a".repeat(40) };
      const next = { ...version, revision: "b".repeat(40) };
      const file = Effect.fn(function* (name: string, text: string) {
        return {
          path: name,
          content: Buffer.from(text).toString("base64"),
          digest: Buffer.from(yield* crypto.digest("SHA-256", Buffer.from(text))).toString("hex"),
          mode: "100644" as const,
        };
      });
      const oldFile = yield* file("skills/implementation/SKILL.md", "old instructions");
      const newFile = yield* file("skills/implementation/SKILL.md", "new instructions");
      const authoring = yield* file(
        "skills/writing-for-agents/SKILL.md",
        "Read SKILL-MECHANICS.md before editing",
      );
      const mechanics = yield* file(
        "skills/writing-for-agents/SKILL-MECHANICS.md",
        "authoring mechanics",
      );
      const dependencies = Layer.mergeAll(
        ServerConfig.layerTest(root, root),
        Layer.mock(FactorySource.FactorySource)({
          readRevision: (_root, revision) =>
            Effect.succeed({
              files: revision === version.revision ? [oldFile] : [newFile, authoring, mechanics],
              excludedPaths: [],
            }),
        }),
      );
      yield* Effect.gen(function* () {
        const service = yield* Workflow.FactoryWorkflowExecution;
        const old = yield* service.snapshot({ version });
        yield* fs.remove(old.manifestPath);
        assert.equal((yield* service.snapshot({ version })).digest, old.digest);
        const fresh = yield* service.snapshot({ version: next, requireSkillAuthoring: true });
        assert.notEqual(old.digest, fresh.digest);
        assert.equal(
          yield* fs.readFileString(path.join(old.snapshotPath, oldFile.path)),
          "old instructions",
        );
        assert.equal(
          yield* fs.readFileString(path.join(fresh.snapshotPath, newFile.path)),
          "new instructions",
        );
        const profile = {
          boundaryId: "profile",
          dockerContext: "local",
          imageId: "image",
          projectSnapshotPath: root,
          runtimePath: root,
          workflowSnapshotPath: fresh.snapshotPath,
          workflow: fresh,
        };
        assert.include(
          factoryDockerArguments(profile),
          `type=bind,source=${fresh.snapshotPath},target=/workflow,readonly`,
        );
        assert.equal(
          (yield* service.resolve({ profile, expectedVersion: version }).pipe(Effect.flip)).code,
          "execution-unavailable",
        );
        assert.equal(
          (yield* service.snapshot({ version, requireSkillAuthoring: true }).pipe(Effect.flip))
            .code,
          "execution-unavailable",
        );
        const legacy = path.join(root, "legacy");
        yield* fs.makeDirectory(path.join(legacy, "skills", "implementation"), { recursive: true });
        yield* fs.writeFileString(path.join(legacy, oldFile.path), "old instructions");
        const { workflow: _identity, ...legacyProfile } = profile;
        const recovered = yield* service.resolve({
          profile: { ...legacyProfile, workflowSnapshotPath: legacy },
          expectedVersion: version,
        });
        assert.equal(recovered.digest, old.digest);
        yield* fs.writeFileString(path.join(legacy, oldFile.path), "unapproved instructions");
        assert.equal(
          (yield* service
            .resolve({
              profile: { ...legacyProfile, workflowSnapshotPath: legacy },
              expectedVersion: version,
            })
            .pipe(Effect.flip)).code,
          "execution-unavailable",
        );
        yield* fs.writeFileString(
          path.join(fresh.snapshotPath, "unexpected.md"),
          "injected instructions",
        );
        assert.equal(
          (yield* service.verify({ snapshot: fresh, expectedVersion: next }).pipe(Effect.flip))
            .code,
          "execution-unavailable",
        );
        yield* fs.remove(path.join(fresh.snapshotPath, "unexpected.md"));
        yield* fs.chmod(path.join(fresh.snapshotPath, newFile.path), 0o644);
        yield* fs.writeFileString(
          path.join(fresh.snapshotPath, newFile.path),
          "changed mounted bytes",
        );
        assert.equal(
          (yield* service.resolve({ profile, expectedVersion: next }).pipe(Effect.flip)).code,
          "execution-unavailable",
        );
      }).pipe(Effect.provide(Workflow.layer.pipe(Layer.provideMerge(dependencies))));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
