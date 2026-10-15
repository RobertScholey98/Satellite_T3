import { SatellitePillCoordinator } from "./desktop/SatellitePillCoordinator";
import { IdeaDeletionCleanup } from "./ideas/IdeaDeletionCleanup";

/** Satellite's app-wide coordinators. */
export function SatelliteRootCoordinators() {
  return (
    <>
      {window.satelliteBridge ? <SatellitePillCoordinator /> : null}
      <IdeaDeletionCleanup />
    </>
  );
}
