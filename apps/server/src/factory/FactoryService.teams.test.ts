import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  withDatabase,
  activeManager,
  DUO_TEAM,
  makeTeamFactory,
  startedTeam,
} from "./FactoryService.testkit.ts";

describe("FactoryService teams", () => {
  it.effect("staffs the factory team an older preset name matches, and snapshots it", () =>
    withDatabase(
      Effect.gen(function* () {
        const factory = yield* makeTeamFactory;
        const { assignment } = yield* startedTeam(factory);

        // The assignment keeps the whole snapshot...
        const sql = yield* SqlClient.SqlClient;
        const stored = yield* sql<{ team_json: string }>`SELECT team_json FROM factory_assignments
            WHERE id=${assignment.id}`;
        assert.deepStrictEqual(JSON.parse(stored[0]!.team_json), {
          preset: "duo",
          members: [],
          definition: DUO_TEAM,
        });
        // ...but sends only its shape, so no event carries every member's brief.
        const summarized = {
          preset: "duo",
          members: [],
          summary: {
            name: "Duo",
            members: [
              { name: "Implementer", count: 1 },
              { name: "Reviewer", count: 1 },
            ],
            mayEditProtectedPaths: false,
          },
        };
        assert.deepStrictEqual(assignment.team, summarized);
        const [listed] = yield* factory.service.listAssignments({});
        assert.deepStrictEqual(listed!.team, summarized);
        assert.include(
          factory.attemptStarts[0]!.prompt,
          "# Team\n\nDuo\n\nImplement, then review before the pull request.",
        );
      }),
    ),
  );

  it.effect(
    "adds a manager's team of definition copies, refusing other models and duplicates",
    () =>
      withDatabase(
        Effect.gen(function* () {
          const factory = yield* makeTeamFactory;
          const { service, configStore } = factory;
          const manager = yield* activeManager(factory);
          const opus = { driver: ProviderDriverKind.make("claudeAgent"), model: "claude-opus-5-5" };
          const gpt = { driver: ProviderDriverKind.make("codex"), model: "gpt-5.5" };
          const lead = {
            id: "default",
            name: "Default lead",
            models: { dynamic: true, models: [opus] },
            instructions: "Keep PRs small.",
          };
          const reviewer = {
            id: "reviewer",
            name: "Reviewer",
            models: { dynamic: false, models: [opus] },
            description: "Review the diff.",
          };
          yield* configStore.writeSettings({ version: 1, modelPool: [opus], recoveryAllowance: 1 });
          yield* configStore.writeLead(lead);
          yield* configStore.writeWorker(reviewer);
          yield* configStore.writeWorker({
            id: "coder",
            name: "Coder",
            models: { dynamic: false, models: [gpt] },
            description: "Write the code.",
          });

          const created = yield* service.createTeam(manager.threadId!, {
            name: "Review pair",
            useWhen: "Risky changes.",
            workflow: "Both review before the pull request.",
            members: [
              { workerId: "reviewer", count: 1 },
              { workerId: "reviewer", count: 1, name: "Second opinion" },
            ],
          });
          assert.deepStrictEqual(created, {
            id: "review-pair",
            name: "Review pair",
            useWhen: "Risky changes.",
            workflow: "Both review before the pull request.",
            mayEditProtectedPaths: false,
            createdBy: "manager",
            lead,
            members: [
              { ...reviewer, count: 1 },
              { ...reviewer, id: "second-opinion", name: "Second opinion", count: 1 },
            ],
          });
          // A team holds copies: editing the worker later leaves the team as it was saved.
          yield* configStore.writeWorker({ ...reviewer, description: "Review everything." });
          const savedTeam = (yield* configStore.read).teams.find(
            (team) => team.id === "review-pair",
          );
          assert.deepStrictEqual(savedTeam, created);
          const [logged] = yield* service.listLog({ managerId: manager.id });
          assert.strictEqual(logged!.kind, "team");
          assert.strictEqual(logged!.reason, "Review pair");

          const outside = yield* service
            .createTeam(manager.threadId!, {
              name: "Codex pair",
              useWhen: "Anything.",
              workflow: "",
              members: [{ workerId: "coder", count: 2 }],
            })
            .pipe(Effect.flip);
          assert.deepInclude(outside, {
            reason: "invalid",
            message:
              'codex/gpt-5.5 is not in the model pool. Add it to the pool first, or remove it from the member "Coder".',
          });
          const duplicate = yield* service
            .createTeam(manager.threadId!, {
              name: "Review pair",
              useWhen: "Again.",
              workflow: "",
              members: [{ workerId: "reviewer", count: 1 }],
            })
            .pipe(Effect.flip);
          assert.strictEqual(duplicate.reason, "conflict");
          // Neither refused team was written; the harness's own teams are not this test's concern.
          assert.deepStrictEqual(
            (yield* configStore.read).teams
              .filter((team) => team.name === "Review pair" || team.name === "Codex pair")
              .map((team) => team.id),
            ["review-pair"],
          );
        }),
      ),
  );
});
