# Issues and Open work

## Issues

Issues shows a GitHub Project or an Azure DevOps board next to your pull requests. Open it from the
**Issues** tab at the top of the Pull Requests page, or choose **Open issues** in the command
palette. It reopens on the board, mode, filters, and ticket you had selected on this device.

Choose **Connect board** to pick a board found through the project's sign-in, or use **Manual
setup** to enter one by hand. Then map the board's columns: one or more **Ready for development**
columns, and the columns that mean **In progress**, **In PR**, and **Completed**. You can change the
mapping later with **Configure columns** without losing started tickets. All board connections are
listed in **Settings**, **Issue boards**, where you can also refresh or disconnect them.

GitHub Projects need a token with the project scope. Run `gh auth refresh -s project`, or save a
token in **Settings**, **Source control**. Azure DevOps boards use `az login` and `az devops login` on
the computer hosting the project.

Each computer connects the board itself, so connect the board on each computer that starts
tickets. After upgrading from Satellite 1.x, a ticket that was started from another computer's board
stays linked to its thread but no longer moves automatically, even after you connect the board on
this computer. **Start** on a ticket in a Ready column runs on the computer whose board you are viewing:
it creates a worktree thread there with the ticket attached to the first message. That computer
then moves the ticket to In progress once the agent starts, to In PR when a pull request is linked
to the thread, and to Completed on merge if you turned that on. A thread started from a ticket shows the
ticket in its header, with **Stop attempt** and **Resume attempt**.

Drag a ticket to move it. Moving a ticket by hand pauses its automatic moves: the board says the
automatic move was skipped, and the thread shows **Automatic moves paused**. Automatic moves resume
when you put the ticket back where the attempt left it, or when you press **Retry** on the skipped
move. A drag is refused when the ticket already moved on another device; refresh the board first.

The header shows when the board last synced, and why a sync failed with a **Retry**. The board also
syncs when you return to the window.

## Open work

Open work lists every git worktree of the projects on an environment, including worktrees made by
hand, by delegated tasks, or in a custom worktree location. Open it from the **Open work** tab at
the top of the Pull Requests page, or choose **Open work** in the command palette.

Each worktree shows its branch, or its commit when HEAD is detached, and how many commits it is
ahead of and behind main. The repository's own checkout is marked **Primary**. Main is the first of `origin/main`, `main`, the branch `origin/HEAD` points at,
`origin/master`, and `master` that exists. When none exists, the worktree says **No main found** and
shows only its uncommitted changes.

Select a worktree to see its commits beyond main, oldest first, each with its file and line
totals. Select a commit's file count to list its files. **Work in progress** follows the commits:
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
