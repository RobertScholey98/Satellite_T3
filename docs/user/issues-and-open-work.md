# Issues and open work

Use **Issues** in the Pull Requests workspace to browse tickets from your repository
hosts. Connect an existing GitHub Project or Azure DevOps board, then choose the
columns for Ready for development, In progress, In PR, and Completed. Enable
**Move to Completed when a pull request is merged** if you want merges to finish
tickets automatically. You can change these choices later.

Open a ticket to see its details. Tickets in your Ready column offer **Start**.
Choose the project in the usual new-thread prompt, name the worktree, and send
your instructions. The ticket moves into progress after the worktree is ready
and the agent receives the prompt. Returning tickets offer **Continue existing**;
choose **New attempt** to keep the previous work and start another thread.

Dragging a ticket updates the remote board. Automatic moves happen on new work
events, so refreshing does not undo a manual move. A draft or ready pull request
moves the active attempt into In PR. The newest linked pull request controls
that attempt's status; closing it without merging returns the ticket to In
progress. Earlier attempts remain linked but no longer move it.
When the board and worktree belong to different computers, pending updates sync
while a client is connected to both. An update that arrives after a manual move
may need you to retry it explicitly, so an older update cannot undo your choice.

Use **Open** to inspect local worktrees, including worktrees without tickets.
The selector shows how far each is ahead of and behind main. The timeline shows
commits beyond main, followed by the live work-in-progress step containing
staged, unstaged, and untracked changes.

Published documents from threads that worked in that worktree appear alongside
its commits. New publications start in WIP and stay with the next commit. Assign
a document to an older commit when it describes that code. Favouriting pins it
above the timeline without changing its commit link.

**Find documents** links a folder on the worktree's computer and includes nested
Markdown and HTML files. Optional time-based linking uses creation time by
default; last-modified time is available instead. Without time-based linking,
files remain unassigned until you choose a step. Once assigned to a commit, a
document stays there. These folder links always open the current file, while
published documents retain their saved versions. Unlinking a folder removes its
links without deleting the files.
