import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId, WS_METHODS, type RevdocRunState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
  type NetworkStatus,
} from "./connection/model.ts";
import type { ConnectionCatalogEntry } from "./connection/catalog.ts";
import { EnvironmentRegistry } from "./connection/registry.ts";
import { EnvironmentSupervisor } from "./connection/supervisor.ts";
import type { RpcSession } from "./rpc/session.ts";
import { createRevdocEnvironmentAtoms, revdocEvidencePath, revdocSummary } from "./revdoc.ts";

describe("Revdoc review summaries", () => {
  it("reserves green for all complete without notes", () => {
    const complete = { id: "one", title: "Check", outcome: "complete" as const };
    expect(revdocSummary([complete]).good).toBe(true);
    expect(revdocSummary([complete], ["Follow up"]).good).toBe(false);
    expect(revdocSummary([{ ...complete, feedback: "Improve contrast" }]).good).toBe(false);
    expect(revdocSummary([{ ...complete, outcome: "na" }])).toMatchObject({
      reviewed: 1,
      good: false,
      findings: 0,
    });
    expect(revdocSummary([]).good).toBe(false);
  });
  it("does not count an agent verification as a human review", () => {
    expect(
      revdocSummary([{ id: "one", title: "Check", verification: { result: "passed" } }]),
    ).toMatchObject({ reviewed: 0, complete: 0, good: false });
  });
  it("only links image evidence inside the worktree evidence directory", () => {
    expect(revdocEvidencePath("evidence/screen.png")).toBe(".revdoc/evidence/screen.png");
    expect(revdocEvidencePath("evidence\\screen.webp")).toBe(".revdoc/evidence/screen.webp");
    for (const path of [
      "../screen.png",
      "evidence/../../secret.png",
      "C:/screen.png",
      "https://site/image.png",
      "evidence/page.html",
    ]) {
      expect(revdocEvidencePath(path)).toBeNull();
    }
  });
});

it.effect(
  "loads saved batches and completion without refetching the review for streamed activity",
  () =>
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.make<RevdocRunState>({
        running: true,
        phase: "generating",
        version: 1,
        reviewRevision: "first",
        error: null,
        result: null,
      });
      let reads = 0;
      const client = {
        [WS_METHODS.revdocGet]: () =>
          Effect.gen(function* () {
            reads++;
            const current = yield* SubscriptionRef.get(state);
            return {
              cwd: "/worktree",
              revision: current.reviewRevision,
              review: {
                title: current.running ? current.reviewRevision : "Complete",
                sections: [],
              },
            };
          }),
        [WS_METHODS.revdocChanges]: () => SubscriptionRef.changes(state),
      };
      const target = new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make("review-environment"),
        label: "Review environment",
        httpBaseUrl: "https://review.example.test",
        wsBaseUrl: "wss://review.example.test",
      });
      const supervisor = EnvironmentSupervisor.of({
        target,
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected" as const,
        }),
        session: yield* SubscriptionRef.make(Option.some({ client } as unknown as RpcSession)),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const runtime = Atom.runtime(
        Layer.mock(EnvironmentRegistry)({
          entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
            new Map(),
          ),
          networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
          run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
          followStream: (_id, stream) =>
            Stream.provideService(stream, EnvironmentSupervisor, supervisor),
        }),
      );
      const atoms = createRevdocEnvironmentAtoms(runtime);
      const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
        Effect.sync(() => registry.dispose()),
      );
      const input = {
        environmentId: target.environmentId,
        input: { threadId: ThreadId.make("review-thread") },
      };
      const query = atoms.get(input);
      registry.mount(query);
      const received = (version: number) =>
        AtomRegistry.toStream(registry, atoms.changes(input)).pipe(
          Stream.filter(
            (result) => AsyncResult.isSuccess(result) && result.value.version === version,
          ),
          Stream.runHead,
        );
      yield* received(1);
      expect(
        (yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true })).review?.title,
      ).toBe("first");
      const initialReads = reads;
      yield* SubscriptionRef.update(state, (current) => ({
        ...current,
        version: 2,
        activity: [{ batch: 2, elapsedMs: 1000, thinking: "Reading", outputBytes: 10 }],
      }));
      yield* received(2);
      yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true });
      expect(reads).toBe(initialReads);
      yield* SubscriptionRef.update(state, (current) => ({
        ...current,
        version: 3,
        reviewRevision: "second",
      }));
      yield* received(3);
      expect(
        (yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true })).review?.title,
      ).toBe("second");
      expect(reads).toBe(initialReads + 1);
      yield* SubscriptionRef.update(state, (current) => ({
        ...current,
        running: false,
        version: 4,
        result: "completed" as const,
      }));
      yield* received(4);
      expect(
        (yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true })).review?.title,
      ).toBe("Complete");
      expect(reads).toBe(initialReads + 2);
    }).pipe(Effect.scoped),
);
