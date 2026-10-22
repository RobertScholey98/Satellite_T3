import { assert, describe, it } from "@effect/vitest";

import { controlPathMatcher } from "./controlPaths.ts";

describe("controlPathMatcher", () => {
  it("lets ** cross any number of segments, including none", () => {
    const matches = controlPathMatcher([".github/workflows/**", "docs/**/rules.md"]);
    assert.isTrue(matches(".github/workflows/ci.yml"));
    assert.isTrue(matches(".github/workflows/nested/deep/release.yml"));
    assert.isTrue(matches("docs/rules.md"));
    assert.isTrue(matches("docs/a/b/rules.md"));
    assert.isFalse(matches(".github/dependabot.yml"));
  });

  it("keeps * and ? within one segment", () => {
    const matches = controlPathMatcher(["scripts/*.sh", "config/v?.json"]);
    assert.isTrue(matches("scripts/release.sh"));
    assert.isFalse(matches("scripts/ci/release.sh"));
    assert.isTrue(matches("config/v2.json"));
    assert.isFalse(matches("config/v10.json"));
  });

  it("matches a pattern without a slash as a basename at any depth", () => {
    const matches = controlPathMatcher(["AGENTS.md"]);
    assert.isTrue(matches("AGENTS.md"));
    assert.isTrue(matches("apps/server/AGENTS.md"));
    assert.isFalse(matches("apps/server/AGENTS.md.bak"));
    assert.isFalse(matches("NOT_AGENTS.md"));
  });

  it("covers a directory and everything under it with a trailing slash", () => {
    const matches = controlPathMatcher([".satellite/factory/"]);
    assert.isTrue(matches(".satellite/factory/roles/lead.md"));
    assert.isTrue(matches(".satellite/factory/config.json"));
    assert.isFalse(matches(".satellite/other.json"));
    assert.isFalse(matches("nested/.satellite/factory/roles/lead.md"));
  });

  it("matches a bare path exactly", () => {
    const matches = controlPathMatcher(["apps/server/package.json"]);
    assert.isTrue(matches("apps/server/package.json"));
    assert.isTrue(matches("./apps/server/package.json"));
    assert.isFalse(matches("package.json"));
    assert.isFalse(matches("apps/web/package.json"));
    assert.isFalse(matches("apps/server/package.json.orig"));
  });

  it("normalises backslash paths and patterns to forward slashes", () => {
    const matches = controlPathMatcher(["tools\\ci\\**"]);
    assert.isTrue(matches("tools\\ci\\deploy.ps1"));
    assert.isTrue(matches("tools/ci/deploy.ps1"));
    assert.isTrue(controlPathMatcher(["AGENTS.md"])("apps\\web\\AGENTS.md"));
  });

  it("matches nothing for unrelated paths or no patterns", () => {
    assert.isFalse(controlPathMatcher(["AGENTS.md", ".github/**"])("src/index.ts"));
    assert.isFalse(controlPathMatcher([])("AGENTS.md"));
    assert.isFalse(controlPathMatcher(["  ", "/"])("AGENTS.md"));
  });
});
