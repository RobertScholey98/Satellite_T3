import {
  EnvironmentId,
  type IssueRef,
  ProjectId,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatTicketParam,
  matchesTicketParam,
  readIssuesNavigation,
  resolveIssuesSearch,
  validateIssuesSearch,
  writeIssuesNavigation,
} from "./issuesNavigation";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

const environmentA = EnvironmentId.make("env-a");
const environmentB = EnvironmentId.make("env-b");
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");

const stored = {
  environmentId: environmentA,
  projectId: projectA,
  boardId: "board-a",
  ticket: "42",
  mode: "list" as const,
};

const ref = (repository: string, number: number): IssueRef => ({
  hostKind: SourceControlProviderKind.make("github"),
  host: "github.com",
  repository,
  id: `${repository}-${number}`,
  number,
  url: `https://github.com/${repository}/issues/${number}`,
});

describe("resolveIssuesSearch", () => {
  it("restores the whole stored selection when opened without parameters", () => {
    expect(resolveIssuesSearch({}, stored)).toEqual(stored);
  });

  it("keeps explicit fields over stored ones", () => {
    expect(resolveIssuesSearch({ mode: "board" }, stored)).toEqual({ ...stored, mode: "board" });
    expect(resolveIssuesSearch({ ...stored, ticket: "7" }, stored)).toEqual({
      ...stored,
      ticket: "7",
    });
  });

  it("fills deeper levels when the explicit ones agree with the stored selection", () => {
    expect(
      resolveIssuesSearch({ environmentId: environmentA, projectId: projectA }, stored),
    ).toEqual(stored);
  });

  it("fills no selection below a level that points elsewhere", () => {
    expect(resolveIssuesSearch({ environmentId: environmentB }, stored)).toEqual({
      environmentId: environmentB,
      mode: "list",
    });
    expect(
      resolveIssuesSearch(
        { environmentId: environmentA, projectId: projectB, connect: true },
        stored,
      ),
    ).toEqual({ environmentId: environmentA, projectId: projectB, connect: true, mode: "list" });
  });
});

describe("issues navigation storage", () => {
  it("round-trips the selection without the one-shot connect flag", () => {
    const storage = memoryStorage();
    writeIssuesNavigation({ ...stored, connect: true }, storage);
    expect(readIssuesNavigation(storage)).toEqual(stored);
  });

  it("ignores invalid stored JSON and stored values of the wrong shape", () => {
    expect(
      readIssuesNavigation(memoryStorage({ "satellite:issues:navigation:v1": "{nope" })),
    ).toEqual({});
    expect(
      readIssuesNavigation(
        memoryStorage({ "satellite:issues:navigation:v1": JSON.stringify({ mode: "grid" }) }),
      ),
    ).toEqual({});
  });

  it("clears Satellite 1.x's issue draft store", () => {
    const storage = memoryStorage({ "t3code:issue-drafts": '{"state":{"intents":{}}}' });
    readIssuesNavigation(storage);
    expect(storage.values.has("t3code:issue-drafts")).toBe(false);
  });
});

describe("validateIssuesSearch", () => {
  it("accepts a numeric ticket and the connect flag as the router parses them", () => {
    expect(validateIssuesSearch({ ticket: 42, connect: 1, mode: "grid", boardId: "" })).toEqual({
      ticket: "42",
      connect: true,
    });
  });
});

describe("ticket parameters", () => {
  it("uses the number unless another repository on the board shares it", () => {
    const own = ref("acme/web", 5);
    expect(formatTicketParam(own, [own, ref("acme/web", 6)])).toBe("5");
    expect(formatTicketParam(own, [own, ref("acme/api", 5)])).toBe("acme/web#5");
  });

  it("matches a bare number or a repository-qualified key", () => {
    expect(matchesTicketParam("5", ref("acme/web", 5))).toBe(true);
    expect(matchesTicketParam("acme/web#5", ref("acme/web", 5))).toBe(true);
    expect(matchesTicketParam("acme/api#5", ref("acme/web", 5))).toBe(false);
  });
});
