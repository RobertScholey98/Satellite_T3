import { CopyIcon, PencilIcon, Trash2Icon } from "lucide-react";

import { requestConfirmDialog } from "~/confirmDialog";
import { Button } from "../ui/button";

export async function confirmFactoryDelete(message: string): Promise<boolean> {
  return (
    requestConfirmDialog(message, { variant: "destructive" }) ??
    Promise.resolve(window.confirm(message))
  );
}

/** Edit, Duplicate and Delete for one definition row. */
export function FactoryDefinitionActions({
  name,
  disabled,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  readonly name: string;
  readonly disabled: boolean;
  readonly onEdit: () => void;
  readonly onDuplicate: () => void;
  readonly onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-0.5">
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-label={`Edit ${name}`}
        disabled={disabled}
        onClick={onEdit}
      >
        <PencilIcon />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-label={`Duplicate ${name}`}
        disabled={disabled}
        onClick={onDuplicate}
      >
        <CopyIcon />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost-destructive"
        aria-label={`Delete ${name}`}
        disabled={disabled}
        onClick={onDelete}
      >
        <Trash2Icon />
      </Button>
    </div>
  );
}
