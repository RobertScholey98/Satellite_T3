import type { EnvironmentId, FactoryConfigRepoStatus } from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useId, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { useAtomCommand } from "~/state/use-atom-command";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
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
import { Label } from "../ui/label";
import { factoryConfigCommitMessage } from "./factoryConfigFiles";
import { useFactoryDefinitions } from "./factoryDefinitionsState";
import { factoryEnvironment, factoryErrorMessage, unwrapFactoryResult } from "./factoryState";

type ConnectedStatus = Extract<FactoryConfigRepoStatus, { connected: true }>;

const CHANGE_LABEL = { added: "Added", modified: "Modified", deleted: "Deleted" } as const;
const CHANGE_BADGE = { added: "success", modified: "info", deleted: "warning" } as const;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function failureMessage<A, E>(result: AtomCommandResult<A, E>): string | null {
  try {
    unwrapFactoryResult(result);
    return null;
  } catch (failure) {
    return factoryErrorMessage(failure);
  }
}

async function confirm(message: string, destructive: boolean): Promise<boolean> {
  return (
    requestConfirmDialog(message, { variant: destructive ? "destructive" : "default" }) ??
    Promise.resolve(window.confirm(message))
  );
}

/**
 * The factory config's optional Git repo. Sync runs only when asked: nothing here polls, and the
 * incoming count appears once Check has fetched.
 */
