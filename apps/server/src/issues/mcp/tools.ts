import {
  IssueAttemptStatus,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { IssueService } from "../IssueService.ts";

export class ThreadTicketReadFailedError extends Schema.TaggedError<ThreadTicketReadFailedError>()(
  "ThreadTicketReadFailedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `Could not read this thread's ticket. ${this.reason}`;
  }
}

export const ThreadTicketResult = Schema.Struct({
  ticket: Schema.NullOr(
    Schema.Struct({
      number: Schema.Number,
      title: Schema.String,
      url: Schema.String,
      state: Schema.String,
      labels: Schema.Array(Schema.String),
      column: Schema.NullOr(Schema.String),
      body: Schema.String,
      comments: Schema.Array(
        Schema.Struct({
          author: Schema.NullOr(Schema.String),
          createdAt: Schema.String,
          body: Schema.String,
        }),
      ),
    }),
  ),
  attempt: Schema.NullOr(
    Schema.Struct({
      status: IssueAttemptStatus,
      active: Schema.Boolean,
      automaticMovesPaused: Schema.Boolean,
    }),
  ),
  message: Schema.String,
});
export type ThreadTicketResult = typeof ThreadTicketResult.Type;

const ReadThreadTicketTool = Tool.make("read_thread_ticket", {
  description:
    "Read the issue board ticket this thread was started from: its title, body, labels, current board column and latest comments. Use it to recheck requirements that may have changed since the thread began. Ticket moves follow the thread's pull requests automatically.",
  parameters: Tool.EmptyParams,
  success: ThreadTicketResult,
  failure: Schema.Union([
    OrchestratorMcpFailure,
    McpCapabilityUnavailableError,
    ThreadTicketReadFailedError,
  ]),
  dependencies: [McpInvocationContext.McpInvocationContext, IssueService],
})
  .annotate(Tool.Title, "Read thread ticket")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const IssuesToolkit = Toolkit.make(ReadThreadTicketTool);
