import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { IssueRef } from "@t3tools/contracts";
import { canonicalIssueKey, fromAdapters } from "./IssueHost.ts";
import type { IssueHostAdapter } from "./IssueHostAdapter.ts";

const ref = (overrides: Partial<IssueRef>): IssueRef => ({
  hostKind: "github",
  host: "GitHub.com",
  repository: "Owner/Repo",
  id: "42",
  number: 42,
  url: "https://github.com/Owner/Repo/issues/42",
  ...overrides,
});

describe("canonicalIssueKey", () => {
  it("keys an issue by host kind, lower-cased host and repository, and id", () => {
    assert.strictEqual(canonicalIssueKey(ref({})), "github:github.com:owner/repo:42");
  });
  it("keys an Azure work item by organization alone, since ids are unique across projects", () => {
    assert.strictEqual(
      canonicalIssueKey(
        ref({ hostKind: "azure-devops", host: "dev.azure.com", repository: "FSGB/Hub Redesign" }),
      ),
      "azure-devops:dev.azure.com:fsgb:42",
    );
  });
});

describe("fromAdapters", () => {
  const unused = () => Effect.die("unused");
  const github: IssueHostAdapter = {
    kind: "github",
    list: unused,
    get: unused,
    boards: { locatorKind: "github-project", list: unused, read: unused, move: unused },
  };
  const gitlab: IssueHostAdapter = { kind: "gitlab", list: unused, get: unused };

  it("finds an adapter by host kind and a boards group by locator kind, and nothing else", () => {
    const registry = fromAdapters([github, gitlab]);
    assert.deepStrictEqual(
      (["github", "gitlab", "unknown"] as const).map((kind) => registry.forHost(kind)?.kind),
      ["github", "gitlab", undefined],
    );
    assert.strictEqual(
      registry.forBoard({
        kind: "github-project",
        host: "github.com",
        owner: "owner",
        ownerKind: "user",
        projectNumber: 1,
      }),
      github.boards,
    );
    assert.strictEqual(
      registry.forBoard({
        kind: "azure-board",
        host: "dev.azure.com",
        organization: "org",
        project: "Project",
        team: "Team",
        boardId: "board",
      }),
      null,
    );
  });
});
