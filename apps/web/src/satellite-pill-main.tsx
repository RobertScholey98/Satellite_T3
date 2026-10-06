import { createRoot } from "react-dom/client";
import { SatellitePillFace } from "./components/desktop/SatellitePillFace";
import { TooltipProvider } from "./components/ui/tooltip";
import "./index.css";
import "./components/desktop/SatellitePillFace.css";

const root = document.getElementById("root");
if (root && window.satellitePillBridge) {
  createRoot(root).render(
    <TooltipProvider>
      <SatellitePillFace bridge={window.satellitePillBridge} />
    </TooltipProvider>,
  );
}
