import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthSettingsWriteScope,
  type FactoryMergeGroupRead,
  type FactoryMergeMemberReadiness,
  type ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import type { FactoryEnvironmentView } from "../../state/factory";
import { useEnvironmentScope } from "../../state/session";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { FactoryDeliveryScreenshots } from "./FactoryDelivery";
import {
  factoryMergeDecisionIdentity,
  factoryMergeEvidenceUrl,
  factoryMergeMemberRevision,
  factoryMergePullRequestUrl,
  factoryMergeReviewLocked,
} from "./FactoryMergeReadModel";
import { FactoryMergeOperation } from "./FactoryMergeOperation";
import { useFactoryCommand } from "./useFactoryCommand";
import { useFactoryMergeGroup } from "./useFactoryMergeGroup";

export function FactoryMergeThreadLink({
  environment,
  threadId,
  children,
  onOpenThread,
}: {
  environment: FactoryEnvironmentView;
  threadId: ThreadId;
  children: string;
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
}) {
  return onOpenThread ? (
    <Button size="xs" variant="outline" onClick={() => onOpenThread(threadId)}>
      {children}
    </Button>
  ) : (
    <Link
      className="text-xs text-primary underline underline-offset-2"
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams(scopeThreadRef(environment.environmentId, threadId))}
    >
      {children}
    </Link>
  );
}

export function FactoryMergeReview({
  environment,
  groupId,
  onOpenThread,
}: {
  environment: FactoryEnvironmentView;
  groupId: string;
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
}) {
  const query = useFactoryMergeGroup(environment, groupId);
  return (
    <section className="space-y-4" aria-label="Combined feature review">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Combined feature review</h3>
        <Button
          size="xs"
          variant="outline"
          disabled={query.isPending || !environment.connected}
          onClick={query.refresh}
        >
          Reload status
        </Button>
      </div>
      {query.error ? (
        <p role="alert" className="text-sm text-destructive">
          {query.error}
        </p>
      ) : null}
      {query.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Updating group readiness…
        </p>
      ) : null}
      {query.data ? (
        <ReviewContent
          key={`${query.data.group.id}:${query.data.currentReview?.id ?? "unreviewed"}`}
          environment={environment}
          read={query.data}
          refreshing={query.isPending || query.error !== null}
          onOpenThread={onOpenThread}
        />
      ) : !query.error ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading the linked PRs and integration evidence…
        </p>
      ) : null}
    </section>
  );
}

