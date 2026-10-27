import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { UserCogIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { useEnvironment } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { ComposerContextLabel } from "../ComposerContextLabel";
import { ComposerControl, ComposerControlIcon } from "../chat/ComposerControl";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { factoryEnvironment, supportsFactory } from "./factoryState";
import { setFactoryManagerDraft, useFactoryManagerDraft } from "./factoryWorkspaceState";

/**
 * Turns a new-thread draft into a new engineering manager: the composer then takes the manager's
 * name.
 */
export function FactoryManagerToggle(props: {
  readonly environmentId: EnvironmentId;
  readonly draftId: string;
}) {
  const environment = useEnvironment(props.environmentId);
  const available = supportsFactory(environment ?? undefined);
  const canCreate = useAtomValue(
    factoryEnvironment.createManager.permissionAtom(props.environmentId),
  );
  const on = useFactoryManagerDraft(props.draftId);
  const disabled = !canCreate;

  // oxlint-disable-next-line t3code/react-effect-budget -- Clear the shared manager-draft flag when this connection loses create permission, so the headline and send path read it off too.
  useEffect(() => {
    if (on && disabled) setFactoryManagerDraft(props.draftId, false);
  }, [on, disabled, props.draftId]);

  if (!available) return null;
  const pressed = on && !disabled;
  const tooltip = canCreate
    ? "Create an engineering manager"
    : "This connection cannot create engineering managers";
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="inline-flex shrink-0" data-composer-context-control />}
      >
        <ComposerControl
          size="xs"
          aria-label="Create an engineering manager"
          aria-pressed={pressed}
          disabled={disabled}
          onClick={() => setFactoryManagerDraft(props.draftId, !pressed)}
        >
          <ComposerControlIcon
            icon={UserCogIcon}
            size="xs"
            className={cn(pressed && "text-primary")}
          />
          {/* Named while on, like the strip's other controls, so the mode shows on the control itself. */}
          {pressed ? <ComposerContextLabel>Engineering manager</ComposerContextLabel> : null}
        </ComposerControl>
      </TooltipTrigger>
      <TooltipPopup>{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

const modelKey = (instanceId: string, model: string) => `${instanceId}\n${model}`;

/**
 * While a draft names a new manager, the model picker offers only the factory's model pool for
 * the project. Elsewhere it returns the composer's own rule unchanged.
 */
export function useFactoryManagerModelDisabledReason(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly draftId: string | null;
  readonly base: (instanceId: ProviderInstanceId, model: string) => string | null;
}) {
  const on = useFactoryManagerDraft(input.draftId);
  const getConfig = useAtomCommand(factoryEnvironment.getConfig, { reportFailure: false });
  const [pool, setPool] = useState<{
    readonly key: string;
    readonly models: ReadonlySet<string>;
  } | null>(null);
  const poolKey = `${input.environmentId}\n${input.projectId ?? ""}`;
  const projectId = input.projectId;

  // oxlint-disable-next-line t3code/react-effect-budget -- Fetch the project's model pool while the toggle is on, dropping a reply that arrives after the project changes or unmounts.
  useEffect(() => {
    if (!on || projectId === null) return;
    let current = true;
    void getConfig({ environmentId: input.environmentId, input: { projectId } }).then((result) => {
      if (!current || result._tag !== "Success") return;
      setPool({
        key: poolKey,
        models: new Set(
          result.value.effective.modelPool.map((model) => modelKey(model.instanceId, model.model)),
        ),
      });
    });
    return () => {
      current = false;
    };
  }, [on, projectId, input.environmentId, poolKey, getConfig]);

  const models = on && pool?.key === poolKey ? pool.models : null;
  const base = input.base;
  // An empty pool starts no manager; the server says so on send.
  if (models === null || models.size === 0) return base;
  return (instanceId: ProviderInstanceId, model: string) =>
    models.has(modelKey(instanceId, model))
      ? base(instanceId, model)
      : "Not in the factory's model pool";
}
