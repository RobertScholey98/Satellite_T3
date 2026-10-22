import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  FactoryWorkspaceAssignment,
  FactoryWorkspaceManager,
  ThreadId,
} from "@t3tools/contracts";
import { EllipsisIcon, FactoryIcon, UserCogIcon, UsersRoundIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { cn, randomUUID } from "~/lib/utils";
import { useProject } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "../chat/threadDetailsPanelStyles";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useFactoryWorkspaceFeed } from "./factoryWorkspaceState";
import { factoryEnvironment, factoryErrorMessage, unwrapFactoryResult } from "./factoryState";
import { useFactoryLeadActions } from "./FactoryThreadActions";
import {
  describePickupDecision,
  FACTORY_ASSIGNMENT_STATE_LABEL,
  FACTORY_MANAGER_STATE_LABEL,
  FACTORY_ROLE_LABEL,
  isLiveAssignment,
  resolveFactoryThreadPlace,
  takesAssignmentSlot,
} from "./factoryWorkspaceLogic";

/** The thread's place in the engineering factory, in its details panel; nothing for other threads. */
export function FactoryThreadRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const feed = useFactoryWorkspaceFeed(props.environmentId);
  const place = resolveFactoryThreadPlace(feed, props.threadId);
  if (!feed || !place) return null;
  return (
    <ThreadDetailsSection
      headingId="thread-details-factory-heading"
      title="Factory"
      data-thread-factory-panel
    >
      <ul className="m-0 list-none p-0">
        {place.kind === "manager" ? (
          <FactoryManagerRow
            environmentId={props.environmentId}
            manager={place.manager}
            assignments={feed.assignments.filter(
              (assignment) => assignment.managerId === place.manager.id,
            )}
          />
        ) : place.kind === "lead" && place.assignment !== null ? (
          <FactoryLeadRow
            environmentId={props.environmentId}
            threadId={props.threadId}
            manager={place.manager}
            assignment={place.assignment}
          />
        ) : (
          <FactoryRowLayout
            icon={<UsersRoundIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />}
            title={`${FACTORY_ROLE_LABEL[place.member.role]} for ${place.assignment?.title ?? place.manager.name}`}
            detail={null}
            menu={null}
          />
        )}
      </ul>
    </ThreadDetailsSection>
  );
}

function FactoryRowLayout(props: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly detail: string | null;
  readonly menu: ReactNode;
}) {
  return (
    <li
      className={cn(
        "group flex items-center rounded-lg py-1.5",
        THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
      )}
    >
      <span className="inline-flex size-4 shrink-0 items-center justify-center">{props.icon}</span>
      <Tooltip>
        <TooltipTrigger render={<div className="min-w-0 flex-1" />}>
          <span className="block truncate text-sm font-medium text-foreground/80">
            {props.title}
          </span>
          {props.detail === null ? null : (
            <p className="truncate text-2xs text-muted-foreground">{props.detail}</p>
          )}
        </TooltipTrigger>
        <TooltipPopup side="left">
          <p className="font-medium">{props.title}</p>
          {props.detail === null ? null : <p className="text-muted-foreground">{props.detail}</p>}
        </TooltipPopup>
      </Tooltip>
      {props.menu}
    </li>
  );
}

function RowMenu(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <ThreadDetailsControl
            size="icon-xs"
            variant="ghost"
            part="icon"
            aria-label={props.label}
          />
        }
      >
        <EllipsisIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end">{props.children}</MenuPopup>
    </Menu>
  );
}

function FactoryLeadRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly manager: FactoryWorkspaceManager;
  readonly assignment: FactoryWorkspaceAssignment;
}) {
  const project = useProject(scopeProjectRef(props.environmentId, props.manager.projectId));
  const actions = useFactoryLeadActions(props.environmentId, props.threadId);
  const owner = project?.title ?? props.manager.name;
  const title = actions.takenOver
    ? "Taken over by you"
    : `Lead for ${owner} manager · ${FACTORY_ASSIGNMENT_STATE_LABEL[props.assignment.state]}`;
  const live = isLiveAssignment(props.assignment);
  return (
    <>
      <FactoryRowLayout
        icon={<FactoryIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />}
        title={title}
        detail="Can't merge or edit control files"
        menu={
          live ? (
            <RowMenu label="Factory lead actions">
              {actions.takenOver ? (
                <MenuItem disabled={!actions.canHandBack} onClick={() => void actions.handBack()}>
                  Hand back
                </MenuItem>
              ) : (
                <MenuItem disabled={!actions.canTakeOver} onClick={() => void actions.takeOver()}>
                  Take over
                </MenuItem>
              )}
              <MenuSeparator />
              <MenuItem
                variant="destructive"
                disabled={!actions.canCancel}
                onClick={actions.requestCancel}
              >
                Cancel assignment
              </MenuItem>
            </RowMenu>
          ) : null
        }
      />
      {actions.cancelDialog}
    </>
  );
}

