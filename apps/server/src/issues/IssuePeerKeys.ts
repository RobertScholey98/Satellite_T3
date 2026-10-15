// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no Ed25519 signing.
import * as NodeCrypto from "node:crypto";
import type { EnvironmentId, IssueAttemptGeneration } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

/** Unauthenticated: a worktree environment proves its identity here before any credential is sent. */
export const ISSUE_PEER_PROOF_PATH = "/api/issues/peer-proof";

const KEY_PAIR_SECRET = "issue-peer-ed25519-key-pair";
const KeyPair = Schema.fromJsonString(
  Schema.Struct({ privateKey: Schema.String, publicKey: Schema.String }),
);
const decodeKeyPair = Schema.decodeUnknownEffect(KeyPair);
const encodeKeyPair = Schema.encodeSync(KeyPair);

/**
 * Each message names its purpose first, so a signature made for one purpose never verifies as
 * another.
 */
export const identityProofMessage = (input: {
  readonly environmentId: EnvironmentId;
  readonly endpoint: string;
  readonly nonce: string;
}) =>
  ["satellite-issue-peer-identity", input.environmentId, input.endpoint, input.nonce].join("\n");

export const generationMessage = (
  source: EnvironmentId,
  destination: EnvironmentId,
  generation: Pick<IssueAttemptGeneration, "attemptId" | "reservationId" | "sourceGeneration">,
) =>
  [
    "satellite-issue-peer-generation",
    source,
    destination,
    generation.attemptId,
    generation.reservationId,
    String(generation.sourceGeneration),
  ].join("\n");

export const verifyIssuePeerSignature = (input: {
  readonly publicKey: string;
  readonly message: string;
  readonly signature: string;
}) => {
  try {
    return NodeCrypto.verify(
      null,
      Buffer.from(input.message),
      input.publicKey,
      Buffer.from(input.signature, "base64"),
    );
  } catch {
    return false;
  }
};

/** This environment's Ed25519 key for issue delivery, kept in the server secret store. */
export class IssuePeerKeys extends Context.Service<
  IssuePeerKeys,
  {
    readonly publicKey: string;
    readonly sign: (message: string) => string;
  }
>()("t3/issues/IssuePeerKeys") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const read = secrets.get(KEY_PAIR_SECRET).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeedNone,
        onSome: (bytes) =>
          decodeKeyPair(new TextDecoder().decode(bytes)).pipe(Effect.map(Option.some)),
      }),
    ),
  );
  const existing = yield* read;
  const keyPair = Option.isSome(existing)
    ? existing.value
    : yield* Effect.gen(function* () {
        const generated = NodeCrypto.generateKeyPairSync("ed25519", {
          privateKeyEncoding: { format: "pem", type: "pkcs8" },
          publicKeyEncoding: { format: "pem", type: "spki" },
        });
        const created = yield* secrets
          .create(KEY_PAIR_SECRET, new TextEncoder().encode(encodeKeyPair(generated)))
          .pipe(Effect.result);
        if (created._tag === "Success") return generated;
        // Another runtime created it first; both must use the same key.
        const raced = yield* read;
        if (Option.isSome(raced)) return raced.value;
        return yield* created.failure;
      });
  return IssuePeerKeys.of({
    publicKey: keyPair.publicKey,
    sign: (message) =>
      NodeCrypto.sign(null, Buffer.from(message), keyPair.privateKey).toString("base64"),
  });
});

export const layer = Layer.effect(IssuePeerKeys, make.pipe(Effect.orDie));
