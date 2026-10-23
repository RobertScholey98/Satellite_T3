import { assert, describe, it } from "@effect/vitest";
import {
  FactoryConfigSettings,
  FactoryLeadDefinition,
  FactoryManagerDefinition,
  FactoryTeamDefinition,
  FactoryWorkerDefinition,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  decodeLeadFile,
  decodeManagerFile,
  decodeSettingsFile,
  decodeTeamFiles,
  decodeWorkerFile,
  definitionIdFromName,
  encodeLeadFile,
  encodeManagerFile,
  encodeSettingsFile,
  encodeTeamFiles,
  encodeWorkerFile,
} from "./definitionFiles.ts";

const decodeWorker = Schema.decodeSync(FactoryWorkerDefinition);
const decodeSettings = Schema.decodeSync(FactoryConfigSettings);

const WORKER = decodeWorker({
  id: "reviewer",
  name: "Reviewer",
  models: {
    dynamic: true,
    models: [
      {
        driver: "claudeAgent",
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "max" }],
      },
      { driver: "opencode", model: "anthropic/claude-x" },
    ],
  },
  description: "Reviews the diff.\n\nReports findings.",
});

const WORKER_FILE = [
  "---",
  "name: Reviewer",
  "models:",
  "  dynamic: true",
  "  list:",
  "    - model: claudeAgent/claude-opus-5-5",
  "      options:",
  "        effort: max",
  "    - model: opencode/anthropic/claude-x",
  "---",
  "",
  "Reviews the diff.",
  "",
  "Reports findings.",
  "",
].join("\n");

const LEAD = Schema.decodeSync(FactoryLeadDefinition)({
  id: "default-lead",
  name: "Default lead",
  models: { models: [{ driver: "codex", model: "gpt-6" }] },
  instructions: "Keep PRs small.",
});

const MANAGER = Schema.decodeSync(FactoryManagerDefinition)({
  id: "default-manager",
  name: "Default manager",
  models: {},
  instructions: "",
});

const TEAM = Schema.decodeSync(FactoryTeamDefinition)({
  id: "web-ui",
  name: "Web UI",
  useWhen: "The ticket changes the web client: components, styles or routes.",
  workflow: "Implement, then review.",
  mayEditProtectedPaths: true,
  createdBy: "manager",
  lead: LEAD,
  members: [
    { ...WORKER, id: "implementer", name: "Implementer", count: 2, models: {} },
    { ...WORKER, id: "reviewer", count: 1 },
  ],
});

const decodeTeam = (files: ReadonlyArray<{ readonly path: string; readonly contents: string }>) =>
  decodeTeamFiles({
    id: "web-ui",
    directory: "teams/web-ui",
    team: files.find((file) => file.path === "team.md")?.contents ?? null,
    lead: files.find((file) => file.path === "lead.md")?.contents ?? null,
    members: files
      .filter((file) => file.path.startsWith("members/"))
      .map((file) => ({ id: file.path.slice("members/".length, -3), text: file.contents })),
  });

