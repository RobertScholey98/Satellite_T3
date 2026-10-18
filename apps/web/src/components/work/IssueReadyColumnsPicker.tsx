import type { IssueBoardColumn } from "@t3tools/contracts";
import { CheckIcon, XIcon } from "lucide-react";
import { useRef } from "react";

import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import { SelectButton } from "../ui/select";

export function IssueReadyColumnsPicker({
  columns,
  value,
  onChange,
  disabled = false,
}: {
  columns: readonly IssueBoardColumn[];
  value: readonly string[];
  onChange: (columns: string[]) => void;
  disabled?: boolean;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const title = (id: string) => columns.find((column) => column.id === id)?.title ?? id;

  return (
    <div className="grid gap-2">
      <Combobox
        multiple
        items={columns.map((column) => column.id)}
        value={[...value]}
        onValueChange={onChange}
        itemToStringLabel={title}
        disabled={disabled}
      >
        <ComboboxTrigger ref={anchor} aria-label="Ready for development" render={<SelectButton />}>
          {value.length ? value.map(title).join(", ") : "Choose ready columns"}
        </ComboboxTrigger>
        <ComboboxPopup anchor={anchor}>
          <ComboboxSearchInput aria-label="Search ready columns" placeholder="Search columns…" />
          <ComboboxEmpty>No matching columns</ComboboxEmpty>
          <ComboboxList>
            {(id: string) => (
              <ComboboxItem key={id} value={id}>
                <span className="min-w-0 flex-1 truncate">{title(id)}</span>
                {value.includes(id) ? <CheckIcon aria-hidden /> : null}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
      {value.length ? (
        <div className="flex flex-wrap gap-1">
          {value.map((id) => (
            <Button
              key={id}
              size="xs"
              variant="secondary"
              disabled={disabled}
              aria-label={`Remove ${title(id)}`}
              onClick={() => onChange(value.filter((column) => column !== id))}
            >
              {title(id)}
              <XIcon />
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
