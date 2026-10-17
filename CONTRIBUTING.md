# Contributing to Satellite

This is a personal fork of T3 Code for experimenting with ideas that fit the
maintainer's own workflow. Current experiments connect issue boards, agent work,
open worktrees, and review in a desktop workspace. See the
[README](./README.md#why-this-fork-exists) for the direction of the fork.

## Setup

Start with the [source setup](./README.md#build-and-run-from-source) and
[development runbook](./docs/operations/development.md). Read [AGENTS.md](./AGENTS.md)
for repository conventions and precautions when working inside a running instance.

## Bugs and proposals

Use [this fork's issues](https://github.com/RobertScholey98/Satellite_T3/issues) for bug
reports and feature proposals. Include the version or commit, Windows or macOS version,
provider when relevant, reproduction steps, and expected and actual behavior.
Redact credentials from logs and recordings.

Discuss substantial changes in an issue before preparing a large pull request.
Upstream T3's contribution policy and contributor-vouching process do not apply
to this fork.

## Pull requests

Keep each change focused on one problem. Explain the problem and resulting
behavior, then list the focused checks you ran. Include before/after images for
UI changes and a short video when motion or timing matters. Upload this evidence
to GitHub rather than committing it.

Use a conventional commit title, for example `fix(desktop): restore the selected
thread after relaunch`. If an agent helped, name the model and harness at the end
of the description.

Run checks for the files and packages changed. The fork's CI runs the full lint,
typecheck, build, and test suites on Linux and builds the desktop pipeline on
Windows and macOS. Follow the [documentation rules](./AGENTS.md#documentation)
and the [fork constraints](./AGENTS.md#fork-constraints). Keep implementation
plans and scratch files outside the repository.
