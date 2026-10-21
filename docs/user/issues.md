# Issues

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
