import type { FactoryModelRef } from "@t3tools/contracts";

import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";

/** A pooled or listed model as the composer's picker shows one: provider icon, then its name. */
export function FactoryModelLabel({
  modelRef,
  label,
}: {
  readonly modelRef: FactoryModelRef;
  readonly label: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <ProviderInstanceIcon
        driverKind={modelRef.driver}
        displayName={label}
        className="size-4"
        iconClassName="size-4"
      />
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}