export function FactoryConfigRepoSection({
  environmentId,
  canEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly canEdit: boolean;
}) {
  const getStatus = useAtomCommand(factoryEnvironment.configRepoStatus, { reportFailure: false });
  const connect = useAtomCommand(factoryEnvironment.connectConfigRepo, { reportFailure: false });
  const check = useAtomCommand(factoryEnvironment.checkConfigRepo, { reportFailure: false });
  const pull = useAtomCommand(factoryEnvironment.pullConfigRepo, { reportFailure: false });
  const push = useAtomCommand(factoryEnvironment.pushConfigRepo, { reportFailure: false });
  const resolve = useAtomCommand(factoryEnvironment.resolveConfigRepo, { reportFailure: false });
  const discard = useAtomCommand(factoryEnvironment.discardConfigRepo, { reportFailure: false });
  const disconnect = useAtomCommand(factoryEnvironment.disconnectConfigRepo, {
    reportFailure: false,
  });

  const definitions = useFactoryDefinitions(environmentId);

  const [status, setStatus] = useState<FactoryConfigRepoStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [choosing, setChoosing] = useState(false);
  const [choiceError, setChoiceError] = useState<string | null>(null);
  const [pushMessage, setPushMessage] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/react-effect-budget -- Fetch the config repo status, dropping a reply that arrives after the environment changes or unmounts.
  useEffect(() => {
    let current = true;
    void getStatus({ environmentId, input: {} }).then((result) => {
      if (!current) return;
      if (result._tag === "Success") setStatus(result.value);
      else setError(failureMessage(result));
    });
    return () => {
      current = false;
    };
  }, [environmentId, getStatus]);

  /**
   * Runs one repo action; the status it returns replaces the shown one. An action that rewrites
   * the files also rereads the definitions, so the other factory sections show what is on disk.
   */
  const act = async (
    run: () => Promise<AtomCommandResult<FactoryConfigRepoStatus, unknown>>,
    changesFiles = false,
  ): Promise<boolean> => {
    setBusy(true);
    setError(null);
    const result = await run();
    if (result._tag === "Success") setStatus(result.value);
    else setError(failureMessage(result));
    if (changesFiles) await definitions.refresh();
    setBusy(false);
    return result._tag === "Success";
  };

  const submitConnect = async (choice?: "use-repo") => {
    const trimmed = url.trim();
    if (trimmed.length === 0) return;
    setBusy(true);
    setError(null);
    setChoiceError(null);
    const result = await connect({
      environmentId,
      input: choice === undefined ? { url: trimmed } : { url: trimmed, choice },
    });
    if (result._tag !== "Success") {
      setBusy(false);
      // A failed `use-repo` is answered where it was asked, in the dialog.
      if (choice === undefined) setError(failureMessage(result));
      else setChoiceError(failureMessage(result));
      return;
    }
    if (result.value.outcome === "needs-choice") {
      setBusy(false);
      setChoosing(true);
      return;
    }
    setChoosing(false);
    setStatus(result.value.status);
    await definitions.refresh();
    setBusy(false);
  };

  const confirmDiscard = async (connected: ConnectedStatus) => {
    const commits =
      connected.unpushedCommits === 0
        ? ""
        : ` ${plural(connected.unpushedCommits, "commit that was", "commits that were")} never pushed ${connected.unpushedCommits === 1 ? "is" : "are"} also discarded.`;
    const confirmed = await confirm(
      `Discard local changes? Files go back to the last copy from the repo.${commits} A backup of the current files is kept beside the config folder.`,
      true,
    );
    if (confirmed) await act(() => discard({ environmentId, input: {} }), true);
  };

  const settle = async (path: string, side: "mine" | "theirs") => {
    if (side === "theirs") {
      const confirmed = await confirm(
        `Take the repo's version? Your version of ${path} is replaced.`,
        true,
      );
      if (!confirmed) return;
    }
    await act(() => resolve({ environmentId, input: { path, side } }), true);
  };

  const confirmDisconnect = async (connected: ConnectedStatus) => {
    const unpushed = connected.localChanges.length + connected.unpushedCommits;
    if (unpushed === 0 && connected.conflict === null) {
      const confirmed = await confirm(
        "Disconnect the config repo? The files stay on this environment.",
        false,
      );
      if (confirmed) await act(() => disconnect({ environmentId, input: { force: false } }));
      return;
    }
    const first = await confirm(
      `${plural(unpushed, "local change was", "local changes were")} never pushed. Disconnect anyway? They stay on this environment but not in the repo.`,
      true,
    );
    if (!first) return;
    const second = await confirm("Disconnect without pushing?", true);
    if (second) await act(() => disconnect({ environmentId, input: { force: true } }));
  };

  const disabled = !canEdit || busy;

  return (
    <SettingsSection title="Config repo">
      {status === null ? (
        <SettingsRow title="Config repo" description={error ?? "Reading the repo status…"} />
      ) : !status.connected ? (
        <SettingsRow
          title="Connect a repo"
          description="Sync this config through a Git repo. This environment's own Git credentials are used, and nothing syncs until you push or pull."
          control={
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void submitConnect();
              }}
            >
              <Input
                aria-label="Repo URL"
                placeholder="git@github.com:you/repo.git"
                value={url}
                disabled={disabled}
                onChange={(event) => setUrl(event.target.value)}
              />
              <Button type="submit" size="sm" disabled={disabled || url.trim().length === 0}>
                Connect
              </Button>
            </form>
          }
        />
      ) : (
        <ConnectedRows
          status={status}
          disabled={disabled}
          onCheck={() => void act(() => check({ environmentId, input: {} }))}
          onPull={() => void act(() => pull({ environmentId, input: {} }), true)}
          onPush={() => setPushMessage(factoryConfigCommitMessage(status.localChanges))}
          onResolve={(path, side) => void settle(path, side)}
          onDiscard={() => void confirmDiscard(status)}
          onDisconnect={() => void confirmDisconnect(status)}
        />
      )}
      {error !== null && status !== null ? (
        <p className="px-4 pb-3 text-sm text-destructive">{error}</p>
      ) : null}
      <UseRepoDialog
        open={choosing}
        busy={busy}
        error={choiceError}
        onUseRepo={() => void submitConnect("use-repo")}
        onCancel={() => {
          setChoosing(false);
          setChoiceError(null);
        }}
      />
      <PushDialog
        message={pushMessage}
        busy={busy}
        onChange={setPushMessage}
        onCancel={() => setPushMessage(null)}
        onPush={(message) =>
          void act(() => push({ environmentId, input: { message } })).then((pushed) => {
            if (pushed) setPushMessage(null);
          })
        }
      />
    </SettingsSection>
  );
}

