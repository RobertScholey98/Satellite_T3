import {
  FactoryError,
  PreviewAutomationSnapshot,
  FactoryRevisionUxEvidence,
  type FactoryPreviewActionInput,
  type FactoryPreviewActionResult,
  type FactoryPreviewFinishInput,
  type ThreadId,
  isFactoryError,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";
import * as ServerBrowser from "../preview/ServerBrowser.ts";
import * as FactoryStore from "./FactoryStore.ts";
import * as FactoryControlAccess from "./FactoryControlAccess.ts";
import { factoryAuxiliaryIsCurrent } from "./FactoryAuxiliary.ts";
import * as FactoryPreviewExecution from "./FactoryPreviewExecution.ts";

// One journal per preview instance under `preview-evidence/sessions`. An entry is written as
// `started` before the browser acts and settled only after its receipt file is written, so a
// crash leaves a `started` entry that blocks the instance rather than a silently lost action.
const Entry = Schema.Struct({
  sequence: Schema.Number,
  commandId: Schema.String,
  requestDigest: Schema.String,
  journey: Schema.String,
  action: Schema.String,
  status: Schema.Literals(["started", "succeeded", "failed"]),
  receiptDigest: Schema.optionalKey(Schema.String),
});
const Journal = Schema.Struct({
  instanceId: Schema.String,
  candidateDigest: Schema.String,
  reviewThreadId: Schema.String,
  entries: Schema.Array(Entry),
});
const Receipt = Schema.Struct({
  sequence: Schema.Number,
  requestDigest: Schema.String,
  input: Schema.Unknown,
  result: Schema.Unknown,
  error: Schema.optionalKey(Schema.String),
  screenshot: Schema.optionalKey(Schema.Struct({ digest: Schema.String, fileName: Schema.String })),
  recordedAt: Schema.String,
});
const Bundle = Schema.Struct({
  evidence: Schema.Unknown,
  journal: Journal,
  artifacts: Schema.Array(
    Schema.Struct({ path: Schema.String, digest: Schema.String, label: Schema.String }),
  ),
});
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJournal = Schema.decodeUnknownEffect(Schema.fromJsonString(Journal));
const decodeReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(Receipt));
const decodeBundle = Schema.decodeUnknownEffect(Schema.fromJsonString(Bundle));
const decodeSnapshot = Schema.decodeUnknownEffect(PreviewAutomationSnapshot);
const decodeEvidence = Schema.decodeUnknownEffect(FactoryRevisionUxEvidence);
const decodeFinish = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ requestDigest: Schema.String, operationsDigest: Schema.String }),
  ),
);
const unavailable = (detail: string) => new FactoryError({ code: "execution-unavailable", detail });
const preserve = (cause: unknown) =>
  isFactoryError(cause) ? cause : new FactoryError({ code: "persistence", cause });

/**
 * Records what the delivery reviewer did in a candidate preview and seals it as UX evidence.
 * Only the current delivery-review thread may act, and only on a ready instance built from the
 * candidate it was asked to review. Every action and screenshot is journaled with a digest, so
 * sealed evidence can be re-verified on every read. `FactoryPreviewService` drives it; the
 * evidence HTTP route and screenshot publication read sealed bundles.
 */
export class FactoryPreviewEvidence extends Context.Service<
  FactoryPreviewEvidence,
  {
    /** Closes the restricted browser session for one preview instance. */
    readonly close: (instanceId: string) => Effect.Effect<void, FactoryError>;
    readonly shutdownAll: () => Effect.Effect<void, FactoryError>;
    /**
     * Runs one browser action against the preview and journals it. Idempotent by `commandId`:
     * a repeat returns the recorded result, and a different request under the same id is a
     * conflict. An action whose outcome was never recorded blocks the instance; the reviewer
     * needs a fresh preview instance. Navigation stays on the preview's origin.
     */
    readonly invoke: (
      input: FactoryPreviewActionInput & { readonly threadId: ThreadId },
    ) => Effect.Effect<FactoryPreviewActionResult, FactoryError>;
    /**
     * Seals the journal as evidence for the named journeys. Each journey needs, in order, a
     * navigation, a snapshot, an interaction and a resulting screenshot. Idempotent by
     * `commandId`; the sealed bundle is keyed by its operations digest.
     */
    readonly finish: (
      input: FactoryPreviewFinishInput & { readonly threadId: ThreadId },
    ) => Effect.Effect<FactoryRevisionUxEvidence, FactoryError>;
    /**
     * Loads a sealed bundle and re-checks every receipt and screenshot digest. Fails if anything
     * on disk changed since sealing.
     */
    readonly read: (operationsDigest: string) => Effect.Effect<
      {
        readonly evidence: FactoryRevisionUxEvidence;
        readonly artifacts: ReadonlyArray<{
          readonly path: string;
          readonly digest: string;
          readonly label: string;
        }>;
      },
      FactoryError
    >;
  }
