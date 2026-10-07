import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type DocumentDetail,
  type DocumentsPublishInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";

import { DocumentService } from "../../../documents/DocumentService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import { DocumentsToolkitHandlersLive } from "./handlers.ts";
import { DocumentsToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread-document-test");
const detail: DocumentDetail = {
  document: {
    id: "document-1",
    threadId,
    title: "Manual review",
    kind: "review",
    currentRevisionId: "revision-1",
    revisionNumber: 1,
    status: "draft",
    updatedAt: "2026-09-30T00:00:00.000Z",
  },
  revision: {
    id: "revision-1",
    documentId: "document-1",
    number: 1,
    format: "html",
    contentHash: "hash",
    createdAt: "2026-09-30T00:00:00.000Z",
    definition: { items: [{ id: "hide", title: "Hide window" }] },
  },
  content: "<h1>Manual review</h1>",
  answers: [],
  answerVersion: 0,
  lastSubmission: null,
};
const invocation = (capabilities: readonly McpInvocationContext.McpCapability[]) => ({
  environmentId: EnvironmentId.make("environment-documents-test"),
  requestNamespace: "session-1",
  thread: {
    threadId,
    providerSessionId: "session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const makeHarness = Effect.gen(function* () {
  const publications: Array<{ input: DocumentsPublishInput; actor: string }> = [];
  const reads: string[] = [];
  const service = Layer.mock(DocumentService)({
    list: ({ threadId: requestedThread }) =>
      Effect.succeed(requestedThread === threadId ? [detail.document] : []),
    get: ({ documentId }) =>
      Effect.sync(() => {
        reads.push(documentId);
        return detail;
      }),
    publish: (input, actor) =>
      Effect.sync(() => {
        publications.push({ input, actor });
        return detail;
      }),
  });
  const dependencies = Layer.mergeAll(service, McpToolAccessTestkit.liveThreadsLayer);
  const toolkit = yield* DocumentsToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(DocumentsToolkitHandlersLive).pipe(
        Layer.provide(dependencies),
      ),
    ),
  );
  const call = <Name extends keyof typeof DocumentsToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: readonly McpInvocationContext.McpCapability[] = ["documents"],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof DocumentsToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
      Effect.provide(dependencies),
    );
  return { call, publications, reads };
});

describe("document toolkit", () => {
  it.effect("rejects an old credential without document access", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const error = yield* harness.call("list_documents", {}, ["preview"]).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "documents",
      });
      expect(harness.reads).toEqual([]);
    }),
  );

  it.effect("binds publications to the agent's authenticated thread and identity", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const published = yield* harness.call("publish_document", {
        requestId: "publication-1",
        title: "Manual review",
        kind: "review",
        path: "/workspace/review.html",
        definition: detail.revision.definition,
      });
      expect(published).toEqual(detail.document);
      expect(harness.publications).toEqual([
        {
          input: {
            requestId: "publication-1",
            title: "Manual review",
            kind: "review",
            path: "/workspace/review.html",
            definition: detail.revision.definition,
            threadId,
          },
          actor: "agent:codex:session-1",
        },
      ]);
    }),
  );

  it.effect("does not read another thread's document by ID", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const error = yield* harness
        .call("read_document", { documentId: "other-thread-document" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "DocumentOperationError", reason: "not-found" });
      expect(harness.reads).toEqual([]);
    }),
  );

  it.effect("reads a retained review and distinguishes drafts from submissions", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const read = yield* harness.call("read_document", {
        documentId: "document-1",
        revisionId: "revision-1",
      });
      expect(read).toEqual({ ...detail, contentTruncated: false });
      expect(read.lastSubmission).toBeNull();
    }),
  );
});
