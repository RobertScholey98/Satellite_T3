import { IssueDeliveriesDeliverInput, IssueOperationError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import { IssueDelivery } from "../../../issues/IssueDelivery.ts";

const DeliverIssueUpdates = Tool.make("deliver_issue_updates", {
  description:
    "Collect pending ticket updates for an issue board now from every worktree computer that runs work for it, instead of waiting for the next scheduled round. Updates that arrive move tickets the same way they would on their own. Use the boardId of a connected board in this environment.",
  parameters: IssueDeliveriesDeliverInput,
  success: Schema.Void,
  failure: IssueOperationError,
  dependencies: [IssueDelivery],
})
  .annotate(Tool.Title, "Deliver issue updates")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const IssuesToolkit = Toolkit.make(DeliverIssueUpdates);
