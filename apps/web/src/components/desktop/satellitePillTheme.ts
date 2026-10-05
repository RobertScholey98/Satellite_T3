import { SatellitePillTheme } from "@t3tools/contracts";

export function readSatellitePillTheme(): SatellitePillTheme {
  const styles = getComputedStyle(document.documentElement);
  return Object.fromEntries(
    Object.keys(SatellitePillTheme.fields).map((key) => [key, styles.getPropertyValue(key).trim()]),
  ) as SatellitePillTheme;
}

/** Includes theme previews and custom palettes, which can change without a saved preference. */
export function watchSatellitePillTheme(onChange: () => void): () => void {
  let previous = readSatellitePillTheme();
  let previousDark = document.documentElement.classList.contains("dark");
  const observer = new MutationObserver(() => {
    const next = readSatellitePillTheme();
    const dark = document.documentElement.classList.contains("dark");
    if (
      dark === previousDark &&
      Object.keys(SatellitePillTheme.fields).every(
        (key) =>
          next[key as keyof SatellitePillTheme] === previous[key as keyof SatellitePillTheme],
      )
    )
      return;
    previous = next;
    previousDark = dark;
    onChange();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style", "class"],
  });
  return () => observer.disconnect();
}
