import {
  FactoryAssignmentId,
  ProjectId,
  ThreadId,
  CommandId,
  type FactoryMergeOperation,
  type FactoryMergeGroupRead,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  factoryMergeDecisionIdentity,
  factoryMergeOperationActions,
  factoryMergeOperationAlert,
  factoryMergeReviewLocked,
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
  operation: null,
  operationReadiness: {
    status: "idle",
    confirmedCount: 0,
    memberCount: 2,
    reasons: [],
    recommendation: null,
    canStart: true,
    canReconcile: false,
    canRetry: false,
    canStop: false,
    deploymentGate: { supported: true, detail: "Deployment gate: GitHub status" },
  },
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

describe("shared merge operation controls", () => {
  const operation = (): FactoryMergeOperation => ({
    id: "operation",
    groupId: "group",
    integrationId: "integration",
    integrationAssignmentId: FactoryAssignmentId.make("integration"),
    reviewId: "review",
    reviewDigest: "digest",
    authorizingCommandId: CommandId.make("start"),
    members: [],
    lifecycle: {
      phase: "attention",
      frozen: null,
      reason: "Host response lost",
      recommendation: "Reconcile first",
      retry: "reconcile",
    },
    createdAt: now,
    updatedAt: now,
  });
  it("requires the exact current review and write scope to start", () => {
    const read = fixture();
    expect(factoryMergeOperationActions(read, { operate: true, write: true }).start).toEqual({
      groupId: "group",
      reviewId: "review",
      expectedDigest: "digest",
    });
    expect(factoryMergeOperationActions(read, { operate: true, write: false }).start).toBeNull();
    expect(factoryMergeOperationActions(read, { operate: false, write: true }).start).toBeNull();
    expect(
      factoryMergeOperationActions(
        { ...read, operationReadiness: { ...read.operationReadiness, canStart: false } },
        { operate: true, write: true },
      ).start,
    ).toBeNull();
    expect(
      factoryMergeOperationActions(
        { ...read, readiness: { ...read.readiness, reviewDigest: "changed" } },
        { operate: true, write: true },
      ).start,
    ).toBeNull();
  });
  it("keeps read-only reconciliation and stopping separate from retries and refuses stale operations", () => {
    const read = fixture();
    const current = {
      ...read,
      operation: operation(),
      operationReadiness: {
        ...read.operationReadiness,
        canStart: false,
        canRetry: true,
        canReconcile: true,
        canStop: true,
      },
    };
    expect(factoryMergeOperationActions(current, { operate: true, write: false })).toEqual({
      start: null,
      retry: null,
      reconcile: "operation",
      stop: "operation",
    });
    expect(factoryMergeOperationActions(current, { operate: true, write: true }).retry).toBe(
      "operation",
    );
    expect(factoryMergeOperationActions(current, { operate: false, write: true })).toEqual({
      start: null,
      retry: null,
      reconcile: null,
      stop: null,
    });
    expect(
      factoryMergeOperationActions(
        { ...current, operation: { ...current.operation, groupId: "other-group" } },
        { operate: true, write: true },
      ),
    ).toEqual({ start: null, retry: null, reconcile: null, stop: null });
  });
  it("holds review changes during shared execution and permits a stopped untouched operation to be reviewed again", () => {
    const read = { ...fixture(), operation: operation() };
    expect(factoryMergeReviewLocked(read)).toBe(true);
    expect(
      factoryMergeReviewLocked({
        ...read,
        operation: {
          ...operation(),
          lifecycle: { phase: "stopped", frozen: null, reason: "Correct evidence", stoppedAt: now },
        },
      }),
    ).toBe(false);
    expect(factoryMergeReviewLocked(fixture())).toBe(false);
  });
  it("flags a held or partially merged operation in the thread bar until every merge is confirmed", () => {
    const held = operation();
    expect(factoryMergeOperationAlert({ mergeOperations: [held] }, "group")).toBe(
      "Shared merge needs your attention",
    );
    expect(factoryMergeOperationAlert({ mergeOperations: [held] }, "other-group")).toBeNull();
    const merged = {
      reviewed: {} as FactoryMergeOperation["members"][number]["reviewed"],
      authority: {} as FactoryMergeOperation["members"][number]["authority"],
      attempts: 1,
      outcome: { phase: "confirmed" as const, receipt: {} as never },
    };
    const stopped: FactoryMergeOperation = {
      ...held,
      members: [merged],
      lifecycle: { phase: "stopped", frozen: null, reason: "Wait for owners", stoppedAt: now },
    };
    expect(factoryMergeOperationAlert({ mergeOperations: [stopped] }, "group")).toBe(
      "Shared merge partially merged",
    );
    expect(
      factoryMergeOperationAlert({ mergeOperations: [{ ...stopped, members: [] }] }, "group"),
    ).toBeNull();
  });
});
