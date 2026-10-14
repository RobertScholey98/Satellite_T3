import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { IdeaPromotion } from "./ideas.ts";

const decodePromotion = Schema.decodeUnknownSync(IdeaPromotion);

describe("IdeaPromotion", () => {
  it("reads a promotion stored before targets carried a host kind as a GitHub promotion", () => {
    const stored = {
      target: { host: "github.com", repository: "example/ideas" },
      id: "promotion-1",
      sourceRevision: 3,
      status: "partial",
      drafts: [{ id: "first", title: "Build first", body: "Implement first.", labels: [] }],
      issues: [
        {
          draftId: "first",
          url: "https://github.com/example/ideas/issues/1",
          number: 1,
          title: "Build first",
          publishedAt: "2026-10-01T00:00:00.000Z",
        },
      ],
      remainingScope: "The second feature remains.",
      error: null,
    };
    const promotion = decodePromotion(stored);
    expect(promotion.target).toEqual({
      hostKind: "github",
      host: "github.com",
      repository: "example/ideas",
    });
    expect(promotion.issues.map((issue) => [issue.draftId, issue.number])).toEqual([["first", 1]]);
  });
});
