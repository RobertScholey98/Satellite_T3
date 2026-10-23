export const ONBOARDING_BRIEF = `# Onboarding

Before you pick up any work, learn how this project is built, checked and shipped. Read:

- AGENTS.md and CLAUDE.md, at the root and in any folder that has them.
- The CI workflows, and what each job runs.
- The lint, format, type and test configuration.
- Branch protection: what a pull request needs before it can merge.
- How the project verifies a change before it ships.

Satellite reads the board's Ready columns, its labels and the default branch itself, so do not
report them. The user chooses which Ready columns you may pick up from.

Then call factory_propose_onboarding with:

- A short summary of what you learned, and the project's purpose in a sentence or two.
- The control paths no team may edit, as glob patterns relative to the repository root, each
  with the reason it is protected. Start from the CI workflows, the lint, format, type and test
  configuration, the lockfiles, AGENTS.md and CLAUDE.md, and add anything else that decides how
  work is checked. Satellite always protects .satellite/factory/.
- Each open choice the user should make as a question with 2 to 4 options, the option you
  recommend, and why. Ask only what every lead should follow, such as which tickets count as
  small.
- Findings: facts worth showing the user that need no decision.
- Whether you propose pickup on or off, and the pickup guidance you would judge tickets by.

Then tell the user in this thread that the proposal is ready for review in Satellite. Nothing is
picked up until the user approves it.
`;
