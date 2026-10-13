import { describe, expect, it } from "vite-plus/test";
import { triageColumnOptions } from "./FactoryTriageColumns";

describe("triageColumnOptions", () => {
  it("marks every column of a fully mapped board with its role", () => {
    expect(
      triageColumnOptions(
        [
          { id: "todo", title: "Todo" },
          { id: "ready", title: "ready" },
          { id: "progress", title: "In Progress" },
          { id: "review", title: "awaiting human review" },
          { id: "done", title: "Done" },
        ],
        {
          ready: ["todo", "ready"],
          inProgress: "progress",
          inPullRequest: "review",
          completed: "done",
          moveOnMerge: true,
        },
      ),
    ).toEqual([
      { id: "todo", title: "Todo", role: "ready" },
      { id: "ready", title: "ready", role: "ready" },
      { id: "progress", title: "In Progress", role: "in-progress" },
      { id: "review", title: "awaiting human review", role: "in-pull-request" },
      { id: "done", title: "Done", role: "completed" },
    ]);
  });

  it("leaves an unmapped column free for triage", () => {
    expect(
      triageColumnOptions(
        [
          { id: "inbox", title: "Inbox" },
          { id: "ready", title: "Ready" },
          { id: "progress", title: "In Progress" },
          { id: "review", title: "In Review" },
          { id: "done", title: "Done" },
        ],
        {
          ready: "ready",
          inProgress: "progress",
          inPullRequest: "review",
          completed: "done",
          moveOnMerge: false,
        },
      ),
    ).toEqual([
      { id: "inbox", title: "Inbox", role: null },
      { id: "ready", title: "Ready", role: "ready" },
      { id: "progress", title: "In Progress", role: "in-progress" },
      { id: "review", title: "In Review", role: "in-pull-request" },
      { id: "done", title: "Done", role: "completed" },
    ]);
  });
});
