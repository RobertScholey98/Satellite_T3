import type { SVGProps } from "react";

export function SatelliteMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
      <path d="M9 27h14v14h14v14H9V27Zm32-18h14v14H41V9Z" fill="currentColor" />
    </svg>
  );
}
