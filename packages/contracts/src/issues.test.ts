import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  IssueBoardMapping,
  IssueBoardSyncEvent,
  IssueBoardView,
  issueReadyColumnIds,
} from "./issues.ts";

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

describe("IssueBoardView sync", () => {
  const board = {
    id: "board-1",
    projectId: "project-1",
    title: "Board",
    locator: {
      kind: "github-project",
      host: "github.com",
      owner: "owner",
      ownerKind: "user",
      projectNumber: 1,
      projectNodeId: "P1",
      statusFieldId: "F1",
    },
    mapping: null,
  };
  const view = { board, columns: [], items: [], attempts: [], moves: [] };

  it("reads a view from a server that predates snapshots", () => {
    expect(Schema.decodeUnknownSync(IssueBoardView)(view)).toEqual(view);
  });

  it("reads the stored copy's freshness when the server sends it", () => {
    const sync = {
      revision: 3,
      syncedAt: "2026-10-02T09:14:03.000Z",
      syncing: true,
      failure: { at: "2026-10-02T09:20:00.000Z", message: "Host unavailable" },
    };
    expect(Schema.decodeUnknownSync(IssueBoardView)({ ...view, sync }).sync).toEqual(sync);
  });

  it("reads a sync event for a board the server no longer holds", () => {
    expect(
      Schema.decodeUnknownSync(IssueBoardSyncEvent)({ boardId: "board-1", sync: null }),
    ).toEqual({ boardId: "board-1", sync: null });
  });
});
