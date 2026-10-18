import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect("identifies a failed source read and preserves its cause", () => {
  const sourceState = "/profiles/satellite-t3/Local State";
  const cause = PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method: "readFileString",
    pathOrDescriptor: sourceState,
  });
  return Effect.gen(function* () {
    const error = yield* resolveUserDataPath({
      appDataDirectory: "/profiles",
      isDevelopment: false,
      platform: "win32",
    }).pipe(Effect.flip);
    assert.equal(error.operation, "read");
    assert.equal(error.resourcePath, sourceState);
    assert.equal(error.category, "PermissionDenied");
    assert.strictEqual(error.cause, cause);
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: (path) => Effect.succeed(path === sourceState),
        readFileString: () => Effect.fail(cause),
      }),
    ),
    Effect.provide(NodeServices.layer),
  );
});

const state = '{"os_crypt":{"encrypted_key":"test-encrypted-key"}}';

it.effect(
  "preserves Windows credential keys from the Satellite 1.x profile without copying browser databases",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "satellite-v2-profile-" });
      const source = path.join(directory, "satellite-t3");
      const destination = path.join(directory, "satellite-t3-v2");
      yield* fs.makeDirectory(path.join(source, "IndexedDB"), { recursive: true });
      yield* fs.writeFileString(path.join(source, "Local State"), state);
      yield* fs.writeFileString(path.join(source, "IndexedDB", "LOCK"), "1.x owns this database");

      const resolved = yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform: "win32",
      });

      assert.equal(resolved, destination);
      assert.equal(yield* fs.readFileString(path.join(destination, "Local State")), state);
      assert.equal(yield* fs.readFileString(path.join(source, "Local State")), state);
      assert.isFalse(yield* fs.exists(path.join(destination, "IndexedDB")));
      yield* fs.writeFileString(path.join(destination, "Local State"), "existing 2.x state");
      yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform: "win32",
      });
      assert.equal(
        yield* fs.readFileString(path.join(destination, "Local State")),
        "existing 2.x state",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("never adopts credential keys from a T3 Code profile", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "satellite-v2-profile-" });
    for (const t3Profile of ["t3code", "t3code-v2", "T3 Code (Alpha)", "T3 Code (Beta)"]) {
      yield* fs.makeDirectory(path.join(directory, t3Profile), { recursive: true });
      yield* fs.writeFileString(path.join(directory, t3Profile, "Local State"), state);
    }

    const resolved = yield* resolveUserDataPath({
      appDataDirectory: directory,
      isDevelopment: false,
      platform: "win32",
    });

    assert.equal(resolved, path.join(directory, "satellite-t3-v2"));
    assert.isFalse(yield* fs.exists(path.join(resolved, "Local State")));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps development in the Satellite development profile", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "satellite-v2-profile-" });
    yield* fs.makeDirectory(path.join(directory, "satellite-t3"), { recursive: true });
    yield* fs.writeFileString(path.join(directory, "satellite-t3", "Local State"), state);

    const resolved = yield* resolveUserDataPath({
      appDataDirectory: directory,
      isDevelopment: true,
      platform: "win32",
    });

    assert.equal(resolved, path.join(directory, "satellite-t3-dev"));
    assert.isFalse(yield* fs.exists(path.join(resolved, "Local State")));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
