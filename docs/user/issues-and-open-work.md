# Issues and Open work

## Open work

Open work lists every git worktree of the projects on an environment, including worktrees made by
hand, by delegated tasks, or in a custom worktree location. Open it from the **Open Work** tab at
the top of the Pull Requests page, or choose **Open work** in the command palette.

Each worktree shows its branch, or its commit when HEAD is detached, and how many commits it is
ahead of and behind main. The repository's own checkout is marked **Primary**. Main is the first of `origin/main`, `main`, the branch `origin/HEAD` points at,
`origin/master`, and `master` that exists. When none exists, the worktree says **No main found** and
shows only its uncommitted changes.

Select a worktree to see its commits beyond main, oldest first, followed by **Work in progress**:
the staged, unstaged, and untracked files that are not committed yet. A file that was staged and
then edited again appears in both the staged and unstaged groups. Select any file to open its diff
beside the timeline. A commit's diff compares with that commit's first parent, so it does not
change as later work lands. A work-in-progress file shows its whole uncommitted change against
HEAD, whichever group you selected it from. Press Escape to close the diff.

When a thread works in the selected worktree, **Open thread** goes to it, and **Open pull request**
appears once that thread has a pull request. **Copy path** copies the worktree's folder.

Open work rereads when you open it, when you press Refresh, and when you return to the window. The
work-in-progress step also updates when an agent run in that worktree finishes. Very long histories
show the newest 200 commits, and large steps note how many files they show.
