import { assert, describe, it } from "@effect/vitest";
import {
  FactoryManagersUpdateSettingsInput,
  type FactoryOnboardingResult,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import {
  EPOCH,
  FACTORY,
  IN_PROGRESS,
  READY,
  RESULT,
  SAVED_RESULT,
  activeManager,
  approve,
  board,
  create,
  makeFactory,
  setupDone,
  startTicket,
  withDatabase,
  type Factory,
} from "./FactoryService.testkit.ts";

const withResult = (changes: Partial<FactoryOnboardingResult>): FactoryOnboardingResult => ({
  ...RESULT,
  ...changes,
});

/** An approved, picking-up manager whose project board has `tickets` Ready. */
const settledManager = (factory: Factory, tickets: ReadonlyArray<number> = []) =>
  Effect.gen(function* () {
    factory.boards.push(board(tickets.map((number) => ({ number, columnId: READY }))));
    return yield* setupDone(factory, yield* activeManager(factory));
  });

const openedAt = (factory: Factory, managerId: string) =>
  factory.service
    .listManagers({})
    .pipe(Effect.map((managers) => managers.find((entry) => entry.id === managerId)!.updatedAt));

let requests = 0;
/** A save from settings opened just now, as the card sends it. */
const update = (
  factory: Factory,
  managerId: string,
  result: FactoryOnboardingResult,
  extra: Partial<FactoryManagersUpdateSettingsInput> = {},
) =>
  Effect.gen(function* () {
    return yield* factory.service.updateSettings({
      requestId: `settings-${(requests += 1)}`,
      managerId,
      result,
      expectedUpdatedAt: yield* openedAt(factory, managerId),
      ...extra,
    });
  });

/** The second manager in the project, approved with `result`. */
const secondManager = (factory: Factory, result: FactoryOnboardingResult) =>
  Effect.gen(function* () {
    const created = yield* create(factory.service, "create-2", "Bea");
    return yield* approve(factory, created.id, created.threadId!, result);
  });

const OVERLAP =
  "Ada already picks up from Ready on Roadmap with overlapping labels. Give each manager its own labels or columns.";

describe("FactoryService manager settings", () => {
  it.effect("refuses an edit for each input approval refuses", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { manager } = yield* settledManager(factory);
        const refused = [
          [
            withResult({ rules: [{ id: "other", question: "Other?", answer: "Yes" }] }),
            `Rule "other" answers none of the manager's questions.`,
          ],
          [withResult({ rules: [] }), `Answer "Which tickets count as small?" first.`],
          [
            withResult({ pickup: { ...RESULT.pickup, columns: [] } }),
            "Pickup is on, so choose at least one Ready column for it.",
          ],
          [
            withResult({
              pickup: {
                ...RESULT.pickup,
                columns: [{ boardId: "board-1", columnId: IN_PROGRESS }],
              },
            }),
            `Column ${IN_PROGRESS} is not a Ready column of Roadmap.`,
          ],
          [
            withResult({ controlPaths: [{ path: "../shared/**", reason: "" }] }),
            `"../shared/**" leaves the repository; use a path relative to its root.`,
          ],
          [
            withResult({ teamIds: ["nope"] }),
            `There is no factory team "nope". Choose from the teams in the factory config.`,
          ],
        ] as const;
        for (const [result, message] of refused) {
          const failure = yield* update(factory, manager.id, result).pipe(Effect.flip);
          assert.deepStrictEqual([failure.reason, failure.message], ["invalid", message]);
        }
        // The cap's bounds are the schema's, so the RPC refuses them before the service.
        const decode = Schema.decodeUnknownOption(FactoryManagersUpdateSettingsInput);
        for (const concurrencyCap of [0, 21])
          assert.isTrue(
            Option.isNone(
              decode({
                requestId: "r",
                managerId: "m",
                result: { ...RESULT, concurrencyCap },
                expectedUpdatedAt: EPOCH,
              }),
            ),
          );
        assert.isTrue(
          Option.isSome(
            decode({ requestId: "r", managerId: "m", result: RESULT, expectedUpdatedAt: EPOCH }),
          ),
        );
        assert.deepStrictEqual(
          (yield* factory.service.listManagers({}))[0]!.onboardingResult,
          SAVED_RESULT,
        );
      }),
    ),
  );

  it.effect("refuses approval for the checks a settings change makes", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        yield* settledManager(factory);
        const created = yield* create(factory.service, "create-2", "Bea");
        yield* factory.service.proposeOnboarding(created.threadId!, {
          summary: "",
          purpose: "",
          pickup: { enabled: true, guidance: "" },
          rules: [],
          controlPaths: [],
          findings: [],
        });
        const approval = (result: FactoryOnboardingResult) =>
          factory.service
            .approveOnboarding({
              requestId: `approve-${(requests += 1)}`,
              managerId: created.id,
              result,
            })
            .pipe(
              Effect.flip,
              Effect.map((failure) => failure.message),
            );
        const bare = withResult({ rules: [], controlPaths: [] });
        assert.strictEqual(yield* approval(bare), OVERLAP);
        const apart = { ...bare.pickup, enabled: false };
        assert.strictEqual(
          yield* approval({
            ...bare,
            pickup: apart,
            controlPaths: [{ path: "C:/repo", reason: "" }],
          }),
          `"C:/repo" is an absolute path; use a path relative to the repository root.`,
        );
        assert.strictEqual(
          yield* approval({ ...bare, pickup: apart, teamIds: ["nope"] }),
          `There is no factory team "nope". Choose from the teams in the factory config.`,
        );
      }),
    ),
  );

  it.effect("refuses pickup that overlaps another manager's, and allows it on other labels", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { manager: ada } = yield* settledManager(factory);
        yield* update(
          factory,
          ada.id,
          withResult({ pickup: { ...RESULT.pickup, labels: ["Frontend"] } }),
        );
        const bea = yield* secondManager(
          factory,
          withResult({ pickup: { ...RESULT.pickup, enabled: false } }),
        );
        // No labels means any ticket, and labels match regardless of case.
        for (const labels of [[], ["frontend"]]) {
          const overlapping = yield* update(
            factory,
            bea.id,
            withResult({ pickup: { ...RESULT.pickup, labels } }),
          ).pipe(Effect.flip);
          assert.strictEqual(overlapping.message, OVERLAP);
        }
        const apart = yield* update(
          factory,
          bea.id,
          withResult({ pickup: { ...RESULT.pickup, labels: ["Backend"] } }),
        );
        assert.deepStrictEqual(apart.onboardingResult!.pickup.labels, ["Backend"]);
      }),
    ),
  );

  it.effect("saves an edit, keeps the manager's questions, and wakes it with what changed", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { manager, sentBefore } = yield* settledManager(factory);
        const saved = yield* update(
          factory,
          manager.id,
          withResult({
            pickup: { ...RESULT.pickup, guidance: "Bugs only." },
            rules: [
              { id: "small-tickets", question: "Reworded by the client?", answer: "Two files" },
            ],
            controlPaths: [...RESULT.controlPaths, { path: ".github/**", reason: "" }],
            concurrencyCap: 3,
            baseBranch: "release",
          }),
        );
        assert.strictEqual(saved.state, "active");
        assert.deepStrictEqual(saved.onboardingResult, {
          ...SAVED_RESULT,
          pickup: { ...SAVED_RESULT.pickup, guidance: "Bugs only." },
          rules: [
            { id: "small-tickets", question: "Which tickets count as small?", answer: "Two files" },
          ],
          controlPaths: [...RESULT.controlPaths, { path: ".github/**", reason: "" }],
          concurrencyCap: 3,
        });
        assert.deepStrictEqual(
          factory.sentMessages.slice(sentBefore).map((message) => [message.threadId, message.text]),
          [
            [
              manager.threadId!,
              [
                "The user changed your settings:",
                `- pickup guidance: "Small, well-specified bugs." → "Bugs only."`,
                "- concurrency cap: 1 → 3",
                "- protected paths: AGENTS.md (Agent instructions.) → AGENTS.md (Agent instructions.), .github/**",
                `- rule "Which tickets count as small?": "One file" → "Two files"`,
                "Use them from now on.",
              ].join("\n"),
            ],
          ],
        );

        // Saving the same settings again tells the manager nothing.
        yield* update(factory, manager.id, saved.onboardingResult!);
        assert.strictEqual(factory.sentMessages.length, sentBefore + 1);
      }),
    ),
  );

  it.effect("runs to the lower of the manager's and the environment's cap", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { manager } = yield* settledManager(factory, [1]);
        yield* factory.service.updateConfig({
          scope: "environment",
          config: { ...FACTORY, concurrencyCap: 3 },
        });
        yield* startTicket(factory, manager.threadId!);
        // The manager's cap of 1 is the lower one.
        assert.isFalse((yield* factory.service.status(manager.id)).capacityFree);

        yield* update(factory, manager.id, withResult({ concurrencyCap: 3 }));
        assert.isTrue((yield* factory.service.status(manager.id)).capacityFree);

        yield* factory.service.updateConfig({ scope: "environment", config: FACTORY });
        assert.isFalse((yield* factory.service.status(manager.id)).capacityFree);
      }),
    ),
  );

  it.effect("pushes a new environment cap to the managers feed", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        yield* settledManager(factory);
        const caps: Array<number | undefined> = [];
        const subscribed = yield* Deferred.make<void>();
        const fiber = yield* factory.service.subscribeManagers({}).pipe(
          Stream.take(2),
          Stream.runForEach((event) =>
            Effect.sync(() => caps.push(event.environmentConcurrencyCap)).pipe(
              Effect.andThen(Deferred.succeed(subscribed, undefined)),
            ),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(subscribed);
        yield* factory.service.updateConfig({
          scope: "environment",
          config: { ...FACTORY, concurrencyCap: 3 },
        });
        yield* Fiber.join(fiber);
        assert.deepStrictEqual(caps, [FACTORY.concurrencyCap, 3]);
      }),
    ),
  );

  it.effect("lowering the cap below the running count cancels nothing and blocks new starts", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { manager } = yield* settledManager(factory, [1, 2, 3]);
        yield* factory.service.updateConfig({
          scope: "environment",
          config: { ...FACTORY, concurrencyCap: 3 },
        });
        yield* update(factory, manager.id, withResult({ concurrencyCap: 2 }));
        yield* startTicket(factory, manager.threadId!, 1);
        yield* startTicket(factory, manager.threadId!, 2);

        yield* update(factory, manager.id, withResult({ concurrencyCap: 1 }));
        const status = yield* factory.service.status(manager.id);
        assert.deepStrictEqual(
          status.assignments.map((assignment) => assignment.state),
          ["active", "active"],
        );
        assert.isFalse(status.capacityFree);
        const blocked = yield* startTicket(factory, manager.threadId!, 3).pipe(Effect.flip);
        assert.strictEqual(blocked.reason, "conflict");
      }),
    ),
  );

  it.effect("turning pickup on waits for the user's start, and off returns to active", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        factory.boards.push(board([{ number: 1, columnId: READY }]));
        const off = withResult({ pickup: { ...RESULT.pickup, enabled: false } });
        const manager = yield* activeManager(factory, off);
        assert.strictEqual(manager.state, "active");

        const on = yield* update(factory, manager.id, RESULT);
        assert.strictEqual(on.state, "ready");
        assert.deepStrictEqual((yield* factory.service.status(manager.id)).readyTickets, []);
        const started = yield* factory.service.startPickup({
          requestId: "start-again",
          managerId: manager.id,
        });
        assert.strictEqual(started.state, "active");

        assert.strictEqual((yield* update(factory, manager.id, off)).state, "active");
        yield* update(factory, manager.id, RESULT);
        assert.strictEqual((yield* update(factory, manager.id, off)).state, "active");
      }),
    ),
  );

  it.effect("keeps a paused manager paused, and resumes it to what its new pickup says", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        factory.boards.push(board([{ number: 1, columnId: READY }]));
        const off = withResult({ pickup: { ...RESULT.pickup, enabled: false } });
        const manager = yield* activeManager(factory, off);
        const pause = (requestId: string) =>
          factory.service.pauseManager({ requestId, managerId: manager.id, scope: "manager" });
        const resume = (requestId: string) =>
          factory.service.resumeManager({ requestId, managerId: manager.id });

        yield* pause("pause-1");
        assert.strictEqual((yield* update(factory, manager.id, RESULT)).state, "manager-paused");
        assert.strictEqual((yield* resume("resume-1")).state, "ready");

        yield* pause("pause-2");
        assert.strictEqual((yield* update(factory, manager.id, off)).state, "manager-paused");
        assert.strictEqual((yield* resume("resume-2")).state, "active");
      }),
    ),
  );

  it.effect("holds a paused manager's settings wake until it resumes", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { manager, sentBefore } = yield* settledManager(factory);
        yield* factory.service.pauseManager({
          requestId: "pause-1",
          managerId: manager.id,
          scope: "manager",
        });
        yield* update(factory, manager.id, withResult({ concurrencyCap: 3 }));
        yield* factory.service.sweep;
        assert.strictEqual(factory.sentMessages.length, sentBefore);

        yield* factory.service.resumeManager({ requestId: "resume-1", managerId: manager.id });
        yield* factory.service.sweep;
        assert.deepStrictEqual(
          factory.sentMessages.slice(sentBefore).map((message) => message.text),
          [
            [
              "The user changed your settings:",
              "- concurrency cap: 1 → 3",
              "Use them from now on.",
            ].join("\n"),
          ],
        );
      }),
    ),
  );
});

