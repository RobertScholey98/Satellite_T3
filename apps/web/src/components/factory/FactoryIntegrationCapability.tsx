import {
  AuthSettingsWriteScope,
  type FactoryIntegrationCapability as Capability,
  type FactoryManager,
} from "@t3tools/contracts";
import { useId, useState } from "react";
import type { FactoryEnvironmentView } from "../../state/factory";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import {
  FactoryIntegrationPathsEditor,
  emptyIntegrationPaths,
  normalizeIntegrationPaths,
  validIntegrationPaths,
} from "./FactoryIntegrationPaths";
import { useFactoryCommand } from "./useFactoryCommand";

export function FactoryIntegrationCapability({
  environment,
  manager,
}: {
  environment: FactoryEnvironmentView;
  manager: FactoryManager;
}) {
  const current = environment.data?.integrationCapabilities.findLast(
    (entry) => entry.projectId === manager.projectId && entry.supersededBy === null,
  );
  return (
    <CapabilityForm
      key={`${manager.projectId}:${current?.id ?? "new"}`}
      environment={environment}
      manager={manager}
      current={current}
    />
  );
}

function CapabilityForm({
  environment,
  manager,
  current,
}: {
  environment: FactoryEnvironmentView;
  manager: FactoryManager;
  current: Capability | undefined;
}) {
  const prefix = useId();
  const allowed = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const command = useFactoryCommand(environment, allowed);
  const boundary = environment.data?.boundaries.findLast(
    (entry) => entry.projectId === manager.projectId,
  );
  const [paths, setPaths] = useState(current?.paths ?? emptyIntegrationPaths);
  const [entrypoint, setEntrypoint] = useState(current?.coordinator?.entrypoint ?? "");
  const [args, setArgs] = useState(current?.coordinator?.args.join("\n") ?? "");
  const normalized = normalizeIntegrationPaths(paths);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Human setup classifies this project's integration access. Its manager can later grant a
        subset to an integration team. Replacing a capability invalidates old grants; owners must
        grant access again before an explicit refresh.
      </p>
      {!allowed ? (
        <p role="status" className="text-sm">
          Settings permission is required to change this capability.
        </p>
      ) : null}
      {!boundary ? (
        <p role="status" className="text-sm">
          Configure this project's execution boundary first.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground break-all">Boundary: {boundary.id}</p>
      )}
      {current ? (
        <div className="space-y-1 text-sm">
          <p>Capability: {current.qualification.status}</p>
          {current.qualification.status === "unavailable" ? (
            <>
              <p role="alert">{current.qualification.reason}</p>
              <Button
                size="sm"
                disabled={command.disabled}
                onClick={() =>
                  void command.submit({
                    type: "integration.capability.retry",
                    capabilityId: current.id,
                  })
                }
              >
                Retry qualification
              </Button>
            </>
          ) : null}
          {current.qualification.status === "qualified" ? (
            <p className="break-all text-xs text-muted-foreground">
              Configuration digest: {current.qualification.configurationDigest}
            </p>
          ) : null}
        </div>
      ) : null}
      <FactoryIntegrationPathsEditor
        value={paths}
        onChange={setPaths}
        disabled={command.disabled}
      />
      <div className="space-y-1.5">
        <Label htmlFor={`${prefix}-coordinator`}>Protected Node coordinator (optional)</Label>
        <Input
          id={`${prefix}-coordinator`}
          value={entrypoint}
          disabled={command.disabled}
          onChange={(event) => setEntrypoint(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Exact protected relative file. The host runs it with /usr/local/bin/node. At least one
          participant needs a qualified coordinator to verify the group.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${prefix}-args`}>Coordinator arguments, one per line</Label>
        <Textarea
          id={`${prefix}-args`}
          value={args}
          disabled={command.disabled}
          onChange={(event) => setArgs(event.target.value)}
        />
      </div>
      {command.error ? (
        <p role="alert" className="text-sm text-destructive">
          {command.error}
        </p>
      ) : null}
      <Button
        disabled={
          command.disabled ||
          !boundary ||
          manager.projectId === null ||
          !validIntegrationPaths(normalized)
        }
        onClick={() => {
          if (boundary && manager.projectId)
            void command.submit({
              type: "integration.capability.configure",
              projectId: manager.projectId,
              boundaryId: boundary.id,
              paths: normalized,
              coordinator: entrypoint.trim()
                ? {
                    executable: "/usr/local/bin/node",
                    entrypoint: entrypoint.trim(),
                    args: args.split(/\r?\n/).filter(Boolean),
                    timeoutMs: current?.coordinator?.timeoutMs ?? 120000,
                  }
                : null,
            });
        }}
      >
        {command.pending ? "Saving…" : "Save and qualify capability"}
      </Button>
    </div>
  );
}
