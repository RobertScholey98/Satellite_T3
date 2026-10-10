import { useFactoryCommand } from "./useFactoryCommand";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  resolveDeviceHubAccess,
  withDeviceHubQuery,
} from "@t3tools/client-runtime/state/deviceHubAccess";

import {
  type EnvironmentId,
  type FactoryAssignment,
  type FactoryDeliveryRevision,
  type ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";

import { connectionAtomRuntime } from "../../connection/runtime";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useThreadShell } from "../../state/entities";
import { type FactoryEnvironmentView } from "../../state/factory";
import { environmentSession } from "../../state/session";

import { buildThreadRouteParams } from "../../threadRoutes";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { factoryAssignmentCancellation, factoryProjectPause } from "./FactoryControlsReadModel";

const evidenceAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return resolveDeviceHubAccess({ prepared, hubBasePath: "/api/factory/preview-evidence" });
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`factory-preview-evidence:${environmentId}`)),
);

function Screenshots({
  environment,
  evidence,
}: {
  environment: FactoryEnvironmentView;
  evidence: NonNullable<FactoryDeliveryRevision["uxEvidence"]>;
}) {
  const atom = evidenceAccessAtom(environment.environmentId);
  const result = useAtomValue(atom);
  const access = AsyncResult.isSuccess(result) ? result.value : null;
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retry = () => {
    setFailed(false);
    setAttempt((value) => value + 1);
    appAtomRegistry.refresh(atom);
  };
  return (
    <section className="space-y-2">
      <h4 className="text-sm font-medium">Recorded app journeys</h4>
      <p className="text-xs text-muted-foreground">
        Captured by the independent reviewer in the isolated app for this candidate.
      </p>
      <ul className="list-inside list-disc text-sm">
        {evidence.journeys.map((entry) => (
          <li key={`${entry.label}:${entry.location}`}>{entry.label}</li>
        ))}
      </ul>
      <div className="space-y-3">
        {access ? (
          evidence.screenshots.map((entry, index) => (
            <figure key={`${entry.location}:${attempt}`} className="space-y-1">
              <img
                src={withDeviceHubQuery(
                  `${access.httpBase}/${encodeURIComponent(evidence.operationsDigest)}/${index}`,
                  access,
                )}
                alt={entry.label}
                loading="lazy"
                crossOrigin={access.credentials ? "use-credentials" : "anonymous"}
                onError={() => setFailed(true)}
                className="max-h-96 w-full rounded-md border border-border object-contain"
              />
              <figcaption className="text-xs text-muted-foreground">{entry.label}</figcaption>
            </figure>
          ))
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {AsyncResult.isFailure(result)
              ? "Screenshot access could not be opened."
              : "Loading screenshot access…"}
          </p>
        )}
      </div>
      {failed || AsyncResult.isFailure(result) ? (
        <div className="space-y-1">
          <p role="status" className="text-sm text-muted-foreground">
            Screenshots could not be loaded. Refresh their access before reviewing.
          </p>
          <Button size="xs" variant="outline" onClick={retry}>
            Reload screenshots
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function ReviewerLink({
  environment,
  threadId,
  onOpenThread,
}: {
  environment: FactoryEnvironmentView;
  threadId: ThreadId;
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
}) {
  const ref = scopeThreadRef(environment.environmentId, threadId);
  const shell = useThreadShell(ref);
  if (!shell || shell.archivedAt !== null || shell.deletedAt !== null)
    return (
      <span className="text-xs text-muted-foreground">
        Reviewer thread{" "}
        {shell?.deletedAt ? "deleted" : shell?.archivedAt ? "archived" : "not available yet"}
      </span>
    );
  return onOpenThread ? (
    <Button size="xs" variant="outline" onClick={() => onOpenThread(threadId)}>
      Open reviewer
    </Button>
  ) : (
    <Link
      className="text-xs text-primary underline underline-offset-2"
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams(ref)}
    >
      Open reviewer
    </Link>
  );
}

const flowMarkdownComponents = {
  a: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
};

function restrictedFlowHtml(content: string) {
  // A flow is an inert proposal. Remove navigation as well as active content;
  // CSP alone does not prohibit an iframe navigating to an external link.
  const template = document.createElement("template");
  template.innerHTML = content;
  for (const element of template.content.querySelectorAll(
    "script, iframe, object, embed, meta, base, link",
  ))
    element.remove();
  for (const element of template.content.querySelectorAll("*")) {
    for (const attribute of element.getAttributeNames()) {
      const name = attribute.toLowerCase();
      if (
        name.startsWith("on") ||
        [
          "href",
          "xlink:href",
          "srcset",
          "srcdoc",
          "action",
          "formaction",
          "target",
          "ping",
          "download",
        ].includes(name) ||
        (name === "src" && !element.getAttribute(attribute)?.startsWith("data:image/"))
      )
        element.removeAttribute(attribute);
    }
  }
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'">${template.innerHTML}`;
}

function FlowArtifact({
  flow,
}: {
  flow: NonNullable<NonNullable<FactoryAssignment["delivery"]>["flow"]>;
}) {
  const html = useMemo(
    () => (flow.artifact?.format === "html" ? restrictedFlowHtml(flow.artifact.content) : ""),
    [flow.artifact],
  );
  if (!flow.artifact)
    return (
      <p className="text-sm text-muted-foreground">
        The lead is preparing a concrete flow for your review.
      </p>
    );
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium">{flow.artifact.title}</h4>
      {flow.artifact.format === "html" ? (
        <iframe
          title={`Flow proposal: ${flow.artifact.title}`}
          sandbox=""
          referrerPolicy="no-referrer"
          className="h-96 w-full rounded-md border border-border bg-white"
          srcDoc={html}
        />
      ) : (
        <div className="space-y-2 text-sm [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-medium [&_li]:ml-4 [&_ol]:list-decimal [&_p]:my-2 [&_pre]:overflow-x-auto [&_ul]:list-disc">
          <ReactMarkdown
            skipHtml
            disallowedElements={["img", "iframe", "video", "audio", "source"]}
            components={flowMarkdownComponents}
          >
            {flow.artifact.content}
          </ReactMarkdown>
        </div>
      )}
      <p className="break-all text-xs text-muted-foreground">
        Proposal digest: {flow.artifactDigest ?? "Waiting for immutable artifact receipt"}
      </p>
    </div>
  );
}

export function FactoryDelivery({
  environment,
  assignment,
  canOpenLead,
  onOpenLead,
  onOpenThread,
}: {
  environment: FactoryEnvironmentView;
  assignment: FactoryAssignment;
  canOpenLead: boolean;
  onOpenLead: () => void;
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
}) {
  const paused = factoryProjectPause(environment.data, assignment.projectId) !== undefined;
  const terminal =
    assignment.outcome !== undefined ||
    assignment.status === "complete" ||
    factoryAssignmentCancellation(environment.data, assignment) !== undefined;
  const command = useFactoryCommand(environment, !paused && !terminal);
  const [acknowledged, setAcknowledged] = useState<string | null>(null);
  if (assignment.kind === "onboarding") return null;
  const delivery = assignment.delivery;
  const revision = delivery?.revisions.find((entry) => entry.id === delivery.currentRevisionId);
  const flow = delivery?.flow;
  const head = revision?.publication?.headSha;
  const bundle = revision?.bundleDigest;
  const approvalKey = revision && head && bundle ? `${revision.id}:${head}:${bundle}` : null;
  const approvalCurrent =
    revision?.approval?.expectedHeadSha === head &&
    revision?.approval?.bundleDigest === bundle &&
    revision?.approval !== undefined;
  const latestReview = revision?.reviews.at(-1);
  const config = environment.data?.previewConfigurations.findLast(
    (entry) => entry.projectId === assignment.projectId,
  );
  const fields = revision ? { assignmentId: assignment.id, revisionId: revision.id } : null;
  const mergeInFlight =
    revision?.merge?.status === "requested" ||
    revision?.merge?.status === "unknown" ||
    revision?.merge?.status === "merged";
  const ref = revision?.publication?.ref;
  const host = ref?.host ?? revision?.publication?.host ?? "github.com";
  const prUrl =
    ref && /^[a-z0-9.-]+$/i.test(host)
      ? `https://${host}/${ref.repository.split("/").map(encodeURIComponent).join("/")}/pull/${ref.number}`
      : null;
  return (
    <section className="space-y-4 border-t border-border pt-4" aria-label="Delivery and review">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">Delivery and review</h3>
        <Badge variant="secondary" size="sm">
          {revision?.merge?.status === "merged" ? "Merged" : (revision?.status ?? "In progress")}
        </Badge>
        <Button size="xs" variant="outline" disabled={!canOpenLead} onClick={onOpenLead}>
          Discuss with lead
        </Button>
      </div>
      {!delivery ? (
        <p className="text-sm text-muted-foreground">
          The implementation team prepares the candidate, reviews it, and handles the PR. Its
          delivery evidence will appear here.
        </p>
      ) : null}
      {paused ? (
        <p role="status" className="text-sm text-muted-foreground">
          Project work is paused. Resume it before taking delivery actions.
        </p>
      ) : null}
      {!environment.connected ? (
        <p role="status" className="text-sm text-muted-foreground">
          Reconnect to {environment.label} to update delivery.
        </p>
      ) : null}
      {delivery?.impact ? (
        <div className="space-y-1">
          <p className="text-sm">
            <span className="font-medium">UI impact:</span>{" "}
            {delivery.impact.classification.replaceAll("-", " ")}
          </p>
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">
            {delivery.impact.summary}
          </p>
        </div>
      ) : null}
      {flow ? (
        <section className="space-y-3 border-l-2 border-border pl-3" aria-label="Flow approval">
          <h4 className="text-sm font-medium">Flow review · {flow.status}</h4>
          {flow.status === "stopping" ? (
            <p role="status" className="text-sm text-muted-foreground">
              Stopping implementation before flow review.
            </p>
          ) : null}
          {flow.status === "held" ? (
            <p className="text-sm text-muted-foreground">
              Implementation is held while you review this proposal. Approval applies to the
              displayed digest.
            </p>
          ) : null}
          <FlowArtifact flow={flow} />
          {flow.decision ? (
            <p className="text-sm text-muted-foreground">
              {flow.decision.approved
                ? "This proposal was approved."
                : "Changes requested. Discuss the changes with the lead; implementation remains held."}
            </p>
          ) : null}
          {flow.status === "held" &&
          flow.artifactDigest &&
          !flow.pendingArtifactId &&
          !flow.decision ? (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={command.disabled}
                onClick={() =>
                  void command.submit({
                    type: "delivery.flow.decide",
                    assignmentId: assignment.id,
                    artifactDigest: flow.artifactDigest!,
                    approved: true,
                  })
                }
              >
                Approve this flow
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={command.disabled}
                onClick={() =>
                  void command.submit({
                    type: "delivery.flow.decide",
                    assignmentId: assignment.id,
                    artifactDigest: flow.artifactDigest!,
                    approved: false,
                  })
                }
              >
                Request flow changes
              </Button>
            </div>
          ) : null}
          {flow.error ? (
            <div className="space-y-2">
              <p role="alert" className="text-sm text-destructive">
                {flow.error}
              </p>
              <Button
                size="xs"
                variant="outline"
                disabled={command.disabled}
                onClick={() =>
                  void command.submit({ type: "delivery.flow.retry", assignmentId: assignment.id })
                }
              >
                Retry flow transition
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}
      {revision && fields ? (
        <>
          <div className="space-y-1">
            {prUrl ? (
              <a
                href={prUrl}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-primary underline underline-offset-2"
              >
                {ref?.repository} #{ref?.number}
              </a>
            ) : (
              <p className="text-sm text-muted-foreground">PR publication is not recorded yet.</p>
            )}
            <p className="break-all text-xs text-muted-foreground">Revision: {revision.id}</p>
            <p className="break-all text-xs text-muted-foreground">
              PR head: {head ?? "Not published"}
            </p>
            <p className="break-all text-xs text-muted-foreground">
              Evidence bundle: {bundle ?? "Awaiting readiness check"}
            </p>
            <p className="text-sm">
              Candidate checks:{" "}
              {revision.verification
                ? revision.verification.passed
                  ? "passed"
                  : "failed"
                : "not recorded"}
            </p>
            {revision.hostEvidence ? (
              <p className="text-sm text-muted-foreground">
                PR checks: {revision.hostEvidence.checks}; host reviews:{" "}
                {revision.hostEvidence.reviews}. Observed {revision.hostEvidence.observedAt}.
              </p>
            ) : null}
          </div>
          {revision.reviews.length ? (
            <section className="space-y-3">
              <h4 className="text-sm font-medium">Team reviews</h4>
              {revision.reviews.map((review, index) => (
                <div key={review.id} className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant={
                        review.status === "changes-requested" || review.status === "failed"
                          ? "warning"
                          : "secondary"
                      }
                      size="sm"
                    >
                      {review.status.replaceAll("-", " ")}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {index === revision.reviews.length - 1 ? "Latest review" : "Earlier review"}
                    </span>
                    <ReviewerLink
                      environment={environment}
                      threadId={review.threadId}
                      onOpenThread={onOpenThread}
                    />
                  </div>
                  {review.findings ? (
                    <p className="whitespace-pre-wrap text-sm">{review.findings}</p>
                  ) : null}
                  {review.evidence.length ? (
                    <ul className="space-y-1 text-xs text-muted-foreground">
                      {review.evidence.map((entry) => (
                        <li key={`${entry.label}:${entry.location}`} className="break-words">
                          {entry.label} · {entry.location}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))}
            </section>
          ) : (
            <p className="text-sm text-muted-foreground">
              Independent team review is not recorded yet.
            </p>
          )}
          {revision.uxEvidence ? (
            <Screenshots
              key={revision.uxEvidence.operationsDigest}
              environment={environment}
              evidence={revision.uxEvidence}
            />
          ) : null}
          {revision.publishedUxEvidence ? (
            <p className="text-xs text-muted-foreground">
              {revision.publishedUxEvidence.urls.length} verified screenshots published for the PR.
            </p>
          ) : revision.uxEvidence ? (
            <p className="text-xs text-muted-foreground">
              Screenshots are available locally. PR screenshot publication is not recorded yet.
            </p>
          ) : null}
          {revision.preview ? (
            <div className="space-y-2">
              <p className="text-sm">Isolated app preview: {revision.preview.status}</p>
              {revision.preview.error ? (
                <p role="status" className="text-sm text-muted-foreground">
                  {revision.preview.error}
                </p>
              ) : null}
              {revision.preview.status === "ready" || revision.preview.status === "starting" ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={command.disabled}
                  onClick={() =>
                    void command.submit({
                      type: "delivery.preview.stop",
                      ...fields,
                      instanceId: revision.preview!.instanceId,
                    })
                  }
                >
                  Stop app preview
                </Button>
              ) : null}
            </div>
          ) : null}
          {latestReview &&
          config &&
          (latestReview.status === "pending" || latestReview.status === "running") &&
          (!revision.preview ||
            revision.preview.status === "stopped" ||
            revision.preview.status === "failed") ? (
            <Button
              size="xs"
              variant="outline"
              disabled={command.disabled}
              onClick={() =>
                void command.submit({
                  type: "delivery.preview.start",
                  ...fields,
                  reviewId: latestReview.id,
                  configurationId: config.id,
                })
              }
            >
              Start reviewer app preview
            </Button>
          ) : null}
          {delivery?.readiness.length ? (
            <div role="status" className="space-y-1">
              <h4 className="text-sm font-medium">Before merge</h4>
              <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
                {delivery.readiness.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {revision.error ? (
            <p role="alert" className="text-sm text-destructive">
              {revision.error}
            </p>
          ) : null}
          {revision.merge ? (
            <p role="status" className="text-sm">
              Merge: {revision.merge.status}
              {revision.merge.reason ? ` · ${revision.merge.reason}` : ""}
              {revision.merge.status === "unknown"
                ? ". Awaiting confirmation; this is not a confirmed merge."
                : ""}
            </p>
          ) : null}
          {approvalCurrent ? (
            <p className="text-sm">
              This exact head and evidence bundle are approved by{" "}
              {revision.approval!.authority === "human"
                ? "you"
                : `project rule ${revision.approval!.ruleVersion}`}
              .
            </p>
          ) : approvalKey ? (
            <div className="space-y-2">
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={acknowledged === approvalKey}
                  disabled={command.disabled || mergeInFlight}
                  onCheckedChange={(value) => setAcknowledged(value ? approvalKey : null)}
                />
                I reviewed the displayed PR head, findings, and evidence bundle.
              </label>
              <Button
                size="sm"
                disabled={command.disabled || mergeInFlight || acknowledged !== approvalKey}
                onClick={() =>
                  void command.submit({
                    type: "delivery.approve",
                    ...fields,
                    expectedHeadSha: head!,
                    bundleDigest: bundle!,
                  })
                }
              >
                Approve this revision
              </Button>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={command.disabled || mergeInFlight || revision.status !== "published"}
              onClick={() => void command.submit({ type: "delivery.ready", ...fields })}
            >
              Refresh readiness
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={
                command.disabled || mergeInFlight || !bundle || revision.status !== "published"
              }
              onClick={() => void command.submit({ type: "delivery.merge", ...fields })}
            >
              Request merge
            </Button>
            {revision.error ||
            revision.status === "failed" ||
            revision.merge?.status === "failed" ||
            revision.merge?.status === "unknown" ? (
              <Button
                size="xs"
                variant="outline"
                disabled={command.disabled}
                onClick={() => void command.submit({ type: "delivery.retry", ...fields })}
              >
                {revision.merge?.status === "unknown" ? "Reconcile merge status" : "Retry delivery"}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
      {delivery?.directionHeld ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            You are directing the review. Send corrections directly to the implementation lead, then
            hand coordination back when ready. Handback does not approve a merge.
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={command.disabled}
            onClick={() =>
              void command.submit({ type: "delivery.review.handback", assignmentId: assignment.id })
            }
          >
            Hand review back to the team
          </Button>
        </div>
      ) : null}
      {command.pending ? (
        <p role="status" className="text-xs text-muted-foreground">
          Saving delivery decision…
        </p>
      ) : null}
      {command.error ? (
        <p role="alert" className="text-sm text-destructive">
          {command.error}
        </p>
      ) : null}
    </section>
  );
}
