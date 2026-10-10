import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient, HttpRouter, HttpServer } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { deliveryIds, deliveryNow, reviewedDeliveryFixture } from "./FactoryDelivery.testkit.ts";
import { FactoryPreviewEvidence } from "./FactoryPreviewEvidence.ts";
import { routeLayer } from "./FactoryPreviewHttp.ts";
import { FactoryStore } from "./FactoryStore.ts";

const setup = (scopes: readonly AuthEnvironmentScope[]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const crypto = yield* Crypto.Crypto;
    const directory = yield* fs.makeTempDirectoryScoped();
    const path = `${directory}/screenshot.png`;
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4n8AAAAASUVORK5CYII=",
      "base64",
    );
    yield* fs.writeFile(path, bytes);
    const digest = Buffer.from(yield* crypto.digest("SHA-256", bytes)).toString("hex");
    const operationsDigest = "a".repeat(64);
    const evidence = {
      instanceId: "instance",
      candidateDigest: "digest",
      reviewThreadId: deliveryIds.reviewer,
      operationsDigest,
      screenshots: [{ label: "Saved task", location: "sealed" }],
      journeys: [{ label: "Save task", location: "journal" }],
      observedAt: deliveryNow,
    };
    const initial = reviewedDeliveryFixture();
    const state = {
      ...initial,
      assignments: initial.assignments.map((assignment) => ({
        ...assignment,
        delivery: {
          ...assignment.delivery!,
          revisions: assignment.delivery!.revisions.map((revision) => ({
            ...revision,
            uxEvidence: evidence,
          })),
        },
      })),
    };
    let reads = 0;
    const layers = Layer.mergeAll(
      Layer.mock(FactoryStore)({ snapshot: Effect.succeed(state) }),
      Layer.mock(FactoryPreviewEvidence)({
        read: () =>
          Effect.sync(() => {
            reads += 1;
            return { evidence, artifacts: [{ path, digest, label: "Saved task" }] };
          }),
      }),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({
        authenticateWebSocketUpgrade: () =>
          Effect.succeed({
            sessionId: AuthSessionId.make("test"),
            subject: "test",
            method: "bearer-access-token",
            scopes,
          }),
      }),
    );
    const services = yield* Layer.build(
      HttpRouter.serve(routeLayer.pipe(Layer.provide(layers)), { disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provide(layers),
      ),
    );
    const origin = HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address);
    const request = (suffix = `${operationsDigest}/0`) =>
      HttpClient.get(`${origin}/api/factory/preview-evidence/${suffix}?wsTicket=test`);
    return { request, bytes, reads: () => reads, tamper: fs.writeFileString(path, "changed") };
  });

it.effect("serves only authenticated, recorded, intact evidence PNGs", () =>
  Effect.gen(function* () {
    const f = yield* setup([AuthOrchestrationReadScope]);
    const valid = yield* f.request();
    assert.equal(valid.status, 200);
    assert.equal(valid.headers["content-type"], "image/png");
    assert.equal(valid.headers["cache-control"], "private, no-store");
    assert.deepEqual(Buffer.from(yield* valid.arrayBuffer), f.bytes);
    assert.equal((yield* f.request(`${"b".repeat(64)}/0`)).status, 404);
    assert.equal((yield* f.request("invalid/0")).status, 404);
    assert.equal(f.reads(), 1);
    yield* f.tamper;
    assert.equal((yield* f.request()).status, 409);
  }).pipe(Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
);

it.effect("denies viewers without orchestration read scope before accessing private images", () =>
  Effect.gen(function* () {
    const f = yield* setup([]);
    assert.equal((yield* f.request()).status, 403);
    assert.equal(f.reads(), 0);
  }).pipe(Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
);
