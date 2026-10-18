import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";

const CLEANUP_NAME = "legacy-peer-cleanup";
/** The dev-build key pair and one `issue-peer-<sha256 prefix>` credential per worktree computer. */
const PEER_SECRET_FILE = /^issue-peer-(?:ed25519-key-pair|[0-9a-f]{32})\.bin$/;
const PEER_SESSION_SUBJECT_PREFIX = "issue-peer:";

export class LegacyIssuePeerSecretsListError extends Schema.TaggedError<LegacyIssuePeerSecretsListError>()(
  "LegacyIssuePeerSecretsListError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to list server secrets for the legacy issue peer cleanup.";
  }
}

export type LegacyIssuePeerCleanupError =
  | LegacyIssuePeerSecretsListError
  | ServerSecretStore.SecretStoreError
  | SessionStore.SessionCredentialInternalError
  | SqlError.SqlError;

/**
 * Removes what the Oct 2026 dev builds' issue delivery left outside the database: the issue peer
 * key pair, the per-computer peer credentials, and the auth sessions issued to peers. Runs once per
 * database; the issues service calls it at startup and logs a failure.
 */
export const cleanUpLegacyIssuePeers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const completed = yield* sql`SELECT 1 FROM issue_maintenance WHERE name = ${CLEANUP_NAME}`;
  if (completed.length > 0) return;

  const fileSystem = yield* FileSystem.FileSystem;
  const { secretsDir } = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const sessions = yield* SessionStore.SessionStore;

  const files = yield* fileSystem
    .readDirectory(secretsDir)
    .pipe(Effect.mapError((cause) => new LegacyIssuePeerSecretsListError({ cause })));
  const peerSecrets = files
    .filter((file) => PEER_SECRET_FILE.test(file))
    .map((file) => file.slice(0, -".bin".length));
  for (const name of peerSecrets) {
    yield* secrets.remove(name);
  }

  const peerSessions = (yield* sessions.listActive()).filter((session) =>
    session.subject.startsWith(PEER_SESSION_SUBJECT_PREFIX),
  );
  for (const session of peerSessions) {
    yield* sessions.revoke(session.sessionId);
  }

  const now = DateTime.formatIso(yield* DateTime.now);
  yield* sql`INSERT INTO issue_maintenance (name, completed_at) VALUES (${CLEANUP_NAME}, ${now})
    ON CONFLICT(name) DO NOTHING`;
  yield* Effect.annotateCurrentSpan({
    "issue_peers.secrets_removed": peerSecrets.length,
    "issue_peers.sessions_revoked": peerSessions.length,
  });
}).pipe(Effect.withSpan("cleanUpLegacyIssuePeers"));
