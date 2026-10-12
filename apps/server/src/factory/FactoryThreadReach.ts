import { FactoryError, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type { ThreadManagementServiceShape } from "../orchestration-v2/ThreadManagementService.ts";
import type { FactoryControlAccess } from "./FactoryControlAccess.ts";

/** Why a launch refuses a deleted thread instead of creating it again under the same id. */
export const deletedThreadDetail =
  "This thread was deleted. The factory does not recreate deleted threads; cancel or retire this work to start over.";

/**
 * Whether the thread was deleted. `getThreadShell` omits deleted threads, so a `null` shell
 * cannot tell a deleted thread from one not created yet; only the thread's records can. A factory
 * effect must never recreate a deleted thread or wait for it to come back.
 */
export const factoryThreadDeleted = (threads: ThreadManagementServiceShape, threadId: ThreadId) =>
  threads.getThreadRecords(threadId, []).pipe(
    Effect.option,
    Effect.map((records) => Option.isSome(records) && records.value.thread.deletedAt !== null),
  );

/**
 * Whether a factory effect may direct the thread now. `hold` leaves the effect pending for a later
 * pass: the thread may not be directed now, is archived (unarchiving is the way back), or does not
 * exist yet. `gone` means it was deleted and can never be reached.
 */
export const factoryThreadReach = Effect.fn("factoryThreadReach")(function* (
  threads: ThreadManagementServiceShape,
  access: FactoryControlAccess["Service"],
  threadId: ThreadId,
  senderThreadId?: ThreadId,
) {
  const shell = yield* threads
    .getThreadShell(threadId)
    .pipe(Effect.mapError((cause) => new FactoryError({ code: "persistence", cause })));
  if (shell === null)
    return (yield* factoryThreadDeleted(threads, threadId)) ? ("gone" as const) : ("hold" as const);
  const result = yield* access
    .assertDirection({ threadId, senderThreadId: senderThreadId ?? null })
    .pipe(Effect.result);
  if (Result.isFailure(result)) {
    if (result.failure.code === "permission-denied") return "hold" as const;
    return yield* result.failure;
  }
  return shell.archivedAt === null ? ("send" as const) : ("hold" as const);
});
