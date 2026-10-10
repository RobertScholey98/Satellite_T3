import {
  FactoryAssignmentId,
  ProjectId,
  ThreadId,
  type FactoryMergeGroupRead,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  factoryMergeDecisionIdentity,
  factoryMergeEvidenceUrl,
  factoryMergePullRequestUrl,
} from "./FactoryMergeReadModel";

const now = "2026-10-10T12:00:00Z";
const fixture = (): FactoryMergeGroupRead => ({
  group: {
    id: "group",
    integrationId: "integration",
    integrationAssignmentId: FactoryAssignmentId.make("integration"),
    memberAssignmentIds: [],
    knownPullRequests: [],
    currentReviewId: "review",
    createdAt: now,
    updatedAt: now,
  },
  currentReview: {
    id: "review",
    groupId: "group",
    createdAt: now,
    decision: null,
    lifecycle: {
      phase: "sealed",
      digest: "digest",
      members: [],
      integrationVerificationId: "verification",
      integrationPreparationId: "preparation",
      inputDigest: "inputs",
      testArtifactDigest: "tests",
      sealedAt: now,
    },
  },
  readiness: {
    groupId: "group",
    status: "ready",
    reasons: [],
    reviewId: "review",
    reviewDigest: "digest",
    members: [],
    integrationVerificationId: "verification",
    canApprove: true,
    canRequestMerge: false,
  },
  integrationLeadThreadId: ThreadId.make("lead"),
});

describe("combined review decisions", () => {
  it("binds consent to the current sealed review and rejects stale or still-pending evidence", () => {
    const read = fixture();
    expect(factoryMergeDecisionIdentity(read)).toEqual({
      groupId: "group",
      reviewId: "review",
      expectedDigest: "digest",
    });
    expect(
      factoryMergeDecisionIdentity({
        ...read,
        group: { ...read.group, currentReviewId: "new-review" },
      }),
    ).toBeNull();
    expect(
      factoryMergeDecisionIdentity({
        ...read,
        readiness: { ...read.readiness, reviewDigest: "new-digest" },
      }),
    ).toBeNull();
    expect(
      factoryMergeDecisionIdentity({ ...read, readiness: { ...read.readiness, reviewId: null } }),
    ).toBeNull();
    expect(
      factoryMergeDecisionIdentity({
        ...read,
        currentReview: { ...read.currentReview!, lifecycle: { phase: "requested" } },
      }),
    ).toBeNull();
  });

  it("opens only HTTP evidence links and uses the exact PR host and number", () => {
    const ref = {
      projectId: ProjectId.make("web"),
      repository: "owner/repo",
      host: "github.company.test",
      number: 17,
    };
    expect(factoryMergePullRequestUrl(ref)).toBe("https://github.company.test/owner/repo/pull/17");
    expect(factoryMergePullRequestUrl({ ...ref, host: "github.com@evil.test/path" })).toBeNull();
    expect(factoryMergePullRequestUrl({ ...ref, number: 0 })).toBeNull();
    expect(factoryMergeEvidenceUrl("https://images.test/screenshot.png")).toBe(
      "https://images.test/screenshot.png",
    );
    expect(factoryMergeEvidenceUrl("javascript:alert(1)")).toBeNull();
    expect(factoryMergeEvidenceUrl("file:///C:/private/screenshot.png")).toBeNull();
  });
});
