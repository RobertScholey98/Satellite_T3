import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as RevdocService from "./RevdocService.ts";

/**
 * Decorates upstream's git workflow service so a successful worktree removal also forgets the
 * worktree's Review. Satellite's server layer provides it above the WS handlers, so the remove
 * action needs no upstream edit.
 */
export const layer = Layer.effect(
  GitWorkflowService.GitWorkflowService,
  Effect.gen(function* () {
    const git = yield* GitWorkflowService.GitWorkflowService;
    const revdoc = yield* RevdocService.RevdocService;
    return GitWorkflowService.GitWorkflowService.of({
      ...git,
      removeWorktree: (input) =>
        git.removeWorktree(input).pipe(Effect.andThen(revdoc.forgetWorktree(input.path))),
    });
  }),
);
