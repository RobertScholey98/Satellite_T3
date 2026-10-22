import * as Schema from "effect/Schema";

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

const TAB_KEY = "satellite:factory:tab:v1";

const FactoryPageTabSchema = Schema.Literals(["dashboard", "configuration"]);
export type FactoryPageTab = typeof FactoryPageTabSchema.Type;
const decodeTab = Schema.decodeUnknownOption(FactoryPageTabSchema);

/** Settings search links into Configuration by a row's anchor. */
export const FACTORY_CONFIGURATION_ANCHOR_PREFIX = "factory-";

function defaultStorage(): PreferenceStorage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

/** The tab this device showed last. */
export function readFactoryPageTab(storage = defaultStorage()): FactoryPageTab {
  try {
    const raw = storage?.getItem(TAB_KEY);
    if (!raw) return "dashboard";
    const decoded = decodeTab(JSON.parse(raw));
    return decoded._tag === "Some" ? decoded.value : "dashboard";
  } catch {
    return "dashboard";
  }
}

export function writeFactoryPageTab(tab: FactoryPageTab, storage = defaultStorage()) {
  try {
    storage?.setItem(TAB_KEY, JSON.stringify(tab));
  } catch {
    // The page opens on Dashboard when storage is unavailable.
  }
}
