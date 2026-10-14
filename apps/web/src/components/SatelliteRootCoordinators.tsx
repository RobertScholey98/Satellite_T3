import { SatellitePillCoordinator } from "./desktop/SatellitePillCoordinator";
import { IdeaDeletionCleanup } from "./ideas/IdeaDeletionCleanup";
import { IssueReceiptRelay } from "./issues/IssueReceiptRelay";

/** Satellite's app-wide coordinators. The root route mounts them on one line. */
export function SatelliteRootCoordinators() {
  return (
    <>
      {window.satelliteBridge ? <SatellitePillCoordinator /> : null}
      <IdeaDeletionCleanup />
      <IssueReceiptRelay />
    </>
  );
}
