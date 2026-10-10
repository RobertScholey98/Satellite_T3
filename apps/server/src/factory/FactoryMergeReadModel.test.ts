import { describe, expect, it } from "vite-plus/test";
import { FactoryAssignmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { reviewedMergeFixture, api, integrated, deliveryIds } from "./FactoryMerge.testkit.ts";
import { scopeFactoryMerge } from "./FactoryMergeReadModel.ts";

describe("merge group read scope", () => {
  it("exposes the same linked review to its participant projects without unrelated groups", () => {
    const { state, groupId, reviewId } = reviewedMergeFixture();
    const group = state.mergeGroups[0]!;
    const review = state.mergeGroupReviews[0]!;
    const withForeignGroup = {
      ...state,
      mergeGroups: [
        ...state.mergeGroups,
        {
          ...group,
          id: "foreign",
          integrationAssignmentId: FactoryAssignmentId.make("foreign"),
          memberAssignmentIds: [FactoryAssignmentId.make("foreign-member")],
        },
      ],
      mergeGroupReviews: [
        ...state.mergeGroupReviews,
        { ...review, id: "foreign-review", groupId: "foreign" },
      ],
    };
    for (const projectId of [deliveryIds.project, api.project]) {
      const scoped = scopeFactoryMerge(withForeignGroup, { kind: "project", projectId });
      expect(scoped.mergeGroups.map((entry) => entry.id)).toEqual([groupId]);
      expect(scoped.mergeGroupReviews.map((entry) => entry.id)).toEqual([reviewId]);
      expect(Object.keys(scoped).sort()).toEqual(["mergeGroupReviews", "mergeGroups"]);
    }
    expect(
      scopeFactoryMerge(withForeignGroup, {
        kind: "project",
        projectId: ProjectId.make("unrelated"),
      }),
    ).toEqual({ mergeGroups: [], mergeGroupReviews: [] });
  });

  it("binds manager and assignment scopes to durable ownership", () => {
    const { state, groupId } = reviewedMergeFixture();
    for (const assignmentId of [deliveryIds.assignment, api.assignment, integrated.assignment]) {
      expect(
        scopeFactoryMerge(state, { kind: "assignment", assignmentId }).mergeGroups.map(
          (entry) => entry.id,
        ),
      ).toEqual([groupId]);
    }
    expect(
      scopeFactoryMerge(state, { kind: "manager", managerId: api.manager }).mergeGroups.map(
        (entry) => entry.id,
      ),
    ).toEqual([groupId]);
    expect(
      scopeFactoryMerge(state, { kind: "manager", managerId: ThreadId.make("unrelated") })
        .mergeGroups,
    ).toEqual([]);
    expect(
      scopeFactoryMerge(state, {
        kind: "assignment",
        assignmentId: FactoryAssignmentId.make("unrelated"),
      }).mergeGroupReviews,
    ).toEqual([]);
  });
});
