import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";

import { makeConfinedClaudeRuntime } from "./ConfinedClaudeProcess.ts";

it.effect("logs a runtime removal that fails, once, with the container's name", () =>
  Effect.gen(function* () {
    const logged: Array<unknown> = [];
    const runtime = makeConfinedClaudeRuntime({
      name: "satellite-factory-stuck",
      command: process.execPath,
      args: [],
      environment: {},
      cleanup: {
        command: process.execPath,
        args: [
          "-e",
          "process.stderr.write('Cannot connect to the Docker daemon\\n'); process.exit(1)",
        ],
        environment: { SystemRoot: process.env.SystemRoot },
      },
    });
    const capture = Logger.layer([Logger.make(({ message }) => void logged.push(message))], {
      mergeWithExisting: false,
    });
    yield* runtime.remove.pipe(Effect.provide(capture));
    yield* runtime.remove.pipe(Effect.provide(capture));
    assert.deepEqual(logged, [
      [
        "orchestration-v2.claude-confined-runtime-removal-failed",
        {
          runtime: "satellite-factory-stuck",
          timedOut: false,
          code: 1,
          stderr: "Cannot connect to the Docker daemon",
        },
      ],
    ]);
  }),
);
