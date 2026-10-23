import JSZip from "jszip";
import { describe, expect, it } from "vite-plus/test";

import {
  factoryConfigCommitMessage,
  unzipFactoryBundle,
  zipFactoryBundle,
} from "./factoryConfigFiles";

describe("factory config zips", () => {
  it("keeps every path and its contents through a round trip", async () => {
    const bundle = {
      files: [
        { path: "factory.yaml", contents: "version: 1\n" },
        { path: "teams/web-ui/members/reviewer.md", contents: "---\nname: Reviewer\n---\n\nRé.\n" },
        { path: "workers/implementer.md", contents: "---\nname: Implementer\n---\n" },
      ],
    };
    expect(await unzipFactoryBundle(await zipFactoryBundle(bundle))).toEqual(bundle);
  });

  it("skips directory entries", async () => {
    const zip = new JSZip();
    zip.folder("workers");
    zip.file("workers/implementer.md", "brief\n");
    const bytes = await zip.generateAsync({ type: "uint8array" });

    expect(await unzipFactoryBundle(bytes)).toEqual({
      files: [{ path: "workers/implementer.md", contents: "brief\n" }],
    });
  });
});

describe("factoryConfigCommitMessage", () => {
  it("names each changed definition once, a team by its folder", () => {
    expect(
      factoryConfigCommitMessage([
        { path: "workers/agent-x.md", change: "modified" },
        { path: "teams/poteto/team.md", change: "modified" },
        { path: "teams/poteto/members/reviewer.md", change: "added" },
      ]),
    ).toBe("Edit workers/agent-x.md, teams/poteto");
  });

  it("counts what it leaves out", () => {
    expect(
      factoryConfigCommitMessage(
        ["a", "b", "c", "d", "e"].map((id) => ({ path: `workers/${id}.md`, change: "added" })),
      ),
    ).toBe("Edit workers/a.md, workers/b.md, workers/c.md and 2 more");
  });
});
