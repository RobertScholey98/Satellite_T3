import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, FactoryManager } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon } from "lucide-react";
import { Fragment } from "react";

import { cn, randomUUID } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import {
  factoryEnvironment,
  factoryErrorMessage,
  unwrapFactoryResult,
  useFactoryAssignments,
  useFactoryManagerCap,
} from "./factoryState";
import {
  managerStatusActions,
  managerStatusText,
  managerStatusTone,
  runningAssignmentCount,
} from "./FactoryTriageState";

/**
 * The project manager's state beside the board's sync status, with a state dot. It opens the
 * manager's controls: pause, resume, its thread, and the factory settings.
 */
export function FactoryIssuesManagerStatus({
  environmentId,
  manager,
  connected,
}: {
  readonly environmentId: EnvironmentId;
  readonly manager: FactoryManager;
  readonly connected: boolean;
}) {
  const navigate = useNavigate();
  const canOperate = useAtomValue(factoryEnvironment.pauseManager.permissionAtom(environmentId));
  const pauseManager = useAtomCommand(factoryEnvironment.pauseManager, { reportFailure: false });
  const resumeManager = useAtomCommand(factoryEnvironment.resumeManager, { reportFailure: false });
  const running = runningAssignmentCount(useFactoryAssignments(environmentId), manager.id);

  const cap = useFactoryManagerCap(environmentId, manager.id);

  const tone = managerStatusTone(manager.state);
  const actions = managerStatusActions(manager.state);
  const perform = async (title: string, request: () => Promise<unknown>) => {
    try {
      await request();
    } catch (failure) {
      const description = factoryErrorMessage(failure);
      if (description !== null) toastManager.add({ type: "error", title, description });
    }
  };
  const pause = (scope: "manager" | "project") =>
    perform("Could not pause the manager", async () =>
      unwrapFactoryResult(
        await pauseManager({
          environmentId,
          input: { requestId: randomUUID(), managerId: manager.id, scope },
        }),
      ),
    );
  const resume = () =>
    perform("Could not resume the manager", async () =>
      unwrapFactoryResult(
        await resumeManager({
          environmentId,
          input: { requestId: randomUUID(), managerId: manager.id },
        }),
      ),
    );
  const threadId = manager.threadId;
  const operable = canOperate && connected;

  return (
    <Menu>
      <MenuTrigger
        render={<Button size="xs" variant="outline" aria-label={`${manager.name} status`} />}
      >
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            tone === "success" && "bg-success",
            tone === "info" && "bg-info",
            tone === "muted" && "bg-muted-foreground/60",
          )}
        />
        {managerStatusText(manager, running, cap === null ? null : cap.cap)}
        <ChevronDownIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="start">
        {actions.map(({ action, label }, index) => (
          <Fragment key={action}>
            {/* Resume and a further pause go opposite ways, so they don't read as one group. */}
            {index > 0 && actions[index - 1]?.action === "resume" ? <MenuSeparator /> : null}
            <MenuItem
              disabled={!operable}
              onClick={() =>
                void (action === "resume"
                  ? resume()
                  : pause(action === "pause-manager" ? "manager" : "project"))
              }
            >
              {label}
            </MenuItem>
          </Fragment>
        ))}
        {actions.length === 0 ? null : <MenuSeparator />}
        {threadId ? (
          <MenuItem
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
              })
            }
          >
            Open manager thread
          </MenuItem>
        ) : null}
        <MenuItem onClick={() => void navigate({ to: "/factory" })}>Factory settings</MenuItem>
      </MenuPopup>
    </Menu>
  );
}
