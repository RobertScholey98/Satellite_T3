import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type EnvironmentId,
  type IssueBoardItem,
  type IssueBoardSummary,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { randomUUID } from "~/lib/utils";
import { getCustomModelOptionsByInstance } from "~/modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "~/providerInstances";
import { useProjects, waitForThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { buildThreadRouteParams } from "~/threadRoutes";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { scheduledTaskDefaultModel } from "../settings/scheduledTasksSettings.logic";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { IssueFormField } from "./IssueBoardConfigurationDialog";
import {
  IssueRequestError,
  issueErrorMessage,
  issuesEnvironment,
  unwrapIssueResult,
} from "./issuesState";
import { branchNameProblem } from "./issuesViewState";

/**
 * Starts a ticket into a new worktree thread on the environment whose board is open. The server
 * creates the attempt and launches the thread in one call.
 */
export function IssueStartDialog({
  environmentId,
  board,
  item,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly board: IssueBoardSummary;
  readonly item: IssueBoardItem;
  readonly onClose: () => void;
}) {
  const navigate = useNavigate();
  const allProjects = useProjects();
  const projects = allProjects.filter(
    (project) => project.environmentId === environmentId && project.isScratch !== true,
  );
  // Kept across presses so a double press or a retry after reconnecting replays the same start; a
  // definite refusal from the server frees the next press to start afresh.
  const [requestId, setRequestId] = useState(randomUUID);
  const [projectId, setProjectId] = useState<ProjectId>(board.projectId);
  const project = projects.find((candidate) => candidate.id === projectId);
  const [branch, setBranch] = useState(`issue-${item.issue.ref.number}`);
  const [baseRef, setBaseRef] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(`Work on #${item.issue.ref.number} ${item.issue.title}.`);
  const [modelChoice, setModelChoice] = useState<ModelSelection | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const defaultRef = useEnvironmentQuery(
    project
      ? vcsEnvironment.listRefs({
          environmentId,
          input: { cwd: project.workspaceRoot, refKind: "local", limit: 100 },
        })
      : null,
  ).data?.refs.find((ref) => ref.isDefault)?.name;
  const effectiveBaseRef = baseRef ?? defaultRef ?? "main";

  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(providers),
      settings,
      project?.id ?? null,
    ),
  );
  const selection =
    modelChoice &&
    instanceEntries.some((entry) => entry.instanceId === modelChoice.instanceId && entry.enabled)
      ? modelChoice
      : scheduledTaskDefaultModel(settings, project ?? null, instanceEntries);
  const activeInstanceId =
    selection?.instanceId ?? instanceEntries[0]?.instanceId ?? ("" as ProviderInstanceId);
  const activeModel = selection?.model ?? "";
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    activeInstanceId,
    activeModel,
  );

  const startAttempt = useAtomCommand(issuesEnvironment.startAttempt, { reportFailure: false });
  const branchProblem = branchNameProblem(branch);
  const baseRefProblem = effectiveBaseRef.trim() ? null : "Enter a base branch.";
  const ready =
    project !== undefined &&
    selection !== null &&
    branchProblem === null &&
    baseRefProblem === null &&
    prompt.trim() !== "";

  const start = async () => {
    if (!ready || !project || !selection || inFlight.current) return;
    inFlight.current = true;
    setStarting(true);
    setError(null);
    try {
      const result = unwrapIssueResult(
        await startAttempt({
          environmentId,
          input: {
            requestId,
            boardId: board.id,
            issue: item.issue.ref,
            projectId: project.id,
            prompt: prompt.trim(),
            branch: branch.trim(),
            baseRef: effectiveBaseRef.trim(),
            modelSelection: selection,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          },
        }),
      );
      const threadRef = scopeThreadRef(environmentId, result.threadId);
      // The thread route sends a thread the client has not received yet back to "/".
      await waitForThreadShell(threadRef, 10_000);
      onClose();
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
    } catch (failure) {
      inFlight.current = false;
      setStarting(false);
      setError(issueErrorMessage(failure));
      if (
        failure instanceof IssueRequestError &&
        failure.reason !== "other" &&
        failure.reason !== "interrupted"
      ) {
        setRequestId(randomUUID());
      }
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(opened) => {
        if (!opened && !starting) onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Start #{item.issue.ref.number}</DialogTitle>
          <DialogDescription>{item.issue.title}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={starting} className="grid gap-4">
            <IssueFormField label="Project" htmlFor="issue-start-project">
              <Select
                value={projectId}
                onValueChange={(next) => {
                  if (typeof next === "string") {
                    setProjectId(next as ProjectId);
                    setBaseRef(null);
                  }
                }}
              >
                <SelectTrigger id="issue-start-project" size="sm">
                  <SelectValue placeholder="Choose a project">{project?.title}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {projects.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id} label={candidate.title}>
                      {candidate.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </IssueFormField>
            <div className="grid gap-3 sm:grid-cols-2">
              <IssueFormField
                label="Worktree branch"
                htmlFor="issue-start-branch"
                hint={branchProblem ?? undefined}
              >
                <Input
                  id="issue-start-branch"
                  value={branch}
                  aria-invalid={branchProblem !== null}
                  onChange={(event) => setBranch(event.target.value)}
                />
              </IssueFormField>
              <IssueFormField
                label="Base branch"
                htmlFor="issue-start-base"
                hint={baseRefProblem ?? undefined}
              >
                <Input
                  id="issue-start-base"
                  value={effectiveBaseRef}
                  aria-invalid={baseRefProblem !== null}
                  onChange={(event) => setBaseRef(event.target.value)}
                />
              </IssueFormField>
            </div>
            <IssueFormField label="Model">
              <div>
                <ProviderModelPicker
                  environmentId={environmentId}
                  disabled={starting}
                  activeInstanceId={activeInstanceId}
                  model={activeModel}
                  lockedProvider={null}
                  instanceEntries={instanceEntries}
                  modelOptionsByInstance={modelOptionsByInstance}
                  isComposerOwned={false}
                  onInstanceModelChange={(instanceId, model) =>
                    setModelChoice({ instanceId, model })
                  }
                />
              </div>
            </IssueFormField>
            <IssueFormField
              label="Prompt"
              htmlFor="issue-start-prompt"
              hint="The ticket's title and body are attached to this first message."
            >
              <Textarea
                id="issue-start-prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </IssueFormField>
            {!project ? (
              <p role="alert" className="text-sm text-destructive">
                Choose a project on this computer to start the ticket in.
              </p>
            ) : null}
            {selection === null ? (
              <p role="alert" className="text-sm text-destructive">
                No model is available on this computer. Set up a provider first.
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={starting} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ready || starting} onClick={() => void start()}>
            {starting ? "Starting…" : "Start"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
