import { describe, expect, it } from "vite-plus/test";

import { factoryTeamDeleteMessage } from "./factoryTeamDelete";

const BASE =
  "Delete the team Web UI? Its lead and member copies go with it. Workers and leads stay.";

describe("factoryTeamDeleteMessage", () => {
  it("names the managers that list the team", () => {
    expect(
      factoryTeamDeleteMessage({
        name: "Web UI",
        uses: {
          managers: [
            { managerId: "ada", name: "Ada", projectTitle: "Satellite" },
            { managerId: "bob", name: "Bob", projectTitle: "Work API" },
          ],
        },
        lastTeam: false,
      }),
    ).toBe(
      `${BASE} Used by: Ada (Satellite), Bob (Work API). Those managers can no longer pick it.`,
    );
  });

  it("says when no team will be left, and when the check failed", () => {
    expect(
      factoryTeamDeleteMessage({ name: "Web UI", uses: { managers: [] }, lastTeam: true }),
    ).toBe(`${BASE} No teams will be left; managers can't commission work until you add one.`);
    expect(factoryTeamDeleteMessage({ name: "Web UI", uses: null, lastTeam: false })).toBe(
      `${BASE} Satellite could not check which managers use it.`,
    );
  });
});
