#!/usr/bin/env node
// Waits for Group deployment readiness before a merge-triggered deployment. Run it as its own
// GitHub Actions job and make the deploy job `needs:` it. It only reads GitHub; the deploy job
// keeps its own environment approvals, checks, credentials and order.
//
// Usage: node merge-group-gate.mjs [--timeout <seconds>] [--interval <seconds>]
// Reads GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_SHA, and GITHUB_API_URL when set.
// Exit 0: the commit is not grouped, or its whole group merged. Exit 1: anything else.

// Matches FACTORY_MERGE_GROUP_LABEL and FACTORY_MERGE_GROUP_STATUS_CONTEXT in Satellite.
const LABEL = "satellite-merge-group";
const CONTEXT = "satellite/merge-group";

const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? fallback : Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} needs a number of seconds.`);
  return value * 1000;
};

async function main() {
  const timeout = option("timeout", 1800);
  const interval = option("interval", 30);
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repository, GITHUB_SHA: sha } = process.env;
  if (!token || !repository || !sha)
    throw new Error("Set GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_SHA.");
  const api = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
  const get = async (path) => {
    const response = await fetch(`${api}/repos/${repository}/${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "satellite-merge-group-gate",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status} for ${path}.`);
    return response.json();
  };

  const pulls = await get(`commits/${sha}/pulls`);
  const grouped = pulls.filter((pull) => pull.labels?.some((label) => label.name === LABEL));
  if (grouped.length === 0) {
    console.log(`${sha} is not part of a Satellite merge group. Deployment may continue.`);
    return 0;
  }
  const names = grouped.map((pull) => `#${pull.number}`).join(", ");
  const deadline = Date.now() + timeout;
  for (;;) {
    const combined = await get(`commits/${sha}/status?per_page=100`);
    const status = combined.statuses?.find((entry) => entry.context === CONTEXT);
    if (status?.state === "success") {
      console.log(`Merge group ready: ${status.description ?? "every member merged"}`);
      return 0;
    }
    if (status?.state === "failure" || status?.state === "error") {
      console.error(`Merge group did not complete: ${status.description ?? status.state}`);
      return 1;
    }
    const waiting = status?.description ?? `No ${CONTEXT} status yet.`;
    if (Date.now() + interval > deadline) {
      console.error(
        `Grouped change ${names} is still waiting for its merge group: ${waiting}\n` +
          `Re-run this job after every member merges. Check the ${CONTEXT} status on ${sha} and the merge group review in Satellite.`,
      );
      return 1;
    }
    console.log(`Waiting for merge group: ${waiting}`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