describe("FactoryService manager settings, saved over time", () => {
  it.effect(
    "lets managers that already overlap change the rest, but not keep overlapping pickup",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const factory = yield* makeFactory;
          yield* settledManager(factory);
          const bea = yield* secondManager(
            factory,
            withResult({ pickup: { ...RESULT.pickup, enabled: false } }),
          );
          // Saved before the overlap check existed: both pick up from Ready with any label.
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE factory_managers SET onboarding_result_json=${JSON.stringify(RESULT)}
            WHERE id=${bea.id}`;

          const capped = yield* update(factory, bea.id, withResult({ concurrencyCap: 2 }));
          assert.strictEqual(capped.onboardingResult!.concurrencyCap, 2);
          const relabelled = yield* update(
            factory,
            bea.id,
            withResult({ pickup: { ...RESULT.pickup, labels: ["bug"] }, concurrencyCap: 2 }),
          ).pipe(Effect.flip);
          assert.deepStrictEqual([relabelled.reason, relabelled.message], ["invalid", OVERLAP]);
        }),
      ),
  );

  it.effect("refuses a save made from settings that changed since they were opened", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { manager } = yield* settledManager(factory);
        const opened = yield* openedAt(factory, manager.id);
        yield* TestClock.adjust("1 minute");
        yield* update(factory, manager.id, withResult({ concurrencyCap: 2 }));

        const stale = yield* factory.service
          .updateSettings({
            requestId: "stale",
            managerId: manager.id,
            result: withResult({ concurrencyCap: 3 }),
            expectedUpdatedAt: opened,
          })
          .pipe(Effect.flip);
        assert.deepStrictEqual(
          [stale.reason, stale.message],
          ["conflict", "These settings changed since you opened them; cancel and edit again."],
        );
        assert.strictEqual(
          (yield* factory.service.listManagers({}))[0]!.onboardingResult!.concurrencyCap,
          2,
        );
      }),
    ),
  );

  it.effect("answers a repeated request with the first result and wakes the manager once", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { manager, sentBefore } = yield* settledManager(factory);
        const input = {
          requestId: "settings-again",
          managerId: manager.id,
          result: withResult({ concurrencyCap: 2 }),
          expectedUpdatedAt: yield* openedAt(factory, manager.id),
        };
        const first = yield* factory.service.updateSettings(input);
        yield* TestClock.adjust("1 minute");
        const again = yield* factory.service.updateSettings(input);
        assert.deepStrictEqual(again, first);
        assert.strictEqual(factory.sentMessages.length, sentBefore + 1);
      }),
    ),
  );

  it.effect("finishes a committed save when the client disconnects during it", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeFactory;
        const { manager, sentBefore } = yield* settledManager(factory);
        const sending = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        factory.controls.duringSend = Deferred.succeed(sending, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        );
        const save = yield* update(factory, manager.id, withResult({ concurrencyCap: 3 })).pipe(
          Effect.forkChild,
        );
        yield* Deferred.await(sending);
        // What the RPC server does to a disconnected client's requests.
        save.interruptUnsafe();
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.await(save);

        assert.deepStrictEqual(
          factory.sentMessages.slice(sentBefore).map((message) => message.text),
          [
            [
              "The user changed your settings:",
              "- concurrency cap: 1 → 3",
              "Use them from now on.",
            ].join("\n"),
          ],
        );
      }),
    ),
  );
});
