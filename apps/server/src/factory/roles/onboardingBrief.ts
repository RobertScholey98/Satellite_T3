export const ONBOARDING_BRIEF = `# Onboarding

Before you pick up any work, learn how this project is built, checked and shipped. Read:

- AGENTS.md and CLAUDE.md, at the root and in any folder that has them.
- The CI workflows, and what each job runs.
- The lint, format, type and test configuration.
- The issue board mapping for this project, and which column is Ready.
- Branch protection: what a pull request needs before it can merge.
- How the project verifies a change before it ships.

Then call factory_propose_onboarding with:

- A short summary of what you learned.
- The control paths no team may edit, as glob patterns relative to the repository root. Start
  from the CI workflows, the lint, format, type and test configuration, the lockfiles,
  AGENTS.md, CLAUDE.md and .satellite/factory/, and add anything else that decides how work is
  checked.
- Gaps in the board mapping, such as a missing Ready column.
- Open choices the user should make, such as which tickets count as small.

Then ask the user in this thread to review the report. Nothing is picked up until the user
approves it.
`;
