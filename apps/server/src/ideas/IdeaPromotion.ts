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
import * as Schema from "effect/Schema";
import {
  CommandId,
  type IdeaIssueDraft,
  type IdeaPromotion as Promotion,
  type ThreadId,
} from "@t3tools/contracts";
import { ProcessRunner } from "../processRunner.ts";
import { OrchestrationEngineService } from "../orchestration-v2/SatelliteOrchestration.ts";
import { IdeaNotebookStore } from "./IdeaNotebookStore.ts";
import { IdeaRuntime, IdeaRuntimeError } from "./IdeaRuntime.ts";
import { readIdeaExecution, withIdeaLock } from "./IdeaExecution.ts";

const Repo = Schema.Struct({
  nameWithOwner: Schema.String,
  hasIssuesEnabled: Schema.Boolean,
  isArchived: Schema.Boolean,
});
const Published = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  html_url: Schema.String,
  body: Schema.NullOr(Schema.String),
});
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeIssue = Schema.decodeUnknownEffect(Schema.fromJsonString(Published));
const decodeIssuePage = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Published)));
const error = (message: string) => new IdeaRuntimeError({ message });
const mapError = (e: { readonly message: string }) => error(e.message);

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
      const runner = yield* ProcessRunner;
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
      const runGithub = Effect.fn("IdeaPromotion.github")(function* (
        threadId: ThreadId,
        cwd: string,
        args: readonly string[],
        stdin?: string,
      ) {
        yield* store.requireActive(threadId).pipe(Effect.mapError(mapError));
        const result = yield* runner
          .run({
            command: "gh",
            args,
            cwd,
            ...(stdin === undefined ? {} : { stdin }),
            timeout: "60 seconds",
            maxOutputBytes: 8 * 1024 * 1024,
          })
          .pipe(Effect.mapError(mapError));
        if (result.stdoutTruncated)
          return yield* error(
            "GitHub returned more data than the response limit. No incomplete response was accepted. Retry after checking the repository's issue contents.",
          );
        if (result.code !== 0)
          return yield* error(
            "GitHub publication failed. Check the environment's GitHub authentication and issue access, then retry.",
          );
        return result.stdout;
      });
      const markerFor = (promotionId: string, draftId: string) =>
        crypto.digest("SHA-256", new TextEncoder().encode(promotionId + ":" + draftId)).pipe(
          Effect.mapError(mapError),
          Effect.map((bytes) => "<!-- t3-promotion:" + Buffer.from(bytes).toString("hex") + " -->"),
        );
      const readPublicationIssues = Effect.fn("IdeaPromotion.readPublicationIssues")(function* (
        threadId: ThreadId,
        cwd: string,
        promotion: Promotion,
      ) {
        const markers = yield* Effect.forEach(promotion.drafts, (draft) =>
          markerFor(promotion.id, draft.id),
        );
        const found = new Map<number, typeof Published.Type>();
        for (let page = 1; ; page++) {
          const issues = yield* runGithub(threadId, cwd, [
            "api",
            "--hostname",
            promotion.target.host,
            `repos/${promotion.target.repository}/issues?state=all&sort=created&direction=asc&per_page=25&page=${page}`,
          ]).pipe(Effect.flatMap(decodeIssuePage), Effect.mapError(mapError));
          for (const issue of issues) {
            if (!markers.some((marker) => issue.body?.includes(marker))) continue;
            found.set(issue.number, issue);
            if (found.size > promotion.drafts.length)
              return yield* error(
                "More than one issue matches this publication attempt. Resolve the duplicates before retrying.",
              );
          }
          if (issues.length < 25) return [...found.values()];
        }
      });
      const reconcile = Effect.fn("IdeaPromotion.reconcile")(function* (
        threadId: ThreadId,
        cwd: string,
        promotion: Promotion,
      ) {
        const existing = yield* readPublicationIssues(threadId, cwd, promotion);
        const issues = [...promotion.issues];
        for (const draft of promotion.drafts) {
          if (issues.some((issue) => issue.draftId === draft.id)) continue;
          const marker = yield* markerFor(promotion.id, draft.id);
          const matches = existing.filter((issue) => issue.body?.includes(marker));
          if (matches.length > 1)
            return yield* error(
              "More than one issue matches this publication attempt. Resolve the duplicates before retrying.",
            );
          const found = matches[0];
          if (found)
            issues.push({
              draftId: draft.id,
              url: found.html_url,
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
              const reconciled = yield* reconcile(
                input.threadId,
                execution.projectDirectory,
                previous,
              );
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
        const [host, owner, name, ...extra] = repository?.canonicalKey.split("/") ?? [];
        if (
          host !== "github.com" ||
          !owner ||
          !name ||
          extra.length ||
          !/^[\w.-]+$/.test(owner) ||
          !/^[\w.-]+$/.test(name)
        )
          return yield* error(
            "Idea promotion currently supports a GitHub.com project repository. Configure the project's tracked remote before proposing issues.",
          );
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
          target: { host, repository: owner + "/" + name },
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
            const gh = (args: readonly string[], stdin?: string) =>
              runGithub(threadId, execution.projectDirectory, args, stdin);
            if (
              promotion.target.host !== "github.com" ||
              !/^[\w.-]+\/[\w.-]+$/.test(promotion.target.repository)
            )
              return yield* error("The approved issue destination is unsupported.");
            const repo = yield* gh([
              "repo",
              "view",
              promotion.target.host + "/" + promotion.target.repository,
              "--json",
              "nameWithOwner,hasIssuesEnabled,isArchived",
            ]).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Repo))),
              Effect.mapError(mapError),
            );
            if (
              repo.nameWithOwner.toLowerCase() !== promotion.target.repository.toLowerCase() ||
              !repo.hasIssuesEnabled ||
              repo.isArchived ||
              !/^[\w.-]+\/[\w.-]+$/.test(repo.nameWithOwner)
            )
              return yield* error(
                "This repository cannot accept issues. Enable Issues or choose an active issue tracker before promotion.",
              );
            const endpoint = `repos/${promotion.target.repository}/issues`;
            const known = yield* readPublicationIssues(
              threadId,
              execution.projectDirectory,
              promotion,
            );
            promotion = { ...promotion, status: "publishing", error: null };
            yield* save(threadId, promotion, "promotion.record");
            for (const draft of promotion.drafts) {
              const recorded: Promotion["issues"][number] | undefined = promotion.issues.find(
                (issue) => issue.draftId === draft.id,
              );
              const marker = yield* markerFor(promotion.id, draft.id);
              const found = known.filter((issue) => issue.body?.includes(marker));
              if (found.length > 1)
                return yield* error(
                  "More than one issue matches this publication attempt. Resolve the duplicates before retrying.",
                );
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
              const published: { readonly number: number } =
                recorded ??
                found[0] ??
                (yield* gh(
                  [
                    "api",
                    "--hostname",
                    promotion.target.host,
                    "--method",
                    "POST",
                    endpoint,
                    "--input",
                    "-",
                  ],
                  yield* encodeJson({
                    title: draft.title,
                    body: `${draft.body}\n\n${marker}`,
                    labels: draft.labels,
                  }).pipe(Effect.mapError(mapError)),
                ).pipe(Effect.flatMap(decodeIssue), Effect.mapError(mapError)));
              const verified: typeof Published.Type = yield* gh([
                "api",
                "--hostname",
                promotion.target.host,
                `${endpoint}/${published.number}`,
              ]).pipe(Effect.flatMap(decodeIssue), Effect.mapError(mapError));
              if (
                verified.number !== published.number ||
                verified.html_url !==
                  `https://${promotion.target.host}/${promotion.target.repository}/issues/${published.number}`
              )
                return yield* error(
                  "GitHub returned an issue outside the approved publication destination.",
                );
              promotion = {
                ...promotion,
                issues: [
                  ...promotion.issues.filter((issue) => issue.draftId !== draft.id),
                  {
                    draftId: draft.id,
                    url: verified.html_url,
                    number: verified.number,
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
