import type { FactoryModelList, FactoryModelRef } from "@t3tools/contracts";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from "lucide-react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";
import { FactoryModelLabel } from "./FactoryModelLabel";
import type { FactoryModelOption } from "./FactoryPageConfig";
import {
  FACTORY_MODEL_REF_FLAG_LABELS,
  describeFactoryModelRefs,
  factoryModelRefKey,
  moveFactoryModelRef,
} from "./factoryModelRefs";

/**
 * A definition's model list, picked from the pool. Entries that cannot run here stay listed and
 * flagged, because the definition may travel to a machine where they can.
 */
export function FactoryModelListEditor({
  label,
  value,
  pool,
  modelOptions,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: FactoryModelList;
  readonly pool: ReadonlyArray<FactoryModelRef>;
  readonly modelOptions: ReadonlyArray<FactoryModelOption>;
  readonly disabled: boolean;
  readonly onChange: (value: FactoryModelList) => void;
}) {
  const entries = describeFactoryModelRefs(value.models, modelOptions, pool);
  const listed = new Set(value.models.map(factoryModelRefKey));
  const addable = describeFactoryModelRefs(
    pool.filter((ref) => !listed.has(factoryModelRefKey(ref))),
    modelOptions,
    null,
  );
  const setModels = (models: ReadonlyArray<FactoryModelRef>) => onChange({ ...value, models });

  return (
    <div role="group" aria-label={label} className="flex flex-col gap-2">
      <label className="flex items-start justify-between gap-4 text-sm">
        <span className="flex flex-col">
          <span>Dynamic</span>
          <span className="text-xs text-muted-foreground">
            {value.dynamic
              ? "The lead or manager picks one of these models for each task"
              : "Runs the first available model, in this order"}
          </span>
        </span>
        <Switch
          size="sm"
          checked={value.dynamic}
          disabled={disabled}
          aria-label={`${label}: dynamic`}
          onCheckedChange={(dynamic) => onChange({ ...value, dynamic })}
        />
      </label>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">Any model in the pool</p>
      ) : (
        <ol className="flex flex-col divide-y divide-border/50 rounded-lg border">
          {entries.map((entry, index) => (
            <li
              key={factoryModelRefKey(entry.ref)}
              className="flex items-center gap-1.5 py-0.5 ps-3 pe-0.5 text-sm"
            >
              <span className="min-w-0 flex-1">
                <FactoryModelLabel modelRef={entry.ref} label={entry.label} />
              </span>
              {entry.flags.map((flag) => (
                <Badge key={flag} size="sm" variant="warning">
                  {FACTORY_MODEL_REF_FLAG_LABELS[flag]}
                </Badge>
              ))}
              {entries.length > 1 ? (
                <>
                  <Button
                    size="icon-sm"
                    variant="ghost-muted"
                    aria-label={`Move ${entry.label} up`}
                    disabled={disabled || index === 0}
                    onClick={() => setModels(moveFactoryModelRef(value.models, index, -1))}
                  >
                    <ArrowUpIcon />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost-muted"
                    aria-label={`Move ${entry.label} down`}
                    disabled={disabled || index === entries.length - 1}
                    onClick={() => setModels(moveFactoryModelRef(value.models, index, 1))}
                  >
                    <ArrowDownIcon />
                  </Button>
                </>
              ) : null}
              <Button
                size="icon-sm"
                variant="ghost-muted"
                aria-label={`Remove ${entry.label}`}
                disabled={disabled}
                onClick={() => setModels(value.models.filter((_, other) => other !== index))}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ol>
      )}
      <div>
        <Menu>
          <MenuTrigger
            aria-label={`Add a model to ${label}`}
            disabled={disabled || addable.length === 0}
            render={<Button size="sm" variant="outline" />}
          >
            <PlusIcon />
            Add model
          </MenuTrigger>
          <MenuPopup align="start">
            {addable.map((entry) => (
              <MenuItem
                key={factoryModelRefKey(entry.ref)}
                onClick={() => setModels([...value.models, entry.ref])}
              >
                {entry.flags.length === 0
                  ? entry.label
                  : `${entry.label} (${FACTORY_MODEL_REF_FLAG_LABELS.unavailable})`}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}
