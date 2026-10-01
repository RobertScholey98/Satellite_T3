import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

/** Satellite logo, matching the web and desktop sidebar. */
export function SatelliteMark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Svg
      accessibilityLabel="Satellite"
      height={props.height}
      width={props.height}
      viewBox="0 0 64 64"
    >
      <ThemedPath
        d="M9 27h14v14h14v14H9V27Zm32-18h14v14H41V9Z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
