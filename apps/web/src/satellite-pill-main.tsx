import { createRoot } from "react-dom/client";
import { SatellitePillFace } from "./components/desktop/SatellitePillFace";
import "./components/desktop/SatellitePillFace.css";

const root = document.getElementById("root");
if (root && window.satellitePillBridge) {
  createRoot(root).render(<SatellitePillFace bridge={window.satellitePillBridge} />);
}