function ReviewContent({
  environment,
  read,
  refreshing,
  onOpenThread,
}: {
  environment: FactoryEnvironmentView;
  read: FactoryMergeGroupRead;
  refreshing: boolean;
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
}) {
  const prefix = useId();
  const settings = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const reviewLocked = factoryMergeReviewLocked(read);
  const reviewCommand = useFactoryCommand(environment, !refreshing && !reviewLocked);
  const decisionCommand = useFactoryCommand(environment, settings && !refreshing && !reviewLocked);
  const [reason, setReason] = useState("");
  const [acknowledged, setAcknowledged] = useState<string | null>(null);
  const identity = factoryMergeDecisionIdentity(read);
  const key = identity ? `${identity.reviewId}:${identity.expectedDigest}` : null;
  const review = read.currentReview;
  const sealed = review?.lifecycle.phase === "sealed" ? review.lifecycle : null;
  const statuses = {
    waiting: "Waiting for evidence",
    reviewing: "Review in progress",
    "changes-requested": "Changes requested",
    ready: "Review gates satisfied",
  };
  const verification = environment.data?.integrationVerifications.find(
    (entry) => entry.id === read.readiness.integrationVerificationId,
  );
  return (
    <div className="space-y-4">
      <FactoryMergeOperation environment={environment} read={read} refreshing={refreshing} />
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant={read.readiness.status === "changes-requested" ? "warning" : "secondary"}
          size="sm"
        >
          {reviewLocked ? "Review recorded for shared merge" : statuses[read.readiness.status]}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {read.readiness.members.length} linked PRs · one shared delivery
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        Review the combined feature here. Discuss corrections directly with each owning lead. Every
        member keeps its own project safeguards and independent team review.
      </p>
      {!reviewLocked && read.readiness.reasons.length ? (
        <ul className="list-inside list-disc space-y-1 text-sm">
          {[...new Set(read.readiness.reasons)].map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
      {review?.lifecycle.phase === "failed" ? (
        <p role="alert" className="text-sm text-destructive">
          {review.lifecycle.reason}
        </p>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        disabled={reviewCommand.disabled || review?.lifecycle.phase === "requested"}
        onClick={() =>
          void reviewCommand.submit({ type: "merge.group.review", groupId: read.group.id })
        }
      >
        {reviewCommand.pending || review?.lifecycle.phase === "requested"
          ? "Refreshing review evidence…"
          : sealed
            ? "Refresh combined review"
            : "Prepare combined review"}
      </Button>
      <div className="divide-y divide-border">
        {read.readiness.members.map((member) => (
          <MemberEvidence
            key={member.assignmentId}
            environment={environment}
            member={member}
            onOpenThread={onOpenThread}
          />
        ))}
      </div>
      <section className="space-y-2 border-t border-border pt-3">
        <h4 className="text-sm font-medium">Combined verification</h4>
        {verification ? (
          <>
            <p className="text-sm">
              {verification.lifecycle.phase === "completed"
                ? verification.lifecycle.result
                : verification.lifecycle.phase}
            </p>
            <p className="break-all text-xs text-muted-foreground">
              Verification: {verification.id} · preparation: {verification.preparationId}
            </p>
            {verification.lifecycle.phase === "completed" ? (
              <details>
                <summary className="cursor-pointer text-xs">Protected integration checks</summary>
                <div className="mt-2 space-y-2">
                  {verification.lifecycle.checks.map((check) => (
                    <div key={check.id}>
                      <p className="text-xs">
                        {check.id}: {check.status}
                      </p>
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">
                        {check.output}
                      </pre>
                    </div>
                  ))}
                </div>
              </details>
            ) : verification.lifecycle.phase === "failed" ? (
              <p className="text-sm text-destructive">{verification.lifecycle.reason}</p>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            A current combined verification is not available.
          </p>
        )}
        {sealed ? (
          <details>
            <summary className="cursor-pointer text-xs">Exact combined evidence</summary>
            <div className="mt-2 space-y-1 break-all text-xs text-muted-foreground">
              <p>Review: {review!.id}</p>
              <p>Review digest: {sealed.digest}</p>
              <p>Input digest: {sealed.inputDigest}</p>
              <p>Test artifact digest: {sealed.testArtifactDigest}</p>
              <p>Sealed: {sealed.sealedAt}</p>
            </div>
          </details>
        ) : null}
        <p className="text-xs text-muted-foreground">
          This evidence describes the recorded candidates. The shared merge must recheck current
          heads and test content before any write.
        </p>
      </section>
      {review?.decision ? (
        <div className="space-y-1">
          <p className="text-sm font-medium">
            {review.decision.outcome === "approved"
              ? "This combined review was approved"
              : "Changes requested for this combined review"}
          </p>
          {review.decision.outcome === "changes-requested" ? (
            <p className="whitespace-pre-wrap text-sm">{review.decision.reason}</p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {review.decision.decidedAt}. A changed evidence digest needs a fresh decision.
          </p>
        </div>
      ) : null}
      {identity && !reviewLocked ? (
        <section className="space-y-3 border-t border-border pt-3">
          <h4 className="text-sm font-medium">Decision for this exact review</h4>
          {!settings ? (
            <p className="text-sm text-muted-foreground">
              Settings permission is required for human approval or requesting changes.
            </p>
          ) : null}
          <div className="flex items-start gap-2">
            <Checkbox
              id={`${prefix}-confirm`}
              checked={key !== null && acknowledged === key}
              disabled={decisionCommand.disabled || !read.readiness.canApprove}
              onCheckedChange={(checked) => setAcknowledged(checked ? key : null)}
            />
            <Label htmlFor={`${prefix}-confirm`}>
              I reviewed these PRs, screenshots and combined evidence.
            </Label>
          </div>
          <Button
            size="sm"
            disabled={
              decisionCommand.disabled || !read.readiness.canApprove || acknowledged !== key
            }
            onClick={() =>
              void decisionCommand.submit({ type: "merge.group.approve", ...identity })
            }
          >
            Approve combined feature
          </Button>
          <div className="space-y-1.5">
            <Label htmlFor={`${prefix}-reason`}>Corrections for the owning leads</Label>
            <Textarea
              id={`${prefix}-reason`}
              value={reason}
              maxLength={6000}
              disabled={decisionCommand.disabled}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={decisionCommand.disabled || !read.readiness.canApprove || !reason.trim()}
            onClick={() =>
              void decisionCommand.submit({
                type: "merge.group.reject",
                ...identity,
                reason: reason.trim(),
              })
            }
          >
            Request changes to this review
          </Button>
        </section>
      ) : sealed && !reviewLocked ? (
        <p className="text-sm text-muted-foreground">
          The sealed review no longer matches current readiness. Refresh the combined review before
          deciding.
        </p>
      ) : null}
      {reviewCommand.error || decisionCommand.error ? (
        <p role="alert" className="text-sm text-destructive">
          {reviewCommand.error ?? decisionCommand.error}
        </p>
      ) : null}
    </div>
  );
}

function MemberEvidence({
  environment,
  member,
  onOpenThread,
}: {
  environment: FactoryEnvironmentView;
  member: FactoryMergeMemberReadiness;
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
}) {
  const revision = environment.data ? factoryMergeMemberRevision(environment.data, member) : null;
  const url = factoryMergePullRequestUrl(member.ref);
  const project =
    environment.data?.managers.find((entry) => entry.projectId === member.projectId)?.name ??
    member.projectId;
  return (
    <section className="space-y-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-medium">{member.title ?? "Participating implementation"}</h4>
          <p className="text-xs text-muted-foreground">{project}</p>
        </div>
        <FactoryMergeThreadLink
          environment={environment}
          threadId={member.leadThreadId}
          onOpenThread={onOpenThread}
        >
          Discuss with owning lead
        </FactoryMergeThreadLink>
      </div>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-primary underline underline-offset-2"
        >
          {member.ref!.repository} #{member.ref!.number}
        </a>
      ) : (
        <p className="text-sm text-muted-foreground">PR publication is not recorded.</p>
      )}
      <p className="text-xs text-muted-foreground">
        {member.needsHuman
          ? member.humanApproved
            ? "Current member bundle approved by human"
            : "Human approval required"
          : member.ruleEligible
            ? "Eligible under this project's rule"
            : "Project rule requirements are not satisfied"}
      </p>
      {member.reasons.length ? (
        <ul className="list-inside list-disc space-y-1 text-xs">
          {[...new Set(member.reasons)].map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
      {member.hostEvidence ? (
        <p className="text-xs">
          PR checks: {member.hostEvidence.checks}; host reviews: {member.hostEvidence.reviews}.
          Observed {member.hostEvidence.observedAt}.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">Fresh host evidence has not been recorded.</p>
      )}
      {member.teamReview ? (
        <div className="space-y-1">
          <p className="text-xs">
            Independent team review: {member.teamReview.status.replaceAll("-", " ")}
          </p>
          {member.teamReview.findings ? (
            <p className="whitespace-pre-wrap text-xs text-muted-foreground">
              {member.teamReview.findings}
            </p>
          ) : null}
          <FactoryMergeThreadLink
            environment={environment}
            threadId={member.teamReview.threadId}
            onOpenThread={onOpenThread}
          >
            Open independent review
          </FactoryMergeThreadLink>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Independent team review is not recorded.</p>
      )}
      {revision?.uxEvidence ? (
        <details>
          <summary className="cursor-pointer text-sm">
            Implemented screenshots ({revision.uxEvidence.screenshots.length})
          </summary>
          <div className="mt-2">
            <FactoryDeliveryScreenshots
              key={revision.uxEvidence.operationsDigest}
              environment={environment}
              evidence={revision.uxEvidence}
            />
          </div>
        </details>
      ) : member.screenshots.length ? (
        <details>
          <summary className="cursor-pointer text-sm">
            Screenshot references ({member.screenshots.length})
          </summary>
          <ul className="mt-2 space-y-1 text-xs">
            {member.screenshots.map((entry) => (
              <li key={`${entry.label}:${entry.location}`} className="break-all">
                {entry.label} · {entry.location}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Open the owning lead or PR to inspect this exact revision's images.
          </p>
        </details>
      ) : null}
      {member.publishedScreenshotUrls.length ? (
        <ul className="space-y-1 text-xs">
          {member.publishedScreenshotUrls.map((value, index) => {
            const href = factoryMergeEvidenceUrl(value);
            return href ? (
              <li key={value}>
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline underline-offset-2"
                >
                  Published screenshot {index + 1}
                </a>
              </li>
            ) : null;
          })}
        </ul>
      ) : null}
      <details>
        <summary className="cursor-pointer text-xs">Exact member revision</summary>
        <div className="mt-2 space-y-1 break-all text-xs text-muted-foreground">
          <p>Revision: {member.revisionId ?? "Not captured"}</p>
          <p>Head: {member.headSha ?? "Not published"}</p>
          <p>Reviewed bundle: {member.bundleDigest ?? "Not inspected"}</p>
        </div>
      </details>
    </section>
  );
}