function ConnectedRows({
  status,
  disabled,
  onCheck,
  onPull,
  onPush,
  onResolve,
  onDiscard,
  onDisconnect,
}: {
  readonly status: ConnectedStatus;
  readonly disabled: boolean;
  readonly onCheck: () => void;
  readonly onPull: () => void;
  readonly onPush: () => void;
  readonly onResolve: (path: string, side: "mine" | "theirs") => void;
  readonly onDiscard: () => void;
  readonly onDisconnect: () => void;
}) {
  const { localChanges, unpushedCommits, incomingCommits, conflict } = status;
  return (
    <>
      <SettingsRow
        title="Repo"
        description={`${status.remoteUrl} · ${status.branch}`}
        control={
          <Button size="sm" variant="ghost-destructive" disabled={disabled} onClick={onDisconnect}>
            Disconnect
          </Button>
        }
      />
      {conflict !== null ? (
        <SettingsRow
          title="Pull stopped on a conflict"
          description="These files changed both here and in the repo. Keep this environment's version or take the repo's, one file at a time."
        >
          <ul className="space-y-1.5">
            {conflict.paths.map((path) => (
              <li key={path} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-mono">{path}</span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => onResolve(path, "mine")}
                >
                  Keep mine
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => onResolve(path, "theirs")}
                >
                  Take theirs
                </Button>
              </li>
            ))}
          </ul>
          {conflict.paths.length === 0 ? (
            <Button size="sm" disabled={disabled} onClick={onPull}>
              Finish pull
            </Button>
          ) : null}
        </SettingsRow>
      ) : null}
      <SettingsRow
        title={plural(localChanges.length, "local change", "local changes")}
        description={[
          plural(unpushedCommits, "change not pushed", "changes not pushed"),
          incomingCommits === null
            ? null
            : plural(
                incomingCommits,
                "commit on the repo you haven't pulled",
                "commits on the repo you haven't pulled",
              ),
        ]
          .filter((part) => part !== null)
          .join(" · ")}
        control={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={disabled} onClick={onCheck}>
              Check
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || conflict !== null}
              onClick={onPull}
            >
              Pull
            </Button>
            <Button
              size="sm"
              disabled={
                disabled ||
                conflict !== null ||
                (localChanges.length === 0 && unpushedCommits === 0)
              }
              onClick={onPush}
            >
              Push
            </Button>
          </div>
        }
      >
        {localChanges.length > 0 ? (
          <ul className="space-y-1">
            {localChanges.map((change) => (
              <li key={change.path} className="flex items-center gap-2 text-sm">
                <Badge size="sm" variant={CHANGE_BADGE[change.change]}>
                  {CHANGE_LABEL[change.change]}
                </Badge>
                <span className="min-w-0 truncate font-mono">{change.path}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {localChanges.length > 0 || unpushedCommits > 0 ? (
          <Button size="sm" variant="destructive-outline" disabled={disabled} onClick={onDiscard}>
            Discard local changes
          </Button>
        ) : null}
      </SettingsRow>
    </>
  );
}

function UseRepoDialog({
  open,
  busy,
  error,
  onUseRepo,
  onCancel,
}: {
  readonly open: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onUseRepo: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>The repo already has a config</DialogTitle>
          <DialogDescription>
            This environment has its own config too. Using the repo's config backs up this one
            first, beside the config folder, then replaces it.
          </DialogDescription>
        </DialogHeader>
        {error !== null ? (
          <DialogPanel>
            <p className="text-sm text-destructive">{error}</p>
          </DialogPanel>
        ) : null}
        <DialogFooter variant="bare">
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" disabled={busy} onClick={onUseRepo}>
            Use the repo's config
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function PushDialog({
  message,
  busy,
  onChange,
  onCancel,
  onPush,
}: {
  readonly message: string | null;
  readonly busy: boolean;
  readonly onChange: (message: string) => void;
  readonly onCancel: () => void;
  readonly onPush: (message: string) => void;
}) {
  const formId = useId();
  return (
    <Dialog
      open={message !== null}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Push to the repo</DialogTitle>
          <DialogDescription>
            Every local change goes into one commit with this message.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="space-y-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (message !== null && message.trim().length > 0) onPush(message.trim());
            }}
          >
            <Label htmlFor={`${formId}-message`}>Commit message</Label>
            <Input
              id={`${formId}-message`}
              autoFocus
              value={message ?? ""}
              onChange={(event) => onChange(event.target.value)}
            />
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            form={formId}
            type="submit"
            disabled={busy || message === null || message.trim().length === 0}
          >
            Push
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
