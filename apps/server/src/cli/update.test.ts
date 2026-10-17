import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as BootService from "../cloud/bootService.ts";
import * as ProcessRunner from "../processRunner.ts";
import { repointLauncher, resolveLauncherPath, runUpdate } from "./update.ts";

it.layer(NodeServices.layer)("t3 update launcher", (it) => {
  it.effect("repoints a symlink that lives in a runtime versions tree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const oldExe = path.join(root, "runtime/versions/1.0.0/t3");
      const newExe = path.join(root, "runtime/versions/2.0.0/t3");
      const launcher = path.join(root, "bin/t3");
      for (const file of [oldExe, newExe]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.symlink(oldExe, launcher);

      const repointed = yield* repointLauncher({
        launchedAs: launcher,
        versionsDir: path.join(root, "runtime/versions"),
        targetEntryPath: newExe,
      });

      assert.deepStrictEqual(Option.getOrUndefined(repointed), launcher);
      assert.equal(yield* fs.readLink(launcher), newExe);
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("leaves a plain copy or a foreign symlink alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const newExe = path.join(root, "runtime/versions/2.0.0/t3");
      const copy = path.join(root, "copy/t3");
      const foreign = path.join(root, "foreign/t3");
      const elsewhere = path.join(root, "elsewhere/t3");
      const otherHome = path.join(root, "other/runtime/versions/1.0.0/t3");
      const otherLauncher = path.join(root, "other/bin/t3");
      for (const file of [newExe, copy, elsewhere, otherHome]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      yield* fs.makeDirectory(path.dirname(foreign), { recursive: true });
      yield* fs.symlink(elsewhere, foreign);
      yield* fs.makeDirectory(path.dirname(otherLauncher), { recursive: true });
      yield* fs.symlink(otherHome, otherLauncher);

      for (const launchedAs of [copy, foreign, otherLauncher, undefined]) {
        const repointed = yield* repointLauncher({
          launchedAs,
          versionsDir: path.join(root, "runtime/versions"),
          targetEntryPath: newExe,
        });
        assert.equal(repointed._tag, "None", launchedAs ?? "undefined");
      }
      assert.equal(yield* fs.readLink(foreign), elsewhere);
      assert.equal(yield* fs.readLink(otherLauncher), otherHome);
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("finds the launcher a bare command name resolved to on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const launcher = path.join(root, "bin/t3");
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.writeFileString(launcher, "");

      const bare = yield* resolveLauncherPath.pipe(
        Effect.provideService(HostProcess.InvokedAs, "t3"),
        Effect.provideService(HostProcess.Environment, {
          PATH: `${path.join(root, "missing")}:${path.join(root, "bin")}`,
        }),
        Effect.provideService(HostProcess.WorkingDirectory, root),
      );
      const relative = yield* resolveLauncherPath.pipe(
        Effect.provideService(HostProcess.InvokedAs, "./bin/t3"),
        Effect.provideService(HostProcess.Environment, { PATH: "" }),
        Effect.provideService(HostProcess.WorkingDirectory, root),
      );
      const absent = yield* resolveLauncherPath.pipe(
        Effect.provideService(HostProcess.InvokedAs, "t3"),
        Effect.provideService(HostProcess.Environment, { PATH: path.join(root, "missing") }),
        Effect.provideService(HostProcess.WorkingDirectory, root),
      );

      assert.equal(bare, launcher);
      assert.equal(relative, launcher);
      assert.equal(absent, undefined);
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("reports a Satellite release with no CLI archive without downloading elsewhere", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const requests: Array<string> = [];
      const httpClient = HttpClient.make((request) => {
        requests.push(request.url);
        const response = request.url.includes("api.github.com")
          ? new Response(JSON.stringify([{ tag_name: "v900.0.0" }]))
          : new Response("Not Found", { status: 404 });
        return Effect.succeed(HttpClientResponse.fromWeb(request, response));
      });

      const error = yield* runUpdate({
        baseDir,
        logsDir: path.join(baseDir, "logs"),
        serverRuntimeStatePath: path.join(baseDir, "server-runtime.json"),
        channel: "stable",
        requestedVersion: undefined,
        allowDowngrade: false,
        assumeYes: true,
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.provideService(
          BootService.BootService,
          BootService.BootService.of({
            status: Effect.succeed({
              supported: false,
              installed: false,
              current: false,
              unitPath: path.join(baseDir, "unit"),
              logPath: path.join(baseDir, "boot.log"),
            }),
            withStopped: (operation) => operation,
            restart: Effect.die("restart"),
            install: () => Effect.die("install"),
            uninstall: Effect.die("uninstall"),
          }),
        ),
        Effect.provideService(
          ProcessRunner.ProcessRunner,
          ProcessRunner.ProcessRunner.of({ run: () => Effect.die("no process expected") }),
        ),
        Effect.provideService(HostProcess.Architecture, "x64"),
        Effect.provideService(HostProcess.Environment, {}),
        Effect.flip,
      );

      assert.equal(error.message, "No release archive was published for t3@900.0.0.");
      assert.deepStrictEqual(requests, [
        "https://api.github.com/repos/RobertScholey98/Satellite_T3/releases?per_page=100&page=1",
        "https://github.com/RobertScholey98/Satellite_T3/releases/download/v900.0.0/SHA256SUMS",
      ]);
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );
});
