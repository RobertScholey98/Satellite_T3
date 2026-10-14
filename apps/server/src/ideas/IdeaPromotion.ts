import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { forkParked } from "../serverActivation.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  CommandId,
  type IdeaIssueDraft,
  type IdeaPromotion as Promotion,
  type ThreadId,
} from "@t3tools/contracts";
import { OrchestrationEngineService } from "../orchestration-v2/SatelliteOrchestration.ts";
import { IssueHost, repositoryIssueScope } from "../issues/IssueHost.ts";
import type { IssueHostScope, PublishedIssue } from "../issues/IssueHostAdapter.ts";
import { IdeaNotebookStore } from "./IdeaNotebookStore.ts";
import { IdeaRuntime, IdeaRuntimeError } from "./IdeaRuntime.ts";
import { readIdeaExecution, withIdeaLock } from "./IdeaExecution.ts";

const error = (message: string) => new IdeaRuntimeError({ message });
const mapError = (e: { readonly message: string }) => error(e.message);
const duplicates = () =>
  error(
    "More than one issue matches this publication attempt. Resolve the duplicates before retrying.",
  );

export function validateIdeaIssueDrafts(drafts: readonly IdeaIssueDraft[]): string | null {
  if (drafts.length === 0 || drafts.length > 30)
    return "Propose between 1 and 30 issues at a time.";
  if (new Set(drafts.map((d) => d.id)).size !== drafts.length)
    return "Each issue draft needs a unique identity.";
  for (const draft of drafts) {
    if (!draft.title.trim() || !draft.body.trim())
      return "Every issue needs a title and implementation details.";
    if (
      /(?:idea-entry:|t3-context:|file:\/\/|\/api\/ideas\/|[A-Za-z]:[\\/]|\.t3[\\/]userdata[\\/]ideas)/i.test(
        draft.body,
      )
    )
      return "Issue bodies must contain the implementation information and cannot depend on local idea files or links.";
  }
  return null;
}

export class IdeaPromotion extends Context.Service<
  IdeaPromotion,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
    readonly cancel: (threadId: ThreadId) => Effect.Effect<void>;
    readonly propose: (input: {
      threadId: ThreadId;
      drafts: readonly IdeaIssueDraft[];
      remainingScope: string;
    }) => Effect.Effect<Promotion, IdeaRuntimeError>;
    readonly publish: (threadId: ThreadId) => Effect.Effect<Promotion, IdeaRuntimeError>;
  }
