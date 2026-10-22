import type { ModelSelection } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { factoryModelKey } from "./FactoryPageConfig";

/** The pool's models with their labels, in pool order. */
export interface FactoryPoolModel {
  readonly selection: ModelSelection;
  readonly label: string;
}

const POOL_DEFAULT = "pool";

/** One model from the pool, or none to let the factory choose from the pool. */
export function FactoryModelSelect({
  label,
  pool,
  value,
  emptyLabel,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly pool: ReadonlyArray<FactoryPoolModel>;
  readonly value: ModelSelection | null;
  readonly emptyLabel: string;
  readonly disabled: boolean;
  readonly onChange: (value: ModelSelection | null) => void;
}) {
  const selectedKey = value === null ? POOL_DEFAULT : factoryModelKey(value);
  const labels = new Map(pool.map((model) => [factoryModelKey(model.selection), model.label]));
  return (
    <Select
      value={selectedKey}
      disabled={disabled}
      onValueChange={(next) => {
        if (next === POOL_DEFAULT) return onChange(null);
        const model = pool.find((candidate) => factoryModelKey(candidate.selection) === next);
        if (model) onChange(model.selection);
      }}
    >
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue>
          {(key: string) =>
            key === POOL_DEFAULT ? emptyLabel : (labels.get(key) ?? value?.model ?? emptyLabel)
          }
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem value={POOL_DEFAULT}>{emptyLabel}</SelectItem>
        {pool.map((model) => (
          <SelectItem
            key={factoryModelKey(model.selection)}
            value={factoryModelKey(model.selection)}
          >
            {model.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** An allow-list from the pool; empty means any model in the pool. */
export function FactoryModelAllowList({
  label,
  pool,
  value,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly pool: ReadonlyArray<FactoryPoolModel>;
  readonly value: ReadonlyArray<ModelSelection>;
  readonly disabled: boolean;
  readonly onChange: (value: ReadonlyArray<ModelSelection>) => void;
}) {
  const selected = new Set(value.map(factoryModelKey));
  const summary =
    value.length === 0
      ? "Any pool model"
      : value.length === 1
        ? (pool.find((model) => selected.has(factoryModelKey(model.selection)))?.label ??
          value[0]!.model)
        : `${value.length} models`;
  return (
    <Menu>
      <MenuTrigger
        aria-label={label}
        disabled={disabled || pool.length === 0}
        render={<Button variant="outline" size="sm" />}
      >
        <span className="max-w-48 truncate">{summary}</span>
        <ChevronDownIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end">
        {pool.map((model) => {
          const key = factoryModelKey(model.selection);
          return (
            <MenuCheckboxItem
              key={key}
              checked={selected.has(key)}
              closeOnClick={false}
              onCheckedChange={(checked) =>
                onChange(
                  checked
                    ? pool
                        .filter(
                          (candidate) =>
                            selected.has(factoryModelKey(candidate.selection)) ||
                            factoryModelKey(candidate.selection) === key,
                        )
                        .map((candidate) => candidate.selection)
                    : value.filter((candidate) => factoryModelKey(candidate) !== key),
                )
              }
            >
              {model.label}
            </MenuCheckboxItem>
          );
        })}
      </MenuPopup>
    </Menu>
  );
}
