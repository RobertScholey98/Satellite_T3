import type { FactoryConfigBundle, FactoryConfigRepoChange } from "@t3tools/contracts";
import JSZip from "jszip";

/** Bytes rather than a Blob, so the same code runs in tests and in the browser. */
export async function zipFactoryBundle(bundle: FactoryConfigBundle): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const file of bundle.files) zip.file(file.path, file.contents);
  return zip.generateAsync({ type: "uint8array" });
}

/** Directories are entries in a zip but not files of the bundle. */
export async function unzipFactoryBundle(
  bytes: ArrayBuffer | Uint8Array,
): Promise<FactoryConfigBundle> {
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  const files = await Promise.all(
    entries.map(async (entry) => ({ path: entry.name, contents: await entry.async("string") })),
  );
  return { files: files.toSorted((a, b) => a.path.localeCompare(b.path)) };
}

/** A team is one folder of files, so its changes are named by the team. */
const changedDefinition = (path: string) =>
  path.startsWith("teams/") ? path.split("/").slice(0, 2).join("/") : path;

const SHOWN_IN_MESSAGE = 3;

/** A push's default message: what changed, such as "Edit workers/agent-x.md, teams/poteto". */
export function factoryConfigCommitMessage(
  changes: ReadonlyArray<FactoryConfigRepoChange>,
): string {
  const definitions = [...new Set(changes.map((change) => changedDefinition(change.path)))];
  if (definitions.length === 0) return "Edit the factory config";
  const shown = definitions.slice(0, SHOWN_IN_MESSAGE).join(", ");
  const more = definitions.length - SHOWN_IN_MESSAGE;
  return more > 0 ? `Edit ${shown} and ${more} more` : `Edit ${shown}`;
}

export function downloadBytes(fileName: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/zip" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}
