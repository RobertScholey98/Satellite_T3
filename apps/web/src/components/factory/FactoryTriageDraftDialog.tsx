import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, FactoryManager, FactoryTicketDraft } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLinkIcon, FactoryIcon, TicketIcon } from "lucide-react";
import { useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { randomUUID } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { IssueFormField } from "../work/IssueBoardConfigurationDialog";
import {
  factoryEnvironment,
  factoryErrorMessage,
  unwrapFactoryResult,
  useFactoryAssignments,
} from "./factoryState";
import { criteriaFromText, discussPrompt, proposedChangeView } from "./FactoryTriageState";

/**
 * A retro finding waiting in the Retro triage column. A project finding is edited and approved
 * into a ticket; a factory finding is applied, discussed with the manager, or dismissed.
 */
export function FactoryTriageDraftDialog({
  environmentId,
  draft,
  manager,
  connected,
  onClose,
  onApproved,
}: {
  readonly environmentId: EnvironmentId;
  readonly draft: FactoryTicketDraft;
  readonly manager: FactoryManager | null;
  readonly connected: boolean;
  readonly onClose: () => void;
  /** The ticket now exists on the remote board, so the board should refresh. */
  readonly onApproved: () => void;
}) {
  const navigate = useNavigate();
  const canOperate = useAtomValue(factoryEnvironment.editDraft.permissionAtom(environmentId));
  const canApply = useAtomValue(factoryEnvironment.applyDraft.permissionAtom(environmentId));
  const editDraft = useAtomCommand(factoryEnvironment.editDraft, { reportFailure: false });
  const approveDraft = useAtomCommand(factoryEnvironment.approveDraft, { reportFailure: false });
  const dismissDraft = useAtomCommand(factoryEnvironment.dismissDraft, { reportFailure: false });
  const restoreDraft = useAtomCommand(factoryEnvironment.restoreDraft, { reportFailure: false });
  const applyDraft = useAtomCommand(factoryEnvironment.applyDraft, { reportFailure: false });
  const assignment = useFactoryAssignments(environmentId)?.find(
    (candidate) => candidate.id === draft.assignmentId,
  );

  const [title, setTitle] = useState(draft.title);
  const [body, setBody] = useState(draft.body);
  const [criteriaText, setCriteriaText] = useState(draft.acceptanceCriteria.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pending = draft.state === "pending";
  const editable = pending && canOperate;
  const criteria = criteriaFromText(criteriaText);
  const dirty =
    title.trim() !== draft.title ||
    body.trim() !== draft.body ||
    criteria.join("\n") !== draft.acceptanceCriteria.join("\n");
  const complete = title.trim() !== "" && body.trim() !== "";
  const disabled = !connected || busy;
  const change = draft.proposedChange === null ? null : proposedChangeView(draft.proposedChange);
  const isFactory = draft.scope === "factory";

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(factoryErrorMessage(failure));
    }
    setBusy(false);
  };
  const input = () => ({ requestId: randomUUID(), draftId: draft.id });

  const saveEdits = async () => {
    if (!dirty) return;
    unwrapFactoryResult(
      await editDraft({
        environmentId,
        input: {
          ...input(),
          title: title.trim(),
          body: body.trim(),
          acceptanceCriteria: criteria,
        },
      }),
    );
  };
  const save = () => run(saveEdits);
  const approve = () =>
    run(async () => {
      await saveEdits();
      unwrapFactoryResult(await approveDraft({ environmentId, input: input() }));
      onApproved();
    });
  const apply = () =>
    run(async () => {
      await saveEdits();
      unwrapFactoryResult(await applyDraft({ environmentId, input: input() }));
    });
  const dismiss = () =>
    run(async () => {
      unwrapFactoryResult(await dismissDraft({ environmentId, input: input() }));
      onClose();
    });
  const restore = () =>
    run(async () => {
      unwrapFactoryResult(await restoreDraft({ environmentId, input: input() }));
    });
  const managerThreadId = manager?.threadId ?? null;
  const discuss = () => {
    if (managerThreadId === null) return;
    const target = scopeThreadRef(environmentId, managerThreadId);
    const store = useComposerDraftStore.getState();
    const existing = store.getComposerDraft(target)?.prompt ?? "";
    const prompt = discussPrompt({
      ...draft,
      title: title.trim() || draft.title,
      body: body.trim(),
      acceptanceCriteria: criteria,
    });
    // An unsent draft in the manager's thread is kept; the finding follows it.
    store.setPrompt(target, existing.trim() === "" ? prompt : `${existing}\n\n${prompt}`);
    onClose();
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(target) });
  };

  return (
    <Dialog
      open
      onOpenChange={(opened) => {
        if (!opened) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            {isFactory ? <FactoryIcon className="size-3.5" /> : <TicketIcon className="size-3.5" />}
            {isFactory ? "Factory finding" : "Retro finding"}
            {draft.state === "pending" ? null : (
              <Badge size="sm" variant={draft.state === "approved" ? "success" : "outline"}>
                {draft.state === "approved" ? (isFactory ? "Accepted" : "Approved") : "Dismissed"}
              </Badge>
            )}
          </p>
          <DialogTitle>{draft.title}</DialogTitle>
          <DialogDescription>
            {assignment
              ? `From the retro of ${assignment.title}`
              : draft.assignmentId === null
                ? "From the manager's retro"
                : "From an earlier assignment's retro"}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={disabled} className="grid gap-4">
            {editable ? (
              <>
                <IssueFormField label="Title" htmlFor="factory-draft-title">
                  <Input
                    id="factory-draft-title"
                    value={title}
                    aria-invalid={title.trim() === ""}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </IssueFormField>
                <IssueFormField label="Description" htmlFor="factory-draft-body">
                  <Textarea
                    id="factory-draft-body"
                    value={body}
                    aria-invalid={body.trim() === ""}
                    onChange={(event) => setBody(event.target.value)}
                  />
                </IssueFormField>
                <IssueFormField
                  label="Acceptance criteria"
                  htmlFor="factory-draft-criteria"
                  hint="One per line."
                >
                  <Textarea
                    id="factory-draft-criteria"
                    value={criteriaText}
                    onChange={(event) => setCriteriaText(event.target.value)}
                  />
                </IssueFormField>
              </>
            ) : (
              <>
                <p className="whitespace-pre-wrap text-sm">{draft.body || "No description."}</p>
                {draft.acceptanceCriteria.length ? (
                  <section className="grid gap-1">
                    <h3 className="text-sm font-medium">Acceptance criteria</h3>
                    <ul className="list-disc pl-5 text-sm">
                      {draft.acceptanceCriteria.map((criterion) => (
                        <li key={criterion}>{criterion}</li>
                      ))}
                    </ul>
                  </section>
                ) : null}
              </>
            )}
            {change ? (
              <section className="grid gap-2 border-t border-border/60 pt-3">
                <h3 className="text-sm font-medium">Proposed change · {change.label}</h3>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="grid gap-1">
                    <p className="text-xs text-muted-foreground">Before</p>
                    <p className="whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 font-mono text-xs">
                      {change.before}
                    </p>
                  </div>
                  <div className="grid gap-1">
                    <p className="text-xs text-muted-foreground">After</p>
                    <p className="whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 font-mono text-xs">
                      {change.after}
                    </p>
                  </div>
                </div>
                {change.applicable ? null : (
                  <p className="text-xs text-muted-foreground">
                    Edit the role file to apply this change.
                  </p>
                )}
              </section>
            ) : null}
            {draft.issue ? (
              <Button
                size="xs"
                variant="link"
                render={<a href={draft.issue.url} target="_blank" rel="noreferrer" />}
              >
                Filed as #{draft.issue.number}
                <ExternalLinkIcon />
              </Button>
            ) : null}
            {error ? (
              <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          {pending && canOperate ? (
            <Button variant="ghost" disabled={disabled} onClick={() => void dismiss()}>
              Dismiss
            </Button>
          ) : null}
          {draft.state === "dismissed" && canOperate ? (
            <Button disabled={disabled} onClick={() => void restore()}>
              Restore
            </Button>
          ) : null}
          {pending && isFactory && managerThreadId !== null ? (
            <Button variant="outline" disabled={busy} onClick={discuss}>
              Discuss with manager
            </Button>
          ) : null}
          {editable && dirty ? (
            <Button variant="outline" disabled={disabled || !complete} onClick={() => void save()}>
              Save
            </Button>
          ) : null}
          {pending && isFactory && change?.applicable && canApply ? (
            <Button disabled={disabled || !complete} onClick={() => void apply()}>
              Apply
            </Button>
          ) : null}
          {pending && !isFactory && canOperate ? (
            <Button disabled={disabled || !complete} onClick={() => void approve()}>
              Approve
            </Button>
          ) : null}
          {pending ? null : <Button onClick={onClose}>Close</Button>}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
