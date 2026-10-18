import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, ListChecks } from "lucide-react";
import { useRef } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { useRevdocReview } from "~/state/revdoc";

import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "../chat/threadDetailsPanelStyles";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { useRevdocActions } from "./useRevdocActions";

/** One click runs the default action; the menu offers the rest. */
export function RevdocControl({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const navigate = useNavigate();
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const defaultAction = useEnvironmentSettings(
    threadRef.environmentId,
    (settings) => settings.revdocDefaultAction,
  );
  const actions = useRevdocActions(threadRef);
  const { state } = useRevdocReview(threadRef.environmentId, actions.target);
  const pass = state.activePass;
  const label = pass ? (pass.kind === "generate" ? "Generating" : "Testing") : "Revdoc";
  const canTest = state.review !== null && state.testParentThreadId !== null;

  return (
    <div
      ref={anchorRef}
      role="group"
      aria-label="Revdoc"
      className={THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS}
    >
      <ThreadDetailsControl
        part="primary"
        size="xs"
        variant="ghost"
        disabled={!pass && !actions.canOperate}
        onClick={() => (pass ? actions.openPanel() : void actions.generate(defaultAction))}
      >
        <ListChecks className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
        <span className={cn("truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>{label}</span>
      </ThreadDetailsControl>
      <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
      <Menu>
        <MenuTrigger
          render={
            <ThreadDetailsControl
              aria-label="Revdoc options"
              size="sm"
              variant="ghost"
              part="secondary"
            />
          }
        >
          <ChevronDownIcon aria-hidden="true" className={THREAD_DETAILS_PANEL_CHEVRON_CLASS} />
        </MenuTrigger>
        <MenuPopup align="end" anchor={anchorRef} className="w-(--anchor-width)">
          <MenuItem onClick={actions.openPanel}>Open review</MenuItem>
          <MenuItem
            disabled={pass !== null || !actions.canOperate}
            onClick={() => void actions.generate("generate-and-test")}
          >
            Generate and test
          </MenuItem>
          <MenuItem
            disabled={pass !== null || !actions.canOperate}
            onClick={() => void actions.generate("generate")}
          >
            Generate only
          </MenuItem>
          <MenuItem
            disabled={pass !== null || !actions.canOperate || !canTest}
            onClick={() => void actions.test("remaining")}
          >
            Test with AI
          </MenuItem>
          <MenuItem disabled={pass === null} onClick={() => void actions.cancel()}>
            Cancel pass
          </MenuItem>
          <MenuSeparator />
          <MenuItem onClick={() => void navigate({ to: "/settings/general" })}>
            Revdoc settings
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}
