import { CopyIcon, MoreHorizontalIcon, Trash2Icon } from "lucide-react";

import { requestConfirmDialog } from "~/confirmDialog";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";

export async function confirmFactoryDelete(message: string): Promise<boolean> {
  return (
    requestConfirmDialog(message, { variant: "destructive" }) ??
    Promise.resolve(window.confirm(message))
  );
}

/** Edit for one definition row, with Duplicate and Delete behind its menu. */
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
    <div className="flex items-center gap-1">
      <Button
        size="sm"
        variant="outline"
        aria-label={`Edit ${name}`}
        disabled={disabled}
        onClick={onEdit}
      >
        Edit
      </Button>
      <Menu>
        <MenuTrigger
          aria-label={`${name} actions`}
          disabled={disabled}
          render={<Button size="icon-sm" variant="ghost-muted" />}
        >
          <MoreHorizontalIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={onDuplicate}>
            <CopyIcon />
            Duplicate
          </MenuItem>
          <MenuSeparator />
          <MenuItem variant="destructive" onClick={onDelete}>
            <Trash2Icon />
            Delete
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}
