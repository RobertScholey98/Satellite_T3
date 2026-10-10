import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { FactoryAssignmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import * as ServerConfig from "../config.ts";
import * as FactoryRetroEvidence from "./FactoryRetroEvidence.ts";

it.effect("seals replayable evidence and rejects altered content or a different conclusion", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    yield* Effect.gen(function* () {
      const evidence = yield* FactoryRetroEvidence.FactoryRetroEvidence;
      const input = {
        retroId: "retro:assignment",
        conclusionId: "conclusion:assignment",
        assignmentId: FactoryAssignmentId.make("assignment"),
        documents: [
          { name: "assignment.json", content: '{"outcome":"cancelled"}' },
          { name: "team.json", content: '{"messages":["No process change needed"]}' },
          { name: "feedback.json", content: '{"reason":"Priority changed"}' },
        ] as const,
      };
      const sealed = yield* evidence.seal(input);
      assert.deepEqual(yield* evidence.seal(input), sealed);
      const artifact = yield* evidence.read({ ...input, ...sealed });
      assert.equal(
        yield* fs.readFileString(path.join(artifact.directory, "feedback.json")),
        input.documents[2].content,
      );
      assert.isTrue(
        Result.isFailure(
          yield* evidence.read({ ...input, ...sealed, conclusionId: "other" }).pipe(Effect.result),
        ),
      );
      yield* fs.writeFileString(
        path.join(artifact.directory, "feedback.json"),
        "changed after sealing",
      );
      assert.isTrue(
        Result.isFailure(yield* evidence.read({ ...input, ...sealed }).pipe(Effect.result)),
      );
      assert.isTrue(Result.isFailure(yield* evidence.seal(input).pipe(Effect.result)));
      const next = yield* evidence.seal({
        ...input,
        documents: input.documents.map((document) => ({
          ...document,
          content: `${document.content}\n`,
        })),
      });
      assert.notEqual(next.evidenceDigest, sealed.evidenceDigest);
      yield* evidence.read({ ...input, ...next });
    }).pipe(
      Effect.provide(
        FactoryRetroEvidence.layer.pipe(Layer.provide(ServerConfig.layerTest(root, root))),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
