import type { FactoryManager, ThreadId } from "@t3tools/contracts";
import { useId, useState } from "react";
import type { FactoryEnvironmentView } from "../../state/factory";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { FactoryCollaborationCreate } from "./FactoryCollaborationCreate";
import { FactoryCollaborationDecisions } from "./FactoryCollaborationDecisions";
import { FactoryCollaborationIncidents } from "./FactoryCollaborationIncidents";
import { FactoryCollaborationRequest } from "./FactoryCollaborationRequest";

export function FactoryCollaborationDialog({
  environment,
  manager,
  canOpenThread,
  onOpenThread,
  onClose,
}: {
  environment: FactoryEnvironmentView;
  manager: FactoryManager;
  canOpenThread: (id: ThreadId) => boolean;
  onOpenThread: (id: ThreadId) => void;
  onClose: () => void;
}) {
  const prefix = useId();
  const [view, setView] = useState<"requests" | "create" | "decisions" | "incidents">("requests");
  const [filter, setFilter] = useState<"all" | "incoming" | "outgoing">("all");
  const [limit, setLimit] = useState(30);
  const requests =
    environment.data?.crossProjectRequests.filter(
      (entry) => entry.originManagerId === manager.id || entry.receiverManagerId === manager.id,
    ) ?? [];
  const visible = requests
    .filter(
      (entry) =>
        filter === "all" ||
        (filter === "incoming"
          ? entry.receiverManagerId === manager.id
          : entry.originManagerId === manager.id),
    )
    .toReversed();
  const pending =
    environment.data?.collaborationDecisions.filter(
      (entry) =>
        entry.resolution.phase === "pending" &&
        entry.requestIds.some((id) => requests.some((request) => request.id === id)),
    ).length ?? 0;
  const views = [
    { value: "requests", label: `Work requests (${requests.length})` },
    { value: "create", label: "Request supporting work" },
    { value: "decisions", label: `Consolidated decisions (${pending} pending)` },
    { value: "incidents", label: "Incident restrictions" },
  ] as const;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Project collaboration</DialogTitle>
          <DialogDescription>
            {manager.name} · {environment.label}. Peer managers coordinate outcomes; implementation
            teams own their technical work and PR reviews.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            {!environment.connected || !environment.canOperate ? (
              <p role="status" className="text-sm text-muted-foreground">
                {!environment.connected
                  ? "Reconnect to update collaboration."
                  : "This connection can inspect collaboration but cannot change it."}
              </p>
            ) : null}
            <Label htmlFor={`${prefix}-view`}>Collaboration area</Label>
            <Select
              value={view}
              items={views}
              onValueChange={(value) => {
                if (value) setView(value);
              }}
            >
              <SelectTrigger id={`${prefix}-view`}>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {views.map((entry) => (
                  <SelectItem key={entry.value} value={entry.value}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {view === "create" ? (
              <FactoryCollaborationCreate
                environment={environment}
                manager={manager}
                onCreated={() => setView("requests")}
              />
            ) : null}
            {view === "requests" ? (
              <div className="space-y-3">
                <Label htmlFor={`${prefix}-filter`}>Request direction</Label>
                <Select
                  value={filter}
                  items={[
                    { value: "all", label: "Incoming and outgoing" },
                    { value: "incoming", label: "Incoming requests" },
                    { value: "outgoing", label: "Outgoing requests" },
                  ]}
                  onValueChange={(value) => {
                    if (value) {
                      setFilter(value);
                      setLimit(30);
                    }
                  }}
                >
                  <SelectTrigger id={`${prefix}-filter`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="all">Incoming and outgoing</SelectItem>
                    <SelectItem value="incoming">Incoming requests</SelectItem>
                    <SelectItem value="outgoing">Outgoing requests</SelectItem>
                  </SelectPopup>
                </Select>
                {visible.slice(0, limit).map((request) => (
                  <FactoryCollaborationRequest
                    key={`${request.id}:${request.generation}`}
                    environment={environment}
                    manager={manager}
                    request={request}
                    canOpenThread={canOpenThread}
                    onOpenThread={onOpenThread}
                  />
                ))}
                {!visible.length ? (
                  <p className="text-sm text-muted-foreground">
                    No {filter === "all" ? "cross-project" : filter} work requests. Start from an
                    existing implementation or shared-process investigation.
                  </p>
                ) : null}
                {visible.length > limit ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setLimit((previous) => previous + 30)}
                  >
                    Show more requests
                  </Button>
                ) : null}
              </div>
            ) : null}
            {view === "decisions" ? (
              <FactoryCollaborationDecisions environment={environment} requests={requests} />
            ) : null}
            {view === "incidents" ? (
              <FactoryCollaborationIncidents environment={environment} manager={manager} />
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