function FactoryManagerRow(props: {
  readonly environmentId: EnvironmentId;
  readonly manager: FactoryWorkspaceManager;
  readonly assignments: ReadonlyArray<FactoryWorkspaceAssignment>;
}) {
  const { environmentId, manager } = props;
  const getConfig = useAtomCommand(factoryEnvironment.getConfig, { reportFailure: false });
  const listLog = useAtomCommand(factoryEnvironment.listLog, { reportFailure: false });
  const pauseCommand = useAtomCommand(factoryEnvironment.pauseManager, { reportFailure: false });
  const resumeCommand = useAtomCommand(factoryEnvironment.resumeManager, {
    reportFailure: false,
  });
  const retireCommand = useAtomCommand(factoryEnvironment.retireManager, {
    reportFailure: false,
  });
  const canPause = useAtomValue(factoryEnvironment.pauseManager.permissionAtom(environmentId));
  const canResume = useAtomValue(factoryEnvironment.resumeManager.permissionAtom(environmentId));
  const canRetire = useAtomValue(factoryEnvironment.retireManager.permissionAtom(environmentId));
  const [cap, setCap] = useState<{ readonly key: string; readonly value: number } | null>(null);
  const [pickup, setPickup] = useState<{ readonly key: string; readonly text: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  const running = props.assignments.filter(takesAssignmentSlot).length;
  const active = props.assignments.filter(isLiveAssignment).length;
  const capKey = `${environmentId}\n${manager.projectId}`;
  // Pickups start assignments and move the manager's state; this key reloads the log on either.
  const logKey = `${environmentId}\n${manager.id}\n${manager.state}\n${props.assignments.length}`;

  useEffect(() => {
    let current = true;
    void getConfig({ environmentId, input: { projectId: manager.projectId } }).then((result) => {
      if (current && result._tag === "Success")
        setCap({ key: capKey, value: result.value.effective.concurrencyCap });
    });
    return () => {
      current = false;
    };
  }, [environmentId, manager.projectId, capKey, getConfig]);

  useEffect(() => {
    let current = true;
    void listLog({ environmentId, input: { managerId: manager.id, limit: 100 } }).then((result) => {
      if (!current || result._tag !== "Success") return;
      const entry = result.value.find((row) => row.kind === "pickup" || row.kind === "skip");
      setPickup({
        key: logKey,
        text: entry ? describePickupDecision(entry) : "No pickup decisions yet",
      });
    });
    return () => {
      current = false;
    };
  }, [environmentId, manager.id, logKey, listLog]);

  const run = async (title: string, request: () => Promise<unknown>) => {
    setBusy(true);
    let failure: unknown = null;
    await request().catch((error: unknown) => {
      failure = error;
    });
    setBusy(false);
    const description = failure === null ? null : factoryErrorMessage(failure);
    if (description) toastManager.add({ type: "error", title, description });
  };
  const pause = (scope: "manager" | "project") =>
    void run("Could not pause the manager", async () =>
      unwrapFactoryResult(
        await pauseCommand({
          environmentId,
          input: { requestId: randomUUID(), managerId: manager.id, scope },
        }),
      ),
    );
  const resume = () =>
    void run("Could not resume the manager", async () =>
      unwrapFactoryResult(
        await resumeCommand({
          environmentId,
          input: { requestId: randomUUID(), managerId: manager.id },
        }),
      ),
    );
  const retire = async () => {
    const message = `Retire ${manager.name}?\nThe project can then get a new engineering manager.`;
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return;
    await run("Could not retire the manager", async () =>
      unwrapFactoryResult(
        await retireCommand({
          environmentId,
          input: { requestId: randomUUID(), managerId: manager.id },
        }),
      ),
    );
  };

  const paused = manager.state === "manager-paused" || manager.state === "project-paused";
  const capText = cap?.key === capKey ? ` of ${cap.value}` : "";
  const retireBlocked = active > 0;
  const retireItem = (
    <MenuItem
      variant="destructive"
      className={retireBlocked ? "data-disabled:pointer-events-auto" : undefined}
      disabled={busy || !canRetire || retireBlocked}
      onClick={() => void retire()}
    >
      Retire
    </MenuItem>
  );
  return (
    <FactoryRowLayout
      icon={<UserCogIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />}
      title={`${FACTORY_MANAGER_STATE_LABEL[manager.state]} · ${running}${capText} running`}
      detail={pickup?.key === logKey ? pickup.text : null}
      menu={
        <RowMenu label="Engineering manager actions">
          <MenuItem
            disabled={
              busy || !canPause || (manager.state !== "onboarding" && manager.state !== "active")
            }
            onClick={() => pause("manager")}
          >
            Pause manager
          </MenuItem>
          <MenuItem
            disabled={busy || !canPause || manager.state === "project-paused"}
            onClick={() => pause("project")}
          >
            Pause manager and teams
          </MenuItem>
          <MenuItem disabled={busy || !canResume || !paused} onClick={resume}>
            Resume
          </MenuItem>
          <MenuSeparator />
          {retireBlocked ? (
            <Tooltip>
              <TooltipTrigger render={retireItem} />
              <TooltipPopup side="left">Finish or cancel its assignments first</TooltipPopup>
            </Tooltip>
          ) : (
            retireItem
          )}
        </RowMenu>
      }
    />
  );
}
