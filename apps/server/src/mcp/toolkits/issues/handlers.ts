import * as Effect from "effect/Effect";

import { IssueDelivery } from "../../../issues/IssueDelivery.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { IssuesToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const delivery = yield* IssueDelivery;
  return {
    deliver_issue_updates: McpToolAccess.writes((input) => delivery.deliver(input)),
  } satisfies McpToolAccess.Handlers<typeof IssuesToolkit.tools>;
});

export const IssuesToolkitHandlersLive = McpToolAccess.toLayer(IssuesToolkit, make);
