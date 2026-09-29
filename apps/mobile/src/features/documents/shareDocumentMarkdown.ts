import { beginForegroundHandoff } from "../../lib/foreground-handoff";
import { uuidv4 } from "../../lib/uuid";

export async function shareDocumentMarkdown(title: string, markdown: string): Promise<void> {
  const Sharing = await import("expo-sharing");
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error("Saving and sharing files is unavailable on this device.");
  }
  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.cache, "document-results");
  directory.create({ intermediates: true, idempotent: true });
  const name = title.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "document";
  const file = new File(directory, `${name}-${uuidv4()}.md`);
  file.write(markdown);
  const endHandoff = beginForegroundHandoff();
  try {
    await Sharing.shareAsync(file.uri, {
      mimeType: "text/markdown",
      dialogTitle: "Save or share results",
      UTI: "net.daringfireball.markdown",
    });
  } finally {
    endHandoff();
  }
}
