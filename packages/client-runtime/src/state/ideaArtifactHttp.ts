import { IdeaArtifactReadInput, IdeaArtifactWriteInput } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/unstable/http";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

function makeIdeaArtifactHttp(
  httpClient: HttpClient.HttpClient,
  signer: Option.Option<ManagedRelayDpopSigner["Service"]>,
  remoteAuthorization: Option.Option<RemoteEnvironmentAuthorization["Service"]>,
) {
  return {
    read: (prepared: PreparedConnection, input: typeof IdeaArtifactReadInput.Type) =>
      executeAuthenticatedEnvironmentHttpRequest({
        prepared,
        signer,
        remoteAuthorization,
        group: "ideas",
        method: "GET",
        timeoutMs: 60_000,
        url: (base) =>
          environmentEndpointUrl(
            base,
            `/api/ideas/${encodeURIComponent(input.threadId)}/artifacts/${encodeURIComponent(input.artifactId)}`,
          ),
        request: ({ client, headers }) => client.readArtifact({ params: input, headers }),
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
    write: (prepared: PreparedConnection, input: typeof IdeaArtifactWriteInput.Type) =>
      executeAuthenticatedEnvironmentHttpRequest({
        prepared,
        signer,
        remoteAuthorization,
        group: "ideas",
        method: "POST",
        timeoutMs: 60_000,
        url: (base) =>
          environmentEndpointUrl(
            base,
            `/api/ideas/${encodeURIComponent(input.threadId)}/artifacts`,
          ),
        request: ({ client, headers }) =>
          client.writeArtifact({
            params: { threadId: input.threadId },
            payload: {
              name: input.name,
              mediaType: input.mediaType,
              contentBase64: input.contentBase64,
            },
            headers,
          }),
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
  };
}

export class IdeaArtifactHttp extends Context.Service<
  IdeaArtifactHttp,
  ReturnType<typeof makeIdeaArtifactHttp>
>()("@t3tools/client-runtime/state/ideaArtifactHttp") {}

export const ideaArtifactHttpLayer = Layer.effect(
  IdeaArtifactHttp,
  Effect.gen(function* () {
    return makeIdeaArtifactHttp(
      yield* HttpClient.HttpClient,
      yield* Effect.serviceOption(ManagedRelayDpopSigner),
      yield* Effect.serviceOption(RemoteEnvironmentAuthorization),
    );
  }),
);
