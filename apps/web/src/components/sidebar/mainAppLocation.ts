import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";

// Settings, Usage, and Pull Requests replace the sidebar utility row with a
// Back button. Everything else is the main app. Legacy `/projects/<key>` links
// redirect into settings, so they count too and are never remembered.
export function isSidebarUtilityPage(pathname: string) {
  return (
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    pathname.startsWith("/projects/") ||
    pathname === "/usage" ||
    pathname === "/ideas" ||
    pathname === "/pull-requests"
  );
}

let mainAppLocation: { href: string; draftId?: DraftId } | null = null;

// Mount once in the app shell. Records the latest main app URL so Back can
// return there no matter how many utility pages were visited since.
export function MainAppLocationTracker() {
  const draftId = useParams({ strict: false, select: (params) => params.draftId });
  const href = useLocation({
    select: (location) => (isSidebarUtilityPage(location.pathname) ? null : location.href),
  });
  useEffect(() => {
    if (href !== null)
      mainAppLocation = { href, ...(draftId ? { draftId: DraftId.make(draftId) } : {}) };
  }, [draftId, href]);
  return null;
}

// Leaves a utility page for the last main app URL, or the thread list when
// the app was opened directly on a utility page.
export function useNavigateToMainApp() {
  const navigate = useNavigate();
  return useCallback(() => {
    const draft = mainAppLocation?.draftId
      ? useComposerDraftStore.getState().getDraftSession(mainAppLocation.draftId)
      : null;
    const href =
      mainAppLocation &&
      (!mainAppLocation.draftId || (draft && (draft.purpose !== "idea" || !draft.promotedTo)))
        ? mainAppLocation.href
        : "/";
    return navigate({ href });
  }, [navigate]);
}
