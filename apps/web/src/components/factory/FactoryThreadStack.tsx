import type { ThreadId } from "@t3tools/contracts";
import { ArrowLeftIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "../chat/threadDetailsPanelStyles";
import {
  FACTORY_BACK_CONTROL_HEIGHT,
  FACTORY_DETAILS_SLOT,
  type FactoryStackSlot,
  type FactoryWorkspaceView,
} from "./factoryWorkspaceLogic";

export const FACTORY_CARD_CLASS = "dropdown-glass isolate contain-paint shrink-0 rounded-3xl";

export interface FactoryStackEntry extends FactoryStackSlot {
  /** Null for the details card, which the chat view renders. */
  readonly render:
    | ((props: {
        readonly view: FactoryWorkspaceView;
        readonly openThread: (threadId: ThreadId) => void;
      }) => ReactNode)
    | null;
}

/**
 * The column around a factory thread's details card, top to bottom. It takes the top-left gutter
 * when that fits and otherwise heads the right side, above the team cards.
 */
export const FACTORY_THREAD_STACK: ReadonlyArray<FactoryStackEntry> = [
  {
    key: "back-to-manager",
    visibleOn: ["team"],
    height: FACTORY_BACK_CONTROL_HEIGHT,
    render: ({ view, openThread }) => (
      <BackToManager onOpen={() => openThread(view.manager.threadId)} />
    ),
  },
  { key: FACTORY_DETAILS_SLOT, visibleOn: ["manager", "team"], render: null },
  // Slots for cards other work builds; they render nothing yet.
  { key: "manager-settings", visibleOn: ["manager"], render: () => null },
  { key: "pr-merge", visibleOn: ["manager", "team"], render: () => null },
];

function BackToManager(props: { readonly onOpen: () => void }) {
  return (
    <div className={`${FACTORY_CARD_CLASS} p-1.5`}>
      <ThreadDetailsControl part="row" onClick={props.onOpen}>
        <ArrowLeftIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        Back to manager
      </ThreadDetailsControl>
    </div>
  );
}
