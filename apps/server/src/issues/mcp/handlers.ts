import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { IssueService, type IssueThreadTicket } from "../IssueService.ts";
import { IssuesToolkit, ThreadTicketReadFailedError, type ThreadTicketResult } from "./tools.ts";

const ticketResult = (found: IssueThreadTicket | null): ThreadTicketResult => {
  if (found === null)
    return { ticket: null, attempt: null, message: "This thread was not started from a ticket." };
  const { ticket, attempt } = found;
  return {
    ticket: {
      number: ticket.ref.number,
      title: ticket.title,
      url: ticket.ref.url,
      state: ticket.state,
      labels: ticket.labels,
      column: found.column,
      body: ticket.body,
      comments: (ticket.comments ?? []).map((comment) => ({
        author: comment.author?.name ?? null,
        createdAt: comment.createdAt,
        body: comment.body,
      })),
    },
    attempt: {
      status: attempt.status,
      active: attempt.active,
      automaticMovesPaused: attempt.automaticMoves === "paused",
    },
    message:
      found.source === "host"
        ? `Ticket #${ticket.ref.number} ${ticket.title}.`
        : `Ticket #${ticket.ref.number} ${ticket.title}. The repository host was unreachable, so the body and comments are missing; this is the board's stored copy.`,
  };
};

const make = Effect.gen(function* () {
  const issues = yield* IssueService;
  return {
    read_thread_ticket: McpToolAccess.reads(() =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireMcpCapability("orchestration");
        const { threadId } = (yield* McpInvocationContext.requireThreadScope(scope, "This tool"))
          .thread;
        const found = yield* issues
          .threadTicket(threadId)
          .pipe(
            Effect.mapError((cause) => new ThreadTicketReadFailedError({ reason: cause.message })),
          );
        return ticketResult(found);
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof IssuesToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(IssuesToolkit, make);