>()("t3/ideas/IdeaPromotion") {
  static readonly layer = Layer.effect(
    IdeaPromotion,
    Effect.gen(function* () {
      const store = yield* IdeaNotebookStore;
      const runtime = yield* IdeaRuntime;
      const engine = yield* OrchestrationEngineService;
      const crypto = yield* Crypto.Crypto;
      const hosts = yield* IssueHost;
      const repositories = yield* RepositoryIdentityResolver;
      const save = Effect.fn("IdeaPromotion.save")(function* (
        threadId: ThreadId,
        promotion: Promotion,
        kind: "promotion.propose" | "promotion.record",
      ) {
        const notebook = yield* store.requireActive(threadId).pipe(Effect.mapError(mapError));
        yield* engine
          .dispatch({
            type: "idea.apply",
            threadId,
            commandId: CommandId.make(yield* crypto.randomUUIDv4.pipe(Effect.mapError(mapError))),
            deletionEpoch: notebook.deletionEpoch,
            mutation: { kind, promotion },
          })
          .pipe(Effect.mapError(mapError));
      });
      const destination = (cwd: string, promotion: Promotion) => {
        const adapter = hosts.forHost(promotion.target.hostKind);
        const publication = adapter?.publication;
        if (!adapter || !publication)
          return Effect.fail(error("The approved issue destination is unsupported."));
        const { hostKind, host, repository } = promotion.target;
        const scope: IssueHostScope = {
          cwd,
          ref: {
            hostKind,
            host,
            repository,
            id: "0",
            number: 0,
            url: `https://${host}/${repository}`,
          },
        };
        return Effect.succeed({ adapter, publication, scope });
      };
      const markerFor = (promotionId: string, draftId: string) =>
        crypto.digest("SHA-256", new TextEncoder().encode(promotionId + ":" + draftId)).pipe(
          Effect.mapError(mapError),
          Effect.map((bytes) => "<!-- t3-promotion:" + Buffer.from(bytes).toString("hex") + " -->"),
        );
      const readPublicationIssues = Effect.fn("IdeaPromotion.readPublicationIssues")(function* (
        cwd: string,
        promotion: Promotion,
      ) {
        const { publication, scope } = yield* destination(cwd, promotion);
        const markers = yield* Effect.forEach(promotion.drafts, (draft) =>
          markerFor(promotion.id, draft.id),
        );
        const found = yield* publication
          .findByMarker(scope, markers)
          .pipe(Effect.mapError(mapError));
        if (found.length > promotion.drafts.length) return yield* duplicates();
        return found;
      });
      const reconcile = Effect.fn("IdeaPromotion.reconcile")(function* (
        cwd: string,
        promotion: Promotion,
      ) {
        const existing = yield* readPublicationIssues(cwd, promotion);
        const issues = [...promotion.issues];
        for (const draft of promotion.drafts) {
          if (issues.some((issue) => issue.draftId === draft.id)) continue;
          const marker = yield* markerFor(promotion.id, draft.id);
          const matches = existing.filter((issue) => issue.body.includes(marker));
          if (matches.length > 1) return yield* duplicates();
          const found = matches[0];
          if (found)
            issues.push({
              draftId: draft.id,
              url: found.url,
              number: found.number,
              title: found.title,
              publishedAt: DateTime.formatIso(yield* DateTime.now),
            });
        }
        return { ...promotion, issues };
      });
      const propose = Effect.fn("IdeaPromotion.propose")(function* (input: {
        threadId: ThreadId;
        drafts: readonly IdeaIssueDraft[];
        remainingScope: string;
      }) {
        const notebook = yield* store.requireActive(input.threadId).pipe(Effect.mapError(mapError));
        const invalid = validateIdeaIssueDrafts(input.drafts);
        if (invalid) return yield* error(invalid);
        if (notebook.update.status !== "current")
          return yield* error("Wait for the notebook update before proposing issues.");

        const execution =
          readIdeaExecution(input.threadId) ?? (yield* runtime.prepare(input.threadId));
        const previous = notebook.promotion;
        if (
          previous &&
          ["approved", "publishing", "partial"].includes(previous.status) &&
          previous.drafts.some(
            (draft) => !previous.issues.some((issue) => issue.draftId === draft.id),
          )
        ) {
          if (previous.sourceRevision === notebook.contentRevision)
            return yield* error(
              "Finish or retry the existing promotion before proposing another breakdown.",
            );
          yield* withIdeaLock(
            input.threadId,
            Effect.gen(function* () {
              const reconciled = yield* reconcile(execution.projectDirectory, previous);
              yield* save(
                input.threadId,
                {
                  ...reconciled,
                  status: "failed",
                  error:
                    "The idea changed. Unpublished draft intents were superseded after checking the destination for earlier outcomes.",
                },
                "promotion.record",
              );
            }),
          );
        }
        const repository = yield* repositories.resolve(execution.projectDirectory, {
          refresh: true,
        });
        const unsupported = error(
          "Idea promotion currently supports GitHub project repositories. Configure the project's tracked remote before proposing issues.",
        );
        const { ref } = yield* repositoryIssueScope(execution.projectDirectory, repository).pipe(
          Effect.mapError(() => unsupported),
        );
        if (!hosts.forHost(ref.hostKind)?.publication) return yield* unsupported;
        const current = yield* store.requireActive(input.threadId).pipe(Effect.mapError(mapError));
        for (const history of [
          ...current.promotionHistory,
          ...(current.promotion ? [current.promotion] : []),
        ]) {
          if (
            input.drafts.some((draft) =>
              history.drafts.some(
                (prior) =>
                  prior.title === draft.title &&
                  prior.body === draft.body &&
                  history.issues.some((issue) => issue.draftId === prior.id),
              ),
            )
          )
            return yield* error(
              "This breakdown repeats an issue already published from the idea. Propose only the remaining scope.",
            );
        }
        const promotion = {
          id: yield* crypto.randomUUIDv4.pipe(Effect.mapError(mapError)),
          target: { hostKind: ref.hostKind, host: ref.host, repository: ref.repository },
          sourceRevision: notebook.contentRevision,
          status: "review",
          drafts: input.drafts,
          issues: [],
          remainingScope: input.remainingScope,
          error: null,
        } satisfies Promotion;
        yield* save(input.threadId, promotion, "promotion.propose");
        return promotion;
      });
      const publish = Effect.fn("IdeaPromotion.publish")(function* (threadId: ThreadId) {
        const execution = readIdeaExecution(threadId) ?? (yield* runtime.prepare(threadId));
        return yield* withIdeaLock(
          threadId,
          Effect.gen(function* () {
            const notebook = yield* store.requireActive(threadId).pipe(Effect.mapError(mapError));
            let promotion: Promotion | null = notebook.promotion;
            if (!promotion || !["approved", "partial", "publishing"].includes(promotion.status))
              return yield* error(
                "The user must approve the proposed issue breakdown in T3 before publication.",
              );
            const { adapter, publication, scope } = yield* destination(
              execution.projectDirectory,
              promotion,
            );
            const known = yield* readPublicationIssues(execution.projectDirectory, promotion);
            promotion = { ...promotion, status: "publishing", error: null };
            yield* save(threadId, promotion, "promotion.record");
            for (const draft of promotion.drafts) {
              const recorded: Promotion["issues"][number] | undefined = promotion.issues.find(
                (issue) => issue.draftId === draft.id,
              );
              const marker = yield* markerFor(promotion.id, draft.id);
              const found = known.filter((issue) => issue.body.includes(marker));
              if (found.length > 1) return yield* duplicates();
              if (!recorded && !found[0]) {
                const current = yield* store
                  .requireActive(threadId)
                  .pipe(Effect.mapError(mapError));
                if (
                  current.contentRevision !== promotion.sourceRevision ||
                  current.update.status !== "current"
                )
                  return yield* error(
                    "The idea changed after approval. Published issues have been preserved. Review a fresh breakdown before creating more issues.",
                  );
              }
              const published: Pick<PublishedIssue, "number" | "url"> =
                recorded ??
                found[0] ??
                (yield* publication
                  .create(scope, {
                    title: draft.title,
                    body: `${draft.body}\n\n${marker}`,
                    labels: draft.labels,
                  })
                  .pipe(Effect.mapError(mapError)));
              const verified = yield* adapter
                .get({
                  ...scope,
                  ref: { ...scope.ref, id: String(published.number), number: published.number },
                })
                .pipe(Effect.mapError(mapError));
              if (verified.ref.number !== published.number || verified.ref.url !== published.url)
                return yield* error(
                  "The repository host returned an issue outside the approved publication destination.",
                );
              promotion = {
                ...promotion,
                issues: [
                  ...promotion.issues.filter((issue) => issue.draftId !== draft.id),
                  {
                    draftId: draft.id,
                    url: verified.ref.url,
                    number: verified.ref.number,
                    title: verified.title,
                    publishedAt: DateTime.formatIso(yield* DateTime.now),
                  },
                ],
              };
              yield* save(threadId, promotion, "promotion.record");
              if (verified.title !== draft.title || verified.body !== `${draft.body}\n\n${marker}`)
                return yield* error(
                  "A published issue differs from the approved title or implementation details. Its identity has been retained. Review the issue contents before retrying.",
                );
            }
            promotion = {
              ...promotion,
              status: promotion.remainingScope.trim() ? "partial" : "complete",
            };
            yield* save(threadId, promotion, "promotion.record");
            return promotion;
          }).pipe(
            Effect.tapError((failure) =>
              Effect.gen(function* () {
                const current = yield* store.get(threadId).pipe(Effect.mapError(mapError));
                if (
                  !current ||
                  current.status === "deleting" ||
                  !current.promotion ||
                  current.promotion.status !== "publishing"
                )
                  return;
                yield* save(
                  threadId,
                  { ...current.promotion, status: "partial", error: failure.message },
                  "promotion.record",
                );
              }).pipe(Effect.ignore),
            ),
          ),
        );
      });
      const cancelled = new Set<ThreadId>();
      const running = new Map<ThreadId, Fiber.Fiber<void>>();
      const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
        Effect.gen(function* () {
          if (cancelled.has(threadId)) return;
          const current = yield* store.get(threadId).pipe(Effect.orElseSucceed(() => null));
          if (
            !current ||
            current.status === "deleting" ||
            !current.promotion ||
            !["approved", "publishing"].includes(current.promotion.status)
          )
            return;
          const fiber = yield* publish(threadId).pipe(
            Effect.asVoid,
            Effect.catch((failure) =>
              Effect.gen(function* () {
                const notebook = yield* store.get(threadId);
                if (
                  notebook &&
                  notebook.status !== "deleting" &&
                  notebook.promotion?.status === "approved"
                )
                  yield* save(
                    threadId,
                    { ...notebook.promotion, status: "failed", error: failure.message },
                    "promotion.record",
                  );
              }).pipe(Effect.ignore),
            ),
            Effect.forkScoped,
          );
          running.set(threadId, fiber);
          yield* Fiber.await(fiber);
          running.delete(threadId);
        }),
      );
      const start = Effect.fn("IdeaPromotion.start")(function* () {
        const stream = yield* engine.subscribeDomainEvents;
        yield* forkParked(
          Stream.runForEach(stream, (event) =>
            event.type === "idea.changed" &&
            (event.payload.mutation.kind === "promotion.approve" ||
              event.payload.mutation.kind === "promotion.retry")
              ? worker.enqueue(event.payload.threadId)
              : Effect.void,
          ),
        );
        yield* forkParked(
          store.list().pipe(
            Effect.flatMap((ideas) =>
              Effect.forEach(ideas, (idea) => worker.enqueue(idea.threadId), { discard: true }),
            ),
            Effect.ignore,
          ),
        );
      });
      const cancel = (threadId: ThreadId) =>
        Effect.gen(function* () {
          cancelled.add(threadId);
          const fiber = running.get(threadId);
          if (fiber) yield* Fiber.interrupt(fiber);
        });
      return IdeaPromotion.of({ propose, publish, start, drain: worker.drain, cancel });
    }),
  );
}