>()("t3/factory/FactoryPreviewEvidence") {}

export const layer = Layer.effect(
  FactoryPreviewEvidence,
  Effect.gen(function* () {
    const store = yield* FactoryStore.FactoryStore;
    const runtime = yield* FactoryPreviewExecution.FactoryPreviewExecution;
    const controls = yield* FactoryControlAccess.FactoryControlAccess;
    const browser = yield* ServerBrowser.ServerBrowser;
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const locks = new Map<string, Semaphore.Semaphore>();
    const root = path.join(config.stateDir, "factory", "preview-evidence");
    const digest = (value: Uint8Array | string) =>
      crypto
        .digest("SHA-256", typeof value === "string" ? Buffer.from(value) : value)
        .pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex")));
    const atomic = (target: string, value: unknown) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        const temporary = `${target}.${yield* crypto.randomUUIDv4}`;
        yield* fs.writeFileString(temporary, json(value), { flag: "wx" });
        yield* fs
          .rename(temporary, target)
          .pipe(Effect.ensuring(fs.remove(temporary).pipe(Effect.ignore)));
      });
    const lock = (instanceId: string) =>
      Effect.sync(() => {
        const existing = locks.get(instanceId);
        if (existing) return existing;
        const created = Semaphore.makeUnsafe(1);
        locks.set(instanceId, created);
        return created;
      });
    const admitted = Effect.fn(function* (instanceId: string, threadId: ThreadId) {
      yield* controls.assertExecution(threadId);
      const state = yield* store.snapshot;
      const auxiliary = state.auxiliaryThreads.find((entry) => entry.threadId === threadId);
      const assignment = state.assignments.find((entry) => entry.id === auxiliary?.assignmentId);
      if (
        !auxiliary ||
        auxiliary.kind !== "delivery-review" ||
        !factoryAuxiliaryIsCurrent(assignment, auxiliary)
      )
        return yield* new FactoryError({
          code: "permission-denied",
          detail:
            "Only the current independent delivery reviewer can operate this candidate preview.",
        });
      const instance = yield* runtime.get(instanceId);
      if (
        instance.status !== "ready" ||
        !instance.origin ||
        instance.reviewThreadId !== threadId ||
        instance.assignmentId !== assignment?.id ||
        instance.revisionId !== auxiliary.revisionId ||
        instance.candidateDigest !== auxiliary.sourceDigest
      )
        return yield* unavailable("The approved candidate preview is not ready for this reviewer.");
      return instance;
    });
    const directoryFor = (instanceId: string) =>
      digest(instanceId).pipe(Effect.map((key) => path.join(root, "sessions", key)));
    const load = Effect.fn(function* (instance: {
      readonly id: string;
      readonly candidateDigest: string;
      readonly reviewThreadId: ThreadId;
    }) {
      const directory = yield* directoryFor(instance.id);
      const file = path.join(directory, "journal.json");
      const journal = (yield* fs.exists(file))
        ? yield* fs.readFileString(file).pipe(Effect.flatMap(decodeJournal))
        : {
            instanceId: instance.id,
            candidateDigest: instance.candidateDigest,
            reviewThreadId: instance.reviewThreadId,
            entries: [],
          };
      if (
        journal.instanceId !== instance.id ||
        journal.candidateDigest !== instance.candidateDigest ||
        journal.reviewThreadId !== instance.reviewThreadId
      )
        return yield* unavailable(
          "The preview journal belongs to a different candidate or reviewer.",
        );
      return { directory, file, journal };
    });
    const receipt = Effect.fn(function* (directory: string, entry: typeof Entry.Type) {
      const bytes = yield* fs.readFileString(path.join(directory, `${entry.sequence}.json`));
      if ((yield* digest(bytes)) !== entry.receiptDigest)
        return yield* unavailable("Preview evidence no longer matches its recorded digest.");
      const value = yield* decodeReceipt(bytes);
      if (value.sequence !== entry.sequence || value.requestDigest !== entry.requestDigest)
        return yield* unavailable("Preview receipt identity changed.");
      return value;
    });
    const nativeResultFrom = Effect.fn(function* (
      directory: string,
      recorded: typeof Receipt.Type,
    ) {
      if (!recorded.screenshot) return recorded.result;
      if (
        typeof recorded.result !== "object" ||
        recorded.result === null ||
        !("screenshot" in recorded.result) ||
        typeof recorded.result.screenshot !== "object" ||
        recorded.result.screenshot === null
      )
        return yield* unavailable("The recorded native screenshot is incomplete.");
      const bytes = yield* fs.readFile(path.join(directory, recorded.screenshot.fileName));
      if ((yield* digest(bytes)) !== recorded.screenshot.digest)
        return yield* unavailable("The recorded native screenshot changed.");
      return yield* decodeSnapshot({
        ...recorded.result,
        screenshot: { ...recorded.result.screenshot, data: Buffer.from(bytes).toString("base64") },
      });
    });
    const invoke = Effect.fn("FactoryPreviewEvidence.invoke")(function* (
      input: FactoryPreviewActionInput & { readonly threadId: ThreadId },
    ) {
      const mutex = yield* lock(input.instanceId);
      return yield* mutex.withPermit(
        Effect.gen(function* () {
          const instance = yield* admitted(input.instanceId, input.threadId);
          const { directory, file, journal } = yield* load(instance);
          const requestDigest = yield* digest(stableStringify(input));
          const existing = journal.entries.find((entry) => entry.commandId === input.commandId);
          if (existing) {
            if (existing.requestDigest !== requestDigest)
              return yield* new FactoryError({ code: "command-conflict" });
            if (existing.status === "started")
              return yield* unavailable(
                "This browser action has an uncertain result. Open a fresh preview instance before repeating the journey.",
              );
            const prior = yield* receipt(directory, existing);
            if (prior.error) return yield* unavailable(prior.error);
            return {
              sequence: existing.sequence,
              receiptDigest: existing.receiptDigest!,
              result: yield* nativeResultFrom(directory, prior),
            };
          }
          if (
            journal.entries.length >= 500 ||
            journal.entries.some((entry) => entry.status === "started")
          )
            return yield* unavailable(
              "Start a fresh preview instance to continue this verification.",
            );
          if (!input.journey.trim() || input.journey.length > 200)
            return yield* unavailable("Use a short journey label for each recorded action.");
          const action = input.action;
          let operationInput: unknown =
            action.type === "snapshot" ? {} : action.type === "navigate" ? undefined : action.input;
          if (action.type === "navigate") {
            if (
              !action.path.startsWith("/") ||
              action.path.startsWith("//") ||
              action.path.includes("\\")
            )
              return yield* new FactoryError({
                code: "permission-denied",
                detail: "Navigate with a path on the approved app, beginning with one slash.",
              });
            const url = new URL(action.path, instance.origin);
            if (url.origin !== instance.origin)
              return yield* new FactoryError({ code: "permission-denied" });
            operationInput = { url: url.href };
          }
          const entry: typeof Entry.Type = {
            sequence: journal.entries.length,
            commandId: input.commandId,
            requestDigest,
            journey: input.journey,
            action: action.type,
            status: "started",
          };
          const pending = { ...journal, entries: [...journal.entries, entry] };
          yield* atomic(file, pending);
          const result = yield* browser
            .invokeRestricted({
              sessionId: instance.id,
              threadId: input.threadId,
              origin: instance.origin!,
              operation: action.type,
              input: operationInput,
            })
            .pipe(Effect.result);
          let nativeResult: unknown = result._tag === "Success" ? result.success : null;
          let screenshot: (typeof Receipt.Type)["screenshot"];
          if (result._tag === "Success" && action.type === "snapshot") {
            const snapshot = yield* decodeSnapshot(nativeResult);
            if (new URL(snapshot.url).origin !== instance.origin)
              return yield* unavailable("The snapshot left the approved app instance.");
            const bytes = Buffer.from(snapshot.screenshot.data, "base64");
            if (
              bytes.length > 16_000_000 ||
              !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            )
              return yield* unavailable(
                "The native browser did not return a bounded PNG screenshot.",
              );
            const fileName = `${entry.sequence}.png`;
            yield* fs.writeFile(path.join(directory, fileName), bytes, { flag: "wx" });
            screenshot = { digest: yield* digest(bytes), fileName };
            nativeResult = {
              ...snapshot,
              screenshot: {
                ...snapshot.screenshot,
                data: undefined,
                digest: screenshot.digest,
                fileName,
              },
            };
          }
          const record: typeof Receipt.Type = {
            sequence: entry.sequence,
            requestDigest,
            input: operationInput,
            result: nativeResult,
            ...(screenshot ? { screenshot } : {}),
            ...(result._tag === "Failure"
              ? {
                  error:
                    "The candidate browser action failed. Inspect the app state before retrying with a new command.",
                }
              : {}),
            recordedAt: DateTime.formatIso(yield* DateTime.now),
          };
          const bytes = json(record);
          const receiptDigest = yield* digest(bytes);
          yield* fs.writeFileString(path.join(directory, `${entry.sequence}.json`), bytes, {
            flag: "wx",
          });
          yield* atomic(file, {
            ...pending,
            entries: [
              ...journal.entries,
              {
                ...entry,
                status: result._tag === "Success" ? "succeeded" : "failed",
                receiptDigest,
              },
            ],
          });
          // The reviewer may have lost its authority while the browser acted; the action stays
          // journaled, but its result is not returned.
          yield* admitted(input.instanceId, input.threadId);
          if (record.error) return yield* unavailable(record.error);
          return {
            sequence: entry.sequence,
            receiptDigest,
            result: result._tag === "Success" ? result.success : null,
          };
        }),
      );
    }, Effect.mapError(preserve));
    const finish = Effect.fn("FactoryPreviewEvidence.finish")(function* (
      input: FactoryPreviewFinishInput & { readonly threadId: ThreadId },
    ) {
      const mutex = yield* lock(input.instanceId);
      return yield* mutex.withPermit(
        Effect.gen(function* () {
          const instance = yield* admitted(input.instanceId, input.threadId);
          const { directory, journal } = yield* load(instance);
          const finishPath = path.join(directory, `finish-${yield* digest(input.commandId)}.json`);
          const finishRequestDigest = yield* digest(stableStringify(input));
          if (yield* fs.exists(finishPath)) {
            const saved = yield* fs.readFileString(finishPath).pipe(Effect.flatMap(decodeFinish));
            if (saved.requestDigest !== finishRequestDigest)
              return yield* new FactoryError({ code: "command-conflict" });
            return (yield* read(saved.operationsDigest)).evidence;
          }
          const journeys = [...new Set(input.journeys)];
          if (
            !journeys.length ||
            journeys.length > 20 ||
            journal.entries.some((entry) => entry.status === "started")
          )
            return yield* unavailable(
              "Complete and label the required journeys before finishing verification.",
            );
          const artifacts: Array<{ path: string; digest: string; label: string }> = [];
          for (const journey of journeys) {
            const entries = journal.entries.filter(
              (entry) => entry.journey === journey && entry.status === "succeeded",
            );
            const navigated = entries.findIndex((entry) => entry.action === "navigate");
            const inspected = entries.findIndex(
              (entry, index) => index > navigated && entry.action === "snapshot",
            );
            const interacted = entries.findIndex(
              (entry, index) =>
                index > inspected &&
                ["click", "type", "press", "select", "scroll"].includes(entry.action),
            );
            const captured = entries.findLast(
              (entry, index) => index > interacted && entry.action === "snapshot",
            );
            if (navigated < 0 || inspected < 0 || interacted < 0 || !captured)
              return yield* unavailable(
                `Journey '${journey}' needs navigation, inspection, an interaction, and a resulting screenshot.`,
              );
            const recorded = yield* receipt(directory, captured);
            if (!recorded.screenshot)
              return yield* unavailable("The journey has no native screenshot.");
            const imagePath = path.join(directory, recorded.screenshot.fileName);
            if ((yield* digest(yield* fs.readFile(imagePath))) !== recorded.screenshot.digest)
              return yield* unavailable("The captured screenshot changed after verification.");
            artifacts.push({ path: imagePath, digest: recorded.screenshot.digest, label: journey });
          }
          for (const entry of journal.entries)
            if (entry.status !== "started") yield* receipt(directory, entry);
          // The digest covers the whole journal, not only the chosen journeys, so `read` can
          // rebuild it from the bundle alone.
          const operationsDigest = yield* digest(stableStringify({ journal, journeys }));
          const evidence: FactoryRevisionUxEvidence = {
            instanceId: instance.id,
            candidateDigest: instance.candidateDigest,
            reviewThreadId: input.threadId,
            operationsDigest,
            screenshots: artifacts.map((artifact, index) => ({
              label: artifact.label,
              location: `factory-preview:${operationsDigest}/screenshot/${index}`,
            })),
            journeys: journeys.map((label) => ({
              label,
              location: `factory-preview:${operationsDigest}/journal`,
            })),
            observedAt: DateTime.formatIso(yield* DateTime.now),
          };
          const target = path.join(root, "bundles", `${operationsDigest}.json`);
          if (!(yield* fs.exists(target))) yield* atomic(target, { evidence, journal, artifacts });
          const sealed = yield* read(operationsDigest);
          yield* admitted(input.instanceId, input.threadId);
          yield* atomic(finishPath, { requestDigest: finishRequestDigest, operationsDigest });
          return sealed.evidence;
        }),
      );
    }, Effect.mapError(preserve));
    const read = Effect.fn("FactoryPreviewEvidence.read")(function* (operationsDigest: string) {
      if (!/^[a-f0-9]{64}$/.test(operationsDigest))
        return yield* unavailable("Invalid preview evidence identity.");
      const bundle = yield* fs
        .readFileString(path.join(root, "bundles", `${operationsDigest}.json`))
        .pipe(Effect.flatMap(decodeBundle));
      const evidence = yield* decodeEvidence(bundle.evidence);
      if (
        evidence.operationsDigest !== operationsDigest ||
        evidence.instanceId !== bundle.journal.instanceId ||
        evidence.candidateDigest !== bundle.journal.candidateDigest ||
        evidence.reviewThreadId !== bundle.journal.reviewThreadId ||
        (yield* digest(
          stableStringify({
            journal: bundle.journal,
            journeys: evidence.journeys.map((entry) => entry.label),
          }),
        )) !== operationsDigest
      )
        return yield* unavailable("The sealed preview evidence identity changed.");
      const directory = yield* directoryFor(bundle.journal.instanceId);
      const captured = yield* Effect.forEach(bundle.journal.entries, (entry) =>
        receipt(directory, entry).pipe(Effect.map((recorded) => ({ entry, recorded }))),
      );
      for (const artifact of bundle.artifacts) {
        const resolved = path.resolve(artifact.path);
        if (
          !resolved.startsWith(`${path.resolve(root)}${path.sep}`) ||
          !captured.some(
            ({ entry, recorded }) =>
              entry.journey === artifact.label &&
              recorded.screenshot?.digest === artifact.digest &&
              path.resolve(directory, recorded.screenshot.fileName) === resolved,
          ) ||
          (yield* digest(yield* fs.readFile(resolved))) !== artifact.digest
        )
          return yield* unavailable("The sealed screenshot changed.");
      }
      return { evidence, artifacts: bundle.artifacts };
    }, Effect.mapError(preserve));
    return FactoryPreviewEvidence.of({
      invoke,
      finish,
      read,
      close: (instanceId) => browser.closeRestricted(instanceId).pipe(Effect.mapError(preserve)),
      shutdownAll: () => browser.closeAllRestricted().pipe(Effect.mapError(preserve)),
    });
  }),
);
