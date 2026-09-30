import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { IssueBoardMapping, issueReadyColumnIds } from "./issues.ts";

const decodeMapping = Schema.decodeUnknownSync(IssueBoardMapping);
const mappingJson = Schema.toCodecJson(IssueBoardMapping);
const decodeMappingJson = Schema.decodeUnknownSync(mappingJson);
const encodeMappingJson = Schema.encodeSync(mappingJson);
const stages = {
  inProgress: "progress",
  inPullRequest: "pr",
  completed: "done",
  moveOnMerge: true,
};

describe("IssueBoardMapping", () => {
  it("reads existing single Ready column mappings", () => {
    const saved = { ...stages, ready: "ready" };
    const mapping = decodeMappingJson(saved);
    expect(mapping).toEqual(saved);
    expect(issueReadyColumnIds(mapping)).toEqual(["ready"]);
    expect(encodeMappingJson(mapping)).toEqual(saved);
  });

  it("round-trips multiple Ready columns while keeping movement destinations single", () => {
    const saved = { ...stages, ready: ["ready", "next"] };
    const mapping = decodeMappingJson(saved);
    expect(issueReadyColumnIds(mapping)).toEqual(["ready", "next"]);
    expect(encodeMappingJson(mapping)).toEqual(saved);
    expect(() => decodeMapping({ ...saved, inProgress: ["progress", "pr"] })).toThrow();
  });

  it("rejects an empty Ready selection and invalid column IDs", () => {
    expect(() => decodeMapping({ ...stages, ready: [] })).toThrow();
    expect(() => decodeMapping({ ...stages, ready: ["ready", ""] })).toThrow();
  });
});
