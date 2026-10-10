import {
  AuthSettingsWriteScope,
  type FactoryManager,
  type FactoryProjectMergeRule,
} from "@t3tools/contracts";
import { useId, useState } from "react";

import type { FactoryEnvironmentView } from "../../state/factory";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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
import { Label } from "../ui/label";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";
import { Textarea } from "../ui/textarea";
import { useFactoryCommand } from "./useFactoryCommand";
import { FactoryTrackerSettings } from "./FactoryTrackerSettings";

function lines(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function relativePath(value: string) {
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    !/[\\:*?]/.test(value) &&
    !value.includes("\0") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

export function FactoryDeliverySettings({
  environment,
  manager,
  onClose,
}: {
  environment: FactoryEnvironmentView;
  manager: FactoryManager;
  onClose: () => void;
}) {
  const prefix = useId();
  const settingsScope = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const command = useFactoryCommand(environment, settingsScope && manager.projectId !== null);
  const currentRule = environment.data?.mergeRules
    .toSorted((a, b) => b.version - a.version)
    .find((entry) => entry.projectId === manager.projectId);
  const currentPreview = environment.data?.previewConfigurations.findLast(
    (entry) => entry.projectId === manager.projectId,
  );
  const currentPublication = environment.data?.previewPublicationPolicies.find(
    (entry) => entry.projectId === manager.projectId,
  );
  const [enabled, setEnabled] = useState(currentRule?.enabled ?? false);
  const [kinds, setKinds] = useState<FactoryProjectMergeRule["kinds"]>(
    currentRule?.kinds ?? ["implementation"],
  );
  const [allowedPaths, setAllowedPaths] = useState(currentRule?.allowedPaths.join("\n") ?? "");
  const [excludedPaths, setExcludedPaths] = useState(currentRule?.excludedPaths.join("\n") ?? "");
  const [patterns, setPatterns] = useState(currentRule?.allowEstablishedPatterns ?? false);
  const [imageId, setImageId] = useState(currentPreview?.configuration.imageId ?? "");
  const [entryPoint, setEntryPoint] = useState(
    currentPreview?.configuration.args[0]?.replace(/^\/workspace\//, "") ?? "",
  );
  const [args, setArgs] = useState(currentPreview?.configuration.args.slice(1).join("\n") ?? "");
  const [port, setPort] = useState<number | null>(currentPreview?.configuration.port ?? 3000);
  const [publishScreenshots, setPublishScreenshots] = useState(
    currentPublication?.enabled ?? false,
  );
  const [saved, setSaved] = useState<string | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const hasAuthority = () =>
    readEnvironmentScope(environment.environmentId, AuthSettingsWriteScope) && !command.disabled;
  const saveRule = async () => {
    if (!hasAuthority() || manager.projectId === null) return;
    setValidation(null);
    setSaved(null);
    const allowed = lines(allowedPaths);
    const excluded = lines(excludedPaths);
    if ([...allowed, ...excluded].some((path) => !relativePath(path))) {
      setValidation(
        "Use exact project-relative files with forward slashes, without wildcards or parent traversal.",
      );
      return;
    }
    if (enabled && (allowed.length === 0 || kinds.length === 0)) {
      setValidation(
        "Select at least one assignment kind and allowed file before enabling this rule.",
      );
      return;
    }
    if (
      await command.submit({
        type: "delivery.rules.configure",
        projectId: manager.projectId,
        enabled,
        kinds,
        allowedPaths: allowed,
        excludedPaths: excluded,
        allowEstablishedPatterns: patterns,
      })
    )
      setSaved(
        "Project merge rule saved. Existing assignment autonomy and human approval requirements still apply.",
      );
  };
  const savePreview = async () => {
    if (!hasAuthority() || manager.projectId === null) return;
    setValidation(null);
    setSaved(null);
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId.trim())) {
      setValidation(
        "Enter the immutable image ID: sha256: followed by 64 lowercase hexadecimal characters.",
      );
      return;
    }
    if (!relativePath(entryPoint.trim())) {
      setValidation("Enter the Node app entry point as an exact repository-relative file.");
      return;
    }
    if (port === null || !Number.isInteger(port) || port < 1024 || port > 65535) {
      setValidation("The app port must be an integer between 1024 and 65535.");
      return;
    }
    const appArgs = lines(args);
    if (appArgs.length > 31 || appArgs.some((arg) => arg.length > 4096 || arg.includes("\0"))) {
      setValidation(
        "Use at most 31 app arguments, each at most 4096 characters without null bytes.",
      );
      return;
    }
    if (
      await command.submit({
        type: "delivery.preview.configure",
        projectId: manager.projectId,
        configuration: {
          imageId: imageId.trim(),
          executable: "/usr/local/bin/node",
          args: [`/workspace/${entryPoint.trim()}`, ...appArgs],
          port,
          data: "ephemeral",
        },
      })
    )
      setSaved(
        "Preview configuration approved. New reviewer previews will use this pinned runtime.",
      );
  };
  const savePublication = async () => {
    if (!hasAuthority() || manager.projectId === null) return;
    setValidation(null);
    setSaved(null);
    if (
      await command.submit({
        type: "delivery.preview.publication.configure",
        projectId: manager.projectId,
        enabled: publishScreenshots,
      })
    )
      setSaved(
        publishScreenshots
          ? "Verified screenshot publication is authorized for this project."
          : "New screenshot publication is disabled for this project. Previously published evidence remains in its repository.",
      );
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !command.pending && onClose()}>
      <DialogPopup showCloseButton={!command.pending}>
        <DialogHeader>
          <DialogTitle>Project delivery settings</DialogTitle>
          <DialogDescription>
            {manager.name} · {environment.label}. These approvals apply only to this project.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-6">
            {!settingsScope ? (
              <p role="status" className="text-sm text-muted-foreground">
                Settings permission is required to change these approvals.
              </p>
            ) : null}
            {!environment.connected ? (
              <p role="status" className="text-sm text-muted-foreground">
                Reconnect to {environment.label} before saving.
              </p>
            ) : null}
            <section className="space-y-3" aria-label="Project merge rule">
              <h3 className="text-sm font-medium">Merge authority</h3>
              <p className="text-sm text-muted-foreground">
                Human approval is the default. A project rule only permits matching assignments that
                already have rule-based merge autonomy. It does not increase their granted
                permissions or waive verification, team review, separately authorized rule changes,
                or manual approval for major UI work.
              </p>
              <p className="text-xs text-muted-foreground">
                Current rule:{" "}
                {currentRule
                  ? `version ${currentRule.version} · ${currentRule.enabled ? "enabled" : "disabled"}`
                  : "none; human approval required"}
                .
              </p>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={enabled}
                  disabled={command.disabled}
                  onCheckedChange={(value) => setEnabled(value === true)}
                />
                Enable a project merge rule
              </label>
              <fieldset disabled={command.disabled} className="space-y-2">
                <legend className="mb-2 text-sm font-medium">Eligible assignment kinds</legend>
                {(["implementation", "rule-change"] as const).map((kind) => (
                  <label key={kind} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={kinds.includes(kind)}
                      onCheckedChange={(value) =>
                        setKinds((previous) =>
                          value
                            ? [...new Set([...previous, kind])]
                            : previous.filter((entry) => entry !== kind),
                        )
                      }
                    />
                    {kind === "implementation"
                      ? "Implementation"
                      : "Separately authorized rule change"}
                  </label>
                ))}
              </fieldset>
              <div className="space-y-2">
                <Label htmlFor={`${prefix}-allowed`}>Allowed files or directories</Label>
                <Textarea
                  id={`${prefix}-allowed`}
                  rows={4}
                  value={allowedPaths}
                  disabled={command.disabled}
                  onChange={(event) => setAllowedPaths(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Project-relative files or directories, one per line. A directory includes its
                  descendants. Wildcards are not supported.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${prefix}-excluded`}>Excluded files or directories</Label>
                <Textarea
                  id={`${prefix}-excluded`}
                  rows={3}
                  value={excludedPaths}
                  disabled={command.disabled}
                  onChange={(event) => setExcludedPaths(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Explicit exclusions take precedence over allowed files.
                </p>
              </div>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={patterns}
                  disabled={command.disabled}
                  onCheckedChange={(value) => setPatterns(value === true)}
                />
                Allow UI work confirmed by the team reviewer to follow established patterns
              </label>
              <Button
                size="sm"
                variant="outline"
                disabled={command.disabled}
                onClick={() => void saveRule()}
              >
                Save merge rule
              </Button>
            </section>
            <section
              className="space-y-3 border-t border-border pt-4"
              aria-label="App preview runtime"
            >
              <h3 className="text-sm font-medium">Reviewer app runtime</h3>
              <p className="text-sm text-muted-foreground">
                Approve how the exact delivery candidate starts in isolation. The supported runtime
                runs Node with temporary data, no project credentials, and a browser restricted to
                this app. Use the image pinned to the assignment runtime.
              </p>
              {currentPreview ? (
                <p className="text-xs text-muted-foreground">
                  Last approved {currentPreview.approvedAt}. Changes apply to new previews.
                </p>
              ) : null}
              <div className="space-y-2">
                <Label htmlFor={`${prefix}-image`}>Pinned image ID</Label>
                <Input
                  id={`${prefix}-image`}
                  value={imageId}
                  placeholder="sha256:…"
                  disabled={command.disabled}
                  onChange={(event) => setImageId(event.target.value)}
                  spellCheck={false}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${prefix}-entry`}>Node app entry point</Label>
                <Input
                  id={`${prefix}-entry`}
                  value={entryPoint}
                  placeholder="app/server.cjs"
                  disabled={command.disabled}
                  onChange={(event) => setEntryPoint(event.target.value)}
                  spellCheck={false}
                />
                <p className="text-xs text-muted-foreground">
                  An existing candidate file. Runs with /usr/local/bin/node from /workspace.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${prefix}-args`}>App arguments</Label>
                <Textarea
                  id={`${prefix}-args`}
                  rows={3}
                  value={args}
                  disabled={command.disabled}
                  onChange={(event) => setArgs(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Optional, one argument per line. These are argument values, not shell commands.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${prefix}-port`}>App listening port</Label>
                <NumberField
                  id={`${prefix}-port`}
                  min={1024}
                  max={65535}
                  step={1}
                  value={port}
                  disabled={command.disabled}
                  onValueChange={setPort}
                >
                  <NumberFieldGroup>
                    <NumberFieldInput />
                  </NumberFieldGroup>
                </NumberField>
                <p className="text-xs text-muted-foreground">
                  The app must listen on this port inside its container. Data is temporary.
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={command.disabled}
                onClick={() => void savePreview()}
              >
                Approve preview runtime
              </Button>
            </section>
            <section
              className="space-y-3 border-t border-border pt-4"
              aria-label="Screenshot publication"
            >
              <h3 className="text-sm font-medium">PR screenshots</h3>
              <p className="text-sm text-muted-foreground">
                Recorded screenshots are visible locally. Authorize publication to write verified
                PNGs to immutable evidence refs in this project's GitHub repository and link them in
                the PR. They are kept outside the candidate branch. Major and substantial UI
                delivery require actual reviewer evidence and published PR screenshots.
              </p>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={publishScreenshots}
                  disabled={command.disabled}
                  onCheckedChange={(value) => setPublishScreenshots(value === true)}
                />
                Allow verified screenshot publication to this project's repository
              </label>
              <Button
                size="sm"
                variant="outline"
                disabled={command.disabled}
                onClick={() => void savePublication()}
              >
                Save screenshot permission
              </Button>
            </section>
            <FactoryTrackerSettings environment={environment} manager={manager} />
            {validation || command.error ? (
              <p role="alert" className="text-sm text-destructive">
                {validation ?? command.error}
              </p>
            ) : null}
            {command.pending ? (
              <p role="status" className="text-sm text-muted-foreground">
                Saving project settings…
              </p>
            ) : saved ? (
              <p role="status" className="text-sm text-muted-foreground">
                {saved}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={command.pending} onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
