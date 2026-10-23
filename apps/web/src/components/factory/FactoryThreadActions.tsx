import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useId, useState } from "react";

import { randomUUID } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";
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
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { useFactoryWorkspaceFeed } from "./factoryWorkspaceState";
import { factoryEnvironment, factoryErrorMessage, unwrapFactoryResult } from "./factoryState";
import { resolveFactoryThreadPlace } from "./factoryWorkspaceLogic";

/**
 * What the user can do to a managed lead's thread: take it over, hand it back, or cancel its
 * assignment with a reason. Shared by the details panel's Factory row and the ticket chip.
 */
export function useFactoryLeadActions(environmentId: EnvironmentId, threadId: ThreadId) {
  const feed = useFactoryWorkspaceFeed(environmentId);
  const place = resolveFactoryThreadPlace(feed, threadId);
  const takeOverCommand = useAtomCommand(factoryEnvironment.takeOver, { reportFailure: false });
  const handBackCommand = useAtomCommand(factoryEnvironment.handBack, { reportFailure: false });
  const cancelCommand = useAtomCommand(factoryEnvironment.cancelAssignment, {
    reportFailure: false,
  });
  const canTakeOver = useAtomValue(factoryEnvironment.takeOver.permissionAtom(environmentId));
  const canHandBack = useAtomValue(factoryEnvironment.handBack.permissionAtom(environmentId));
  const canCancel = useAtomValue(factoryEnvironment.cancelAssignment.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

  const lead =
    place?.kind === "lead" && place.assignment !== null
      ? { member: place.member, assignment: place.assignment, manager: place.manager }
      : null;
  const live =
    lead !== null && lead.assignment.state !== "completed" && lead.assignment.state !== "cancelled";

  const run = async (title: string, request: () => Promise<unknown>) => {
    setBusy(true);
    let failure: unknown = null;
    await request().catch((error: unknown) => {
      failure = error;
    });
    setBusy(false);
    const description = failure === null ? null : factoryErrorMessage(failure);
    if (description) toastManager.add({ type: "error", title, description });
    return failure === null;
  };

  const takeOver = () =>
    run("Could not take over the thread", async () =>
      unwrapFactoryResult(
        await takeOverCommand({ environmentId, input: { requestId: randomUUID(), threadId } }),
      ),
    );
  const handBack = () =>
    run("Could not hand the thread back", async () =>
      unwrapFactoryResult(
        await handBackCommand({ environmentId, input: { requestId: randomUUID(), threadId } }),
      ),
    );
  const cancel = (assignmentId: string, reason: string) =>
    run("Could not cancel the assignment", async () =>
      unwrapFactoryResult(
        await cancelCommand({
          environmentId,
          input: { requestId: randomUUID(), assignmentId, reason },
        }),
      ),
    );

  const cancelDialog =
    lead === null ? null : (
      <FactoryCancelAssignmentDialog
        open={cancelOpen}
        title={lead.assignment.title}
        busy={busy}
        onOpenChange={setCancelOpen}
        onConfirm={async (reason) => {
          if (await cancel(lead.assignment.id, reason)) setCancelOpen(false);
        }}
      />
    );

  return {
    lead: live ? lead : null,
    takenOver: lead?.member.takenOver === true,
    busy,
    canTakeOver: canTakeOver && !busy,
    canHandBack: canHandBack && !busy,
    canCancel: canCancel && !busy,
    takeOver,
    handBack,
    requestCancel: () => setCancelOpen(true),
    cancelDialog,
  };
}

function FactoryCancelAssignmentDialog(props: {
  readonly open: boolean;
  readonly title: string;
  readonly busy: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: (reason: string) => Promise<void>;
}) {
  const id = useId();
  const [reason, setReason] = useState("");
  const trimmed = reason.trim();
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="sm:max-w-md">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed === "" || props.busy) return;
            void props.onConfirm(trimmed);
          }}
        >
          <DialogHeader>
            <DialogTitle>Cancel assignment</DialogTitle>
            <DialogDescription>
              The team stops work on “{props.title}”. The manager reads your reason.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-reason`}>Reason</Label>
              <Textarea
                id={`${id}-reason`}
                value={reason}
                maxLength={2000}
                placeholder="Why this work should stop"
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>
              Keep working
            </Button>
            <Button type="submit" variant="destructive" disabled={trimmed === "" || props.busy}>
              Cancel assignment
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
