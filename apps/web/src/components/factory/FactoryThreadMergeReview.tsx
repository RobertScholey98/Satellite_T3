import type { FactoryAssignment, ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";
import { useFactoryEnvironments, type FactoryEnvironmentView } from "../../state/factory";
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
import { Badge } from "../ui/badge";
import { FactoryMergeReview, FactoryMergeThreadLink } from "./FactoryMergeReview";
import { factoryMergeOperationAlert } from "./FactoryMergeReadModel";

export function FactoryThreadMergeReview({ threadRef }: { threadRef: ScopedThreadRef }) {
  const environments = useFactoryEnvironments();
  const environment = environments.find((entry) => entry.environmentId === threadRef.environmentId);
  const assignment = environment?.data?.assignments.find(
    (entry) => entry.threadId === threadRef.threadId,
  );
  if (!environment || !assignment) return null;
  return (
    <ThreadReview
      key={`${threadRef.environmentId}:${assignment.id}`}
      environment={environment}
      assignment={assignment}
    />
  );
}

function ThreadReview({
  environment,
  assignment,
}: {
  environment: FactoryEnvironmentView;
  assignment: FactoryAssignment;
}) {
  const [open, setOpen] = useState(false);
  const group = environment.data?.mergeGroups.find(
    (entry) =>
      entry.integrationAssignmentId === assignment.id ||
      entry.memberAssignmentIds.includes(assignment.id),
  );
  const integrationLead = environment.data?.assignments.find(
    (entry) => entry.id === group?.integrationAssignmentId,
  );
  if (!group || !integrationLead) return null;
  const alert = environment.data ? factoryMergeOperationAlert(environment.data, group.id) : null;
  const alertBadge = alert ? (
    <Badge size="sm" variant="warning">
      {alert}
    </Badge>
  ) : null;
  if (group.integrationAssignmentId !== assignment.id)
    return (
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <span className="text-xs text-muted-foreground">This PR is part of a shared delivery.</span>
        {alertBadge}
        <FactoryMergeThreadLink environment={environment} threadId={integrationLead.threadId}>
          Open combined review conversation
        </FactoryMergeThreadLink>
      </div>
    );
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
        <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          Integration review · {group.memberAssignmentIds.length} linked implementations
          {alertBadge}
        </span>
        <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
          Review combined feature
        </Button>
      </div>
      {open ? (
        <Dialog open onOpenChange={setOpen}>
          <DialogPopup className="sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>Combined feature review</DialogTitle>
              <DialogDescription>
                Review all linked PRs with the integration lead. Corrections stay with their owning
                teams.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <FactoryMergeReview environment={environment} groupId={group.id} />
            </DialogPanel>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Close
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      ) : null}
    </>
  );
}