describe("definition files", () => {
  it("writes a worker as frontmatter and a description body", () => {
    assert.strictEqual(encodeWorkerFile(WORKER), WORKER_FILE);
  });

  it("decodes a worker file to the definition, model names with slashes intact", () => {
    const decoded = decodeWorkerFile({
      path: "workers/reviewer.md",
      id: "reviewer",
      text: WORKER_FILE,
    });
    assert.deepStrictEqual(decoded, Result.succeed(WORKER));
  });

  it("re-encodes every kind of file it wrote to the same bytes", () => {
    const lead = encodeLeadFile(LEAD);
    const manager = encodeManagerFile(MANAGER);
    const settings = encodeSettingsFile(
      decodeSettings({
        version: 1,
        modelPool: [{ driver: "codex", model: "gpt-6", options: [{ id: "fast", value: true }] }],
        recoveryAllowance: 3,
      }),
    );

    const reencode = <A>(decoded: Result.Result<A, unknown>, encode: (value: A) => string) =>
      encode(Result.getOrThrow(decoded));
    assert.strictEqual(
      reencode(
        decodeLeadFile({ path: "leads/default-lead.md", id: LEAD.id, text: lead }),
        encodeLeadFile,
      ),
      lead,
    );
    assert.strictEqual(
      reencode(
        decodeManagerFile({ path: "managers/default-manager.md", id: MANAGER.id, text: manager }),
        encodeManagerFile,
      ),
      manager,
    );
    assert.strictEqual(
      reencode(decodeSettingsFile("factory.yaml", settings), encodeSettingsFile),
      settings,
    );
    assert.strictEqual(manager, "---\nname: Default manager\n---\n");
    assert.strictEqual(
      settings,
      [
        "version: 1",
        "modelPool:",
        "  - model: codex/gpt-6",
        "    options:",
        "      fast: true",
        "recoveryAllowance: 3",
        "",
      ].join("\n"),
    );

    const teamFiles = encodeTeamFiles(TEAM);
    const decodedTeam = decodeTeam(teamFiles);
    assert.deepStrictEqual(decodedTeam, { team: TEAM, problems: [] });
    assert.deepStrictEqual(encodeTeamFiles(decodedTeam.team!), teamFiles);
    assert.deepStrictEqual(
      teamFiles.map((file) => file.path),
      ["team.md", "lead.md", "members/implementer.md", "members/reviewer.md"],
    );
    assert.strictEqual(
      teamFiles[0]!.contents,
      [
        "---",
        "name: Web UI",
        'useWhen: "The ticket changes the web client: components, styles or routes."',
        "mayEditProtectedPaths: true",
        "createdBy: manager",
        "---",
        "",
        "Implement, then review.",
        "",
      ].join("\n"),
    );
  });

  it("omits keys at their default", () => {
    assert.strictEqual(encodeSettingsFile(decodeSettings({ version: 1 })), "version: 1\n");
    const [team] = encodeTeamFiles({ ...TEAM, mayEditProtectedPaths: false, createdBy: "user" });
    assert.strictEqual(
      team!.contents,
      '---\nname: Web UI\nuseWhen: "The ticket changes the web client: components, styles or routes."\n---\n\nImplement, then review.\n',
    );
  });

  it("decodes a hand edit with CRLF endings and no trailing newline", () => {
    const text =
      "---\r\nname: Reviewer\r\nmodels:\r\n  list:\r\n    - model: codex/gpt-6\r\n---\r\n\r\nReviews.";
    assert.deepStrictEqual(
      decodeWorkerFile({ path: "workers/reviewer.md", id: "reviewer", text }),
      Result.succeed(
        decodeWorker({
          id: "reviewer",
          name: "Reviewer",
          models: { dynamic: false, models: [{ driver: "codex", model: "gpt-6" }] },
          description: "Reviews.",
        }),
      ),
    );
  });

  it("reports a bad file as a problem with its path", () => {
    const decode = (text: string, id = "reviewer") =>
      decodeWorkerFile({ path: `workers/${id}.md`, id, text });

    assert.deepStrictEqual(
      decode("no frontmatter"),
      Result.fail({
        path: "workers/reviewer.md",
        message: "Expected YAML frontmatter between --- lines.",
      }),
    );
    assert.deepStrictEqual(
      decode("---\nname: Reviewer\nmodels:\n  list:\n    - model: gpt-6\n---\n"),
      Result.fail({ path: "workers/reviewer.md", message: '"gpt-6" is not driver/model.' }),
    );
    assert.deepStrictEqual(
      decode("---\nname: Reviewer\n---\n", "Reviewer"),
      Result.fail({
        path: "workers/Reviewer.md",
        message: '"Reviewer" is not a valid id: use lowercase letters, digits and dashes.',
      }),
    );
    assert.strictEqual(Result.isFailure(decode("---\nmodels: {}\n---\n")), true);
  });

  it("skips a member whose name another member already has", () => {
    const files = encodeTeamFiles({
      ...TEAM,
      members: [...TEAM.members, { ...TEAM.members[1]!, id: "second-reviewer" }],
    });
    assert.deepStrictEqual(decodeTeam(files), {
      team: TEAM,
      problems: [
        {
          path: "teams/web-ui/members/second-reviewer.md",
          message: 'Another member of this team is named "Reviewer"; a lead delegates by name.',
        },
      ],
    });
  });

  it("skips a team with no valid members or a bad lead copy", () => {
    const [team, lead] = encodeTeamFiles(TEAM);
    assert.deepStrictEqual(decodeTeam([team!, lead!]), {
      team: null,
      problems: [{ path: "teams/web-ui", message: "The team has no valid members." }],
    });
    assert.deepStrictEqual(
      decodeTeam(
        encodeTeamFiles(TEAM).map((file) =>
          file.path === "lead.md" ? { ...file, contents: encodeLeadFile(LEAD) } : file,
        ),
      ),
      {
        team: null,
        problems: [
          {
            path: "teams/web-ui/lead.md",
            message: "The team's lead copy needs the source lead's id under \"id\".",
          },
        ],
      },
    );
  });
});

describe("definitionIdFromName", () => {
  it("slugs the name and adds a suffix when the id is taken", () => {
    assert.strictEqual(definitionIdFromName("  Web UI — Café!  ", new Set()), "web-ui-cafe");
    assert.strictEqual(definitionIdFromName("Reviewer", new Set(["reviewer"])), "reviewer-2");
    assert.strictEqual(
      definitionIdFromName("Reviewer", new Set(["reviewer", "reviewer-2"])),
      "reviewer-3",
    );
    assert.strictEqual(definitionIdFromName("!!!", new Set()), "definition");
  });

  it("caps the id at 64 characters, suffix included", () => {
    const long = "a".repeat(70);
    assert.strictEqual(definitionIdFromName(long, new Set()), "a".repeat(64));
    assert.strictEqual(
      definitionIdFromName(long, new Set(["a".repeat(64)])),
      `${"a".repeat(62)}-2`,
    );
  });
});
