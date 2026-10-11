import {
  CommandId,
  FactoryError,
  type FactoryInvestigationEvidence,
  type FactoryInvestigationRead,
  type FactoryRetroEvidenceRef,
  type ThreadId,
  isFactoryError,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { sha256 } from "@noble/hashes/sha2";
import * as Hex from "effect/encoding/Hex";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FactoryStore from "./FactoryStore.ts";
import * as FactoryControlAccess from "./FactoryControlAccess.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

export class FactoryImprovementEvidence extends Context.Service<
  FactoryImprovementEvidence,
  {
    readonly read: (
      managerId: ThreadId,
      input: FactoryInvestigationRead,
    ) => Effect.Effect<FactoryInvestigationEvidence, FactoryError>;
  }
>()("t3/factory/FactoryImprovementEvidence") {}
const denied = () =>
  new FactoryError({
    code: "permission-denied",
    detail:
      "Evidence must belong to a finding attached to this open investigation and its source assignment.",
  });
const sameRef = (left: FactoryRetroEvidenceRef, right: FactoryRetroEvidenceRef) =>
  stableStringify(left) === stableStringify(right);
const make = Effect.gen(function* () {
  const store = yield* FactoryStore.FactoryStore;
  const access = yield* FactoryControlAccess.FactoryControlAccess;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const crypto = yield* Crypto.Crypto;
  const read = Effect.fn("FactoryImprovementEvidence.read")(
    function* (managerId: ThreadId, input: FactoryInvestigationRead) {
      yield* access.assertExecution(managerId);
      const state = yield* store.snapshot;
      const manager = state.managers.find(
        (entry) => entry.id === managerId && entry.threadId === managerId,
      );
      const investigation = state.improvementInvestigations.find(
        (entry) => entry.id === input.investigationId,
      );
      const finding = state.findings.find((entry) => entry.id === input.findingId);
      const assignment = state.assignments.find((entry) => entry.id === finding?.assignmentId);
      const limit = input.limit ?? 8000;
      const cursor = input.cursor ?? { afterPosition: -1, offset: 0, digest: null };
      if (
        manager?.role !== "system" ||
        manager.status !== "active" ||
        manager.qualification.status !== "qualified" ||
        !investigation ||
        investigation.lifecycle.phase === "closed" ||
        !investigation.findingIds.includes(input.findingId) ||
        !finding ||
        !assignment ||
        !finding.evidence.some((ref) => sameRef(ref, input.evidenceRef)) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 16000 ||
        !Number.isInteger(cursor.offset) ||
        cursor.offset < 0 ||
        !Number.isInteger(cursor.afterPosition) ||
        cursor.afterPosition < -1
      )
        return yield* denied();
      const ref = input.evidenceRef;
      let record: unknown;
      let position = cursor.afterPosition;
      let hasMore = false;
      if ("threadId" in ref) {
        const member = yield* access.membership(ref.threadId);
        const shell = yield* threads.getThreadShell(ref.threadId);
        if (member?.assignmentId !== assignment.id || shell?.projectId !== assignment.projectId)
          return yield* denied();
        if (ref.kind === "thread") {
          const page = yield* threads.getTimelinePage(ref.threadId, {
            afterPosition: cursor.afterPosition,
            view: "activity",
            limit: 1,
          });
          const item = page.items[0];
          if (item) {
            const source = yield* access.membership(item.sourceThreadId);
            const sourceShell = yield* threads.getThreadShell(item.sourceThreadId);
            if (
              source?.assignmentId !== assignment.id ||
              sourceShell?.projectId !== assignment.projectId
            )
              return yield* denied();
            record = item;
            position = item.position;
            hasMore = page.hasMore;
          } else record = { threadId: ref.threadId, end: true };
        } else if (ref.kind === "message") {
          const records = yield* threads.getThreadRecords(ref.threadId, ["messages"], {
            messageIds: [ref.messageId],
          });
          record = records.messages.find((entry) => entry.id === ref.messageId);
        } else {
          const records = yield* threads.getThreadRecords(ref.threadId, ["runs"], {
            runIds: [ref.runId],
          });
          record = records.runs.find((entry) => entry.id === ref.runId);
        }
      } else {
        const revisions = assignment.delivery?.revisions ?? [];
        switch (ref.kind) {
          case "guidance":
            record = state.guidance.find(
              (entry) => entry.assignmentId === assignment.id && entry.messageId === ref.id,
            );
            break;
          case "dependency":
            record = state.dependencies.find(
              (entry) => entry.assignmentId === assignment.id && entry.id === ref.id,
            );
            break;
          case "delivery":
            record =
              assignment.completion?.deliveries.find((entry) => entry.id === ref.id) ??
              (assignment.oversight?.delivery?.id === ref.id
                ? assignment.oversight.delivery
                : undefined);
            break;
          case "candidate":
            record = revisions.find(
              (entry) =>
                entry.id === ref.id ||
                entry.candidateId === ref.id ||
                entry.candidateDigest === ref.id,
            );
            break;
          case "delivery-review":
            record = revisions
              .flatMap((entry) => entry.reviews)
              .find((entry) => entry.id === ref.id);
            break;
          case "verification":
            record =
              assignment.verification?.artifactId === ref.id
                ? assignment.verification
                : revisions.find((entry) => entry.verification?.artifactId === ref.id)
                    ?.verification;
            break;
        }
      }
      if (record === undefined) return yield* denied();
      const serialized = stableStringify(record);
      const digest = Hex.encode(sha256(new TextEncoder().encode(serialized)));
      if ((cursor.digest !== null && cursor.digest !== digest) || cursor.offset > serialized.length)
        return yield* new FactoryError({
          code: "invalid-state",
          detail: "Evidence changed while paging. Restart this evidence read.",
        });
      const text = serialized.slice(cursor.offset, cursor.offset + limit);
      const nextOffset = cursor.offset + text.length;
      const nextCursor =
        nextOffset < serialized.length
          ? { ...cursor, offset: nextOffset, digest }
          : hasMore
            ? { afterPosition: position, offset: 0, digest: null }
            : null;
      yield* access.assertExecution(managerId);
      yield* store.commit({
        actor: { kind: "system" },
        command: {
          type: "improvement.evidence.read",
          commandId: CommandId.make(yield* crypto.randomUUIDv4),
          managerId,
          investigationId: input.investigationId,
          findingId: input.findingId,
          evidenceRef: ref,
          digest,
          characters: text.length,
          cursor,
          limit,
        },
        now: DateTime.formatIso(yield* DateTime.now),
      });
      return {
        investigationId: input.investigationId,
        findingId: input.findingId,
        assignmentId: assignment.id,
        projectId: assignment.projectId,
        evidenceRef: ref,
        digest,
        text,
        nextCursor,
      };
    },
    Effect.mapError((cause) =>
      isFactoryError(cause) ? cause : new FactoryError({ code: "persistence", cause }),
    ),
  );
  return FactoryImprovementEvidence.of({ read });
});
export const layer = Layer.effect(FactoryImprovementEvidence, make).pipe(
  Layer.provide(FactoryControlAccess.layer),
);
