# Revdoc reviews

Revdoc turns a worktree's changes into a review checklist. You mark each check, an AI agent can
test the checks in the background, and the checklist stays current as the code changes. Every
thread in the same worktree shares one review.

## Start a review

Open the thread's details panel and click **Revdoc** beside **Commit**. Revdoc reads the thread's
recent conversation and every change since the default branch, committed or not, and opens the
review as a **Revdoc** tab in the right panel. The button runs your default action; its menu also
offers **Generate and test**, **Generate only**, **Test with AI**, and **Cancel pass**. The command
palette has **Open Revdoc review** and **Run Revdoc pass**.

To review another worktree of the same repository, pick it in the review header. Satellite
remembers the choice for that thread; **Thread default** goes back to the thread's own worktree.

Large change sets are reviewed in batches. The checklist appears and grows as batches finish and is
labelled **Partial** until the pass ends. If a pass is interrupted, running Revdoc again continues
from the finished batches, unless the code or conversation changed since.

## Review the checks

Set each check to Complete, Broken, Change requested, or Skipped, and add a note. Choosing **Not
checked** clears a verdict. Changes save immediately, and another device viewing the same review
sees them. If two devices change the same check, the second save is refused and shows the other
device's version, with your draft kept so you can apply it again.

When the code a check covers changes, the check shows **Needs retest** and says whether its text or
its code changed. Your previous verdict and note stay; setting a new verdict clears the marker.
Revdoc refreshes these markers when you open the review, and **Refresh** does it on demand without
calling a model.

Running Revdoc again updates the same review. Checks keep their verdicts and notes, new work gets
new checks, and checks the agent no longer proposes are marked **Stale**. Dismiss a stale check to
hide it; **Restore** brings it back from the Dismissed group. **Delete review** in the header menu
removes the whole review so the next run starts fresh.

Checks are edited only between generation passes. While Revdoc generates, the checklist is read
only on every device.

## Test with AI

**Test with AI** sends an agent to test the remaining checks: those without a passing result, with a
failed result, or needing retest. You can also retry failed checks or test a single check. The
agent runs as a child thread of your thread, in the same worktree, and records each result as it
finishes, with screenshots for browser checks.

If your thread is idle, Revdoc first posts a short message to it, because a child agent can only
start from an active turn. Open the child thread from the review or from the card in your thread's
timeline to watch the agent, answer its questions, or approve its commands. Stopping the pass, from
the review or from the child thread, keeps every result already recorded.

Browser checks need agent browser access and a connected browser. Without them, those checks are
recorded as blocked with the reason.

## Ask the agent to fix findings

**Draft fix request** adds the broken, change-requested, and failed checks to your composer, after
anything you already typed, and does not send it. The request names each check's id so the agent
can look it up with the `revdoc_read` tool. Agents can also run passes with `revdoc_generate` and
`revdoc_test`. Tools without MCP access can read `.revdoc/review.json` in the worktree, which
Revdoc rewrites after every change. Revdoc never reads that file back, so editing it changes
nothing.

## Settings

**Settings → General → Text generation → Revdoc** sets the review model, a separate model for large
batched reviews, the testing model, and whether Revdoc tests after generating. Each model defaults to
**Automatic**, which uses the thread's model; the large review and testing models fall back to the
review model first. Choose another model if a provider cannot run Revdoc passes.

## When a worktree goes away

Removing a worktree, including automatic cleanup of settled worktrees, deletes its review. Removing
a project deletes its reviews. A review for a project's main checkout stays until you delete it.
