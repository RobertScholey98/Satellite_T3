import type { ScopedProjectRef } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { FolderGit2Icon } from "lucide-react";
import { useDeferredValue, useId, useRef, useState } from "react";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { usePaginatedBranches } from "~/state/queries";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxStatus,
  ComboboxTrigger,
} from "../ui/combobox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { projectWorktreePath } from "./newWorktree";

interface NewWorktreeButtonProps {
  draftId: DraftId;
  projectRef: ScopedProjectRef;
  workspaceRoot: string;
}

export function NewWorktreeButton(props: NewWorktreeButtonProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !pending && setOpen(nextOpen)}>
      <DialogTrigger render={<Button variant="ghost-muted" size="sm" />}>
        <FolderGit2Icon aria-hidden="true" />
        New worktree
      </DialogTrigger>
      {open ? (
        <NewWorktreeForm
          {...props}
          pending={pending}
          onPendingChange={setPending}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </Dialog>
  );
}

function NewWorktreeForm({
  draftId,
  projectRef,
  workspaceRoot,
  pending,
  onPendingChange,
  onClose,
}: NewWorktreeButtonProps & {
  pending: boolean;
  onPendingChange: (pending: boolean) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [folder, setFolder] = useState("");
  const [branch, setBranch] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(
    () => useComposerDraftStore.getState().getDraftSession(draftId)?.branch ?? null,
  );
  const [query, setQuery] = useState("");
  const [folderTouched, setFolderTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const deferredQuery = useDeferredValue(query);
  const branches = usePaginatedBranches({
    environmentId: projectRef.environmentId,
    cwd: workspaceRoot,
    query: deferredQuery,
    includeMatchingRemoteRefs: true,
  });
  const createWorktree = useAtomCommand(vcsEnvironment.createWorktree, { reportFailure: false });
  const sourceBranch = source ?? branches.refs.find((branch) => branch.current)?.name ?? null;
  const newBranch = (branch ?? folder).trim();
  const destination = projectWorktreePath(workspaceRoot, folder);
  const folderError =
    folderTouched && destination === null
      ? "Enter a single folder name, such as worktree1, without slashes or reserved characters."
      : null;
  const names = branches.refs.map((ref) => ref.name);

  async function create() {
    if (inFlight.current || !destination || !newBranch || !sourceBranch) return;
    inFlight.current = true;
    onPendingChange(true);
    setError(null);
    const result = await createWorktree({
      environmentId: projectRef.environmentId,
      input: {
        cwd: workspaceRoot,
        path: destination,
        refName: sourceBranch,
        newRefName: newBranch,
      },
    });
    inFlight.current = false;
    onPendingChange(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(
        cause instanceof Error ? cause.message : "Could not create the worktree. Try again.",
      );
      return;
    }
    const { worktree } = result.value;
    const store = useComposerDraftStore.getState();
    const draft = store.getDraftSession(draftId);
    // A completed request must not retarget a draft that moved or was already sent.
    if (
      draft &&
      !draft.promotedTo &&
      draft.environmentId === projectRef.environmentId &&
      draft.projectId === projectRef.projectId
    ) {
      store.setDraftThreadContext(draftId, {
        projectRef,
        branch: worktree.refName,
        worktreePath: worktree.path,
        envMode: "worktree",
        environmentSelection: "manual",
      });
    }
    toastManager.add({ title: "Worktree created", description: worktree.path, type: "success" });
    onClose();
  }

  return (
    <DialogPopup showCloseButton={!pending}>
      <form
        className="flex min-h-0 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <DialogHeader>
          <DialogTitle>New worktree</DialogTitle>
          <DialogDescription>
            Create a folder inside this project and select it for your new thread.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <label className="grid gap-1.5">
            <span className="text-sm font-medium">Folder name</span>
            <Input
              value={folder}
              placeholder="worktree1"
              disabled={pending}
              onChange={(event) => setFolder(event.target.value)}
              onBlur={() => setFolderTouched(true)}
              aria-invalid={folderError !== null}
              aria-describedby={`${id}-destination${folderError ? ` ${id}-folder-error` : ""}`}
            />
          </label>
          {folderError ? (
            <p id={`${id}-folder-error`} className="text-sm text-destructive">
              {folderError}
            </p>
          ) : null}
          <p id={`${id}-destination`} className="break-all text-xs text-muted-foreground">
            {destination ?? `Project root: ${workspaceRoot}`}
          </p>
          <label className="grid gap-1.5">
            <span className="text-sm font-medium">New branch</span>
            <Input
              value={branch ?? folder}
              placeholder="feature/my-task"
              disabled={pending}
              onChange={(event) => setBranch(event.target.value)}
            />
          </label>
          <div className="grid gap-1.5">
            <label htmlFor={`${id}-source`} className="text-sm font-medium">
              Create from
            </label>
            <Combobox
              items={names}
              filteredItems={names}
              value={sourceBranch}
              onValueChange={(value) => {
                if (value) setSource(value);
              }}
              onOpenChange={(nextOpen) => {
                if (nextOpen && sourceBranch) setSource(sourceBranch);
                setQuery("");
              }}
            >
              <ComboboxTrigger
                id={`${id}-source`}
                render={<Button variant="outline" />}
                disabled={pending}
              >
                <span className="truncate">{sourceBranch ?? "Choose a branch"}</span>
              </ComboboxTrigger>
              <ComboboxPopup>
                <ComboboxSearchInput
                  aria-label="Search local and remote branches"
                  placeholder="Search local and remote branches…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <ComboboxEmpty>
                  {branches.isPending ? "Loading branches…" : "No branches found."}
                </ComboboxEmpty>
                <ComboboxList>
                  {(name: string) => (
                    <ComboboxItem key={name} value={name}>
                      {name}
                    </ComboboxItem>
                  )}
                </ComboboxList>
                {branches.data?.nextCursor != null ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={branches.isPending}
                    onClick={branches.loadNext}
                  >
                    {branches.isFetchingNextPage ? "Loading…" : "Load more branches"}
                  </Button>
                ) : null}
                {branches.error ? <ComboboxStatus>{branches.error}</ComboboxStatus> : null}
              </ComboboxPopup>
            </Combobox>
            <p className="text-xs text-muted-foreground">
              Choose a local branch or a remote branch such as origin/main.
            </p>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending || !destination || !newBranch || !sourceBranch}>
            {pending ? "Creating worktree…" : "Create worktree"}
          </Button>
        </DialogFooter>
      </form>
    </DialogPopup>
  );
}
