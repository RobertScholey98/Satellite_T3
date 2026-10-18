import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { cleanUpLegacyIssuePeers } from "./legacyPeerCleanup.ts";

const layerTest = () =>
  SessionStore.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("env-here")),
      }),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-issue-peer-cleanup-" })),
  );

const PEER_CREDENTIAL = "issue-peer-0123456789abcdef0123456789abcdef";
const bytes = new Uint8Array([1, 2, 3]);

it.layer(NodeServices.layer)("cleanUpLegacyIssuePeers", (it) => {
  it.effect("removes peer secrets and peer sessions once and records that it ran", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fileSystem = yield* FileSystem.FileSystem;
      const { secretsDir } = yield* ServerConfig.ServerConfig;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const sessions = yield* SessionStore.SessionStore;
      yield* secrets.set("issue-peer-ed25519-key-pair", bytes);
      yield* secrets.set(PEER_CREDENTIAL, bytes);
      yield* secrets.set("issue-peer-notes", bytes);
      yield* secrets.set("source-control-token", bytes);
      yield* sessions.issue({ subject: "issue-peer:env-b" });
      const browser = yield* sessions.issue({ subject: "browser" });

      yield* cleanUpLegacyIssuePeers;

      assert.deepStrictEqual((yield* fileSystem.readDirectory(secretsDir)).toSorted(), [
        "issue-peer-notes.bin",
        "server-signing-key.bin",
        "source-control-token.bin",
      ]);
      const remaining = (yield* sessions.listActive()).map((session) => ({
        sessionId: session.sessionId,
        subject: session.subject,
      }));
      assert.deepStrictEqual(remaining, [{ sessionId: browser.sessionId, subject: "browser" }]);
      const recorded = yield* sql<{ readonly name: string }>`SELECT name FROM issue_maintenance`;
      assert.deepStrictEqual(recorded, [{ name: "legacy-peer-cleanup" }]);

      // A peer session or credential appearing later is not the dev builds' leftovers.
      yield* secrets.set(PEER_CREDENTIAL, bytes);
      const laterPeer = yield* sessions.issue({ subject: "issue-peer:env-c" });

      yield* cleanUpLegacyIssuePeers;

      assert.deepStrictEqual((yield* fileSystem.readDirectory(secretsDir)).toSorted(), [
        `${PEER_CREDENTIAL}.bin`,
        "issue-peer-notes.bin",
        "server-signing-key.bin",
        "source-control-token.bin",
      ]);
      assert.deepStrictEqual(
        (yield* sessions.listActive()).map((session) => session.sessionId).toSorted(),
        [browser.sessionId, laterPeer.sessionId].toSorted(),
      );
    }).pipe(Effect.provide(layerTest())),
  );
});
