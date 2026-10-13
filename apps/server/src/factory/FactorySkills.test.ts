import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as FactorySkills from "./FactorySkills.ts";
import * as FactorySource from "./FactorySource.ts";

const skillsFor = (repositoryRoot: string) =>
  Effect.gen(function* () {
    const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
    return yield* FactorySkills.FactorySkills.pipe(
      Effect.provide(
        FactorySkills.layer.pipe(
          Layer.provide(FactorySource.layer),
          Layer.provide(
            Layer.mergeAll(
              ServerConfig.layerTest(root, root),
              ServerSettings.layerTest({
                engineeringManagersSkillsRepository: repositoryRoot,
              }).pipe(Layer.orDie),
              Layer.mock(ProjectStore.ProjectStoreV2)({}),
              Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
            ),
          ),
        ),
      ),
    );
  });

it.effect(
  "reads HEAD of the skills repository for each command and refuses a path without committed skills",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runner = yield* ProcessRunner.ProcessRunner;
      const root = yield* fs.makeTempDirectoryScoped();
      const repository = path.join(root, "skills-repository");
      const plain = path.join(root, "not-a-repository");
      const bare = path.join(root, "no-skills");
      for (const directory of [repository, plain, bare]) yield* fs.makeDirectory(directory);
      const git = Effect.fn(function* (cwd: string, args: ReadonlyArray<string>) {
        const result = yield* runner.run({ command: "git", args, cwd });
        assert.equal(result.code, 0, result.stderr);
        return result.stdout.trim();
      });
      const commit = Effect.fn(function* (cwd: string, name: string, content: string) {
        yield* fs.makeDirectory(path.dirname(path.join(cwd, name)), { recursive: true });
        yield* fs.writeFileString(path.join(cwd, name), content);
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", name]);
        return yield* git(cwd, ["rev-parse", "HEAD"]);
      });
      for (const directory of [repository, bare]) {
        yield* git(directory, ["init", "--initial-branch=main"]);
        yield* git(directory, ["config", "user.name", "Skills fixture"]);
        yield* git(directory, ["config", "user.email", "skills@example.invalid"]);
      }

      const skills = yield* skillsFor(repository);
      const first = yield* commit(repository, "skills/review/SKILL.md", "Review carefully.");
      assert.deepStrictEqual(yield* skills.head, {
        repositoryRoot: yield* fs.realPath(repository),
        revision: first,
      });
      const second = yield* commit(repository, "skills/review/SKILL.md", "Review twice.");
      assert.notEqual(second, first);
      assert.equal((yield* skills.head).revision, second);
      yield* skills.validate(repository);

      const refusal = (repositoryRoot: string) =>
        skills.validate(repositoryRoot).pipe(
          Effect.flip,
          Effect.map((error) => error.detail),
        );
      assert.equal(yield* refusal(plain), `${plain} is not a local Git repository.`);
      yield* commit(bare, "README.md", "No skills here.");
      // A skills directory on disk does not count until it is committed.
      yield* fs.makeDirectory(path.join(bare, "skills"));
      yield* fs.writeFileString(path.join(bare, "skills", "SKILL.md"), "Uncommitted.");
      assert.equal(yield* refusal(bare), `${bare} has no committed skills directory at HEAD.`);
      assert.equal(
        (yield* (yield* skillsFor(bare)).head.pipe(Effect.flip)).detail,
        `Set the skills repository in Settings → General first. ${bare} has no committed skills directory at HEAD.`,
      );
      assert.equal(
        (yield* (yield* skillsFor("")).head.pipe(Effect.flip)).detail,
        "Set the skills repository in Settings → General first.",
      );
    }).pipe(Effect.scoped, Effect.provide(ProcessRunner.layer), Effect.provide(NodeServices.layer)),
  30000,
);
