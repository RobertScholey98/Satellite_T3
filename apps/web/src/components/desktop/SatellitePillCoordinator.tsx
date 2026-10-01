import { useAtomValue } from "@effect/atom-react";
import { useParams } from "@tanstack/react-router";
import type { SatellitePillState, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

import { projectSatellitePill } from "../../satellitePill";
import { useThreadDetail, useThreadShell, useThreadStatus } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { environmentShell } from "../../state/shell";
import { resolveThreadRouteRef } from "../../threadRoutes";
import { readSatellitePillTheme, watchSatellitePillTheme } from "./satellitePillTheme";

function usePublishPill(projection: SatellitePillState) {
  const { threadId, environmentId, title, state, detail, attention } = projection;
  useEffect(() => {
    const bridge = window.satelliteBridge;
    if (!bridge) return;
    const publish = () =>
      bridge.publish({
        threadId,
        environmentId,
        title,
        state,
        detail,
        attention,
        theme: readSatellitePillTheme(),
      });
    publish();
    const stopWatchingTheme = watchSatellitePillTheme(publish);
    // Native stale detection also catches renderer crashes while the main window is hidden.
    const heartbeat = window.setInterval(publish, 10_000);
    return () => {
      window.clearInterval(heartbeat);
      stopWatchingTheme();
    };
  }, [threadId, environmentId, title, state, detail, attention]);
}

function SelectedThreadProjection({ threadRef }: { threadRef: ScopedThreadRef }) {
  const thread = useThreadShell(threadRef);
  // Share the selected ChatView's existing detail subscription, never start another session.
  const detail = useThreadDetail(thread === null ? null : threadRef);
  const detailStatus = useThreadStatus(thread === null ? null : threadRef);
  const environment = useEnvironment(threadRef.environmentId);
  const shell = useAtomValue(environmentShell.stateValueAtom(threadRef.environmentId));
  usePublishPill(
    projectSatellitePill({
      ref: threadRef,
      thread,
      connectionPhase: environment?.connection.phase ?? null,
      shellStatus: shell.status,
      activities: detailStatus === "live" ? detail?.activities : undefined,
    }),
  );
  return null;
}

function UnselectedThreadProjection() {
  usePublishPill(
    projectSatellitePill({ ref: null, thread: null, connectionPhase: null, shellStatus: null }),
  );
  return null;
}

/** Stays mounted while the retained workspace is hidden. */
export function SatellitePillCoordinator() {
  const params = useParams({ strict: false });
  const threadRef = resolveThreadRouteRef(params);
  return threadRef ? (
    <SelectedThreadProjection
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
    />
  ) : (
    <UnselectedThreadProjection />
  );
}
