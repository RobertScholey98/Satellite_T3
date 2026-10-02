import { useAtomValue } from "@effect/atom-react";
import { createIssuesEnvironmentAtoms } from "@t3tools/client-runtime/issues";
import { EnvironmentId, ProjectId, type IssueBoardSync } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";

export const issuesEnvironment = createIssuesEnvironmentAtoms(connectionAtomRuntime);

interface IssueBoardRef {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly boardId: string;
}

const UNSUBSCRIBED_BOARD_SYNC = Atom.make<IssueBoardSync | null | undefined>(undefined).pipe(
  Atom.withLabel("web-issue-board-sync:none"),
);

const BOARD_KEY_SEPARATOR = "\n";
const boardSyncAtom = Atom.family((key: string) => {
  const [environmentId = "", projectId = "", boardId = ""] = key.split(BOARD_KEY_SEPARATOR);
  return Atom.make((get): IssueBoardSync | null | undefined => {
    const result = get(
      issuesEnvironment.boardSync({
        environmentId: EnvironmentId.make(environmentId),
        input: { projectId: ProjectId.make(projectId), boardId },
      }),
    );
    return Option.getOrUndefined(AsyncResult.value(result))?.sync;
  }).pipe(Atom.withLabel(`web-issue-board-sync:${key}`));
});

/**
 * The server's freshness for an open board: `undefined` until the subscription delivers (or on
 * servers that predate stored boards), `null` once the server holds no stored copy.
 */
export function useIssueBoardSync(ref: IssueBoardRef | null): IssueBoardSync | null | undefined {
  return useAtomValue(
    ref === null
      ? UNSUBSCRIBED_BOARD_SYNC
      : boardSyncAtom(
          [ref.environmentId, ref.projectId, ref.boardId].join(BOARD_KEY_SEPARATOR),
        ),
  );
}
