# Documents and manual reviews

Ask the agent to publish a plan, report, or verification checklist to the thread's
Documents panel. Publishing retains a copy, so changing or deleting the original
working file does not change the version you reviewed. Documents belong to the
environment running the thread and remain available when you connect remotely.

Open **Documents** from the thread. A review checklist lets you mark each item as
complete, broken, change requested, skipped, or not checked, and add notes.
**Save draft** preserves your answers without sending a message to the agent.
**Submit to agent** saves a fixed review result and sends it into the same thread.
Submitting a review does not mean every item passed. Markdown export remains
available if you want to keep or share a report yourself.

History keeps published versions, saved answers, submissions, and delivery
results. Submitted and older document versions are read-only. Ask the agent to
publish a new revision for another review; the new revision starts with fresh
answers. If another device saves while you are editing, retain your notes and
reload the saved state before making a new save.

A submission can be saved even if sending it to the agent fails. Retry delivery
of that saved submission rather than submitting the review again. The original
thread, document version, and results stay attached to the retry.

Interactive HTML documents can offer their own controls. Compatible documents
can load and save answers through SatelliteT3; use the surrounding app controls to
submit a review. Ordinary HTML files still open in the file viewer without being
registered as managed documents.

T3's built-in proposed plans remain part of the conversation. A plan written as a
file becomes a managed document when the agent publishes it. Provider session
history and unpublished working files retain their existing storage locations.

The [Open work timeline](issues-and-open-work.md) places published versions beside
the worktree's commits. A publication keeps its original worktree association
even if its thread later moves. Folder-linked Markdown and HTML files are live
references and remain separate from retained publications.

## Worktree reviews

Run **Revdoc** beside Commit to create or update a review checklist in the
background. The first pass automatically sets up the worktree's `.revdoc/` storage
and evidence folder; no separate Revdoc installation is needed.
Open the review from its dropdown to record outcomes, notes, and
inspect any attached evidence. Threads in the same worktree share the same
review, saved in the gitignored `.revdoc/review.json`. Agents can read that file
or use `read_revdoc` to pick up your feedback without an export.

Choose the provider, model, and effort under **Settings → General → Text
generation → Revdoc**. Automatic uses the current thread's provider and model.
Large reviews automatically run in batches and combine into one checklist. Choose
a separate provider, model, and effort under **Large Revdoc model**; Automatic uses
the Revdoc model, then the thread's model. The sidebar reports progress, and the
worktree review panel shows what the model is doing in each batch. The checklist
saves and becomes available as each batch finishes, including while sections are
being combined. If a session limit, cancellation, or server restart interrupts the
pass, run **Revdoc** again to continue from the saved batches. You can change the
Revdoc model before continuing. Changes to the source or conversation start a new
pass while preserving your saved review and feedback. Partial reviews remain
labelled until generation finishes.
A pass gathers the thread's recent conversation and the worktree's changes,
including commits since its default branch. The generation pass creates a checklist. Reruns preserve notes and outcomes, while
changed test instructions return to Not tested. If another device or agent edits
the review during a pass, the saved review is preserved and the pass reports a
conflict. If the worktree changes during generation, run a new pass for the current
changes. Refresh the review to load edits made outside Satellite.

Use **Test with AI** in the review to run remaining checks in the background.
Progress, agent activity, questions, and approvals stay in the review sidebar. Choose its provider, model, and effort under **Revdoc testing model** in
Settings. Automatic uses the review model, falling back to the original thread's
model. **Generate & test** runs both steps; **Test after generating Revdoc** makes
that the header button's default.

AI results save as each check finishes, with observed behavior and captured
Browser screenshots. Browser checks require agent Browser access and a connected
Browser host; unavailable checks are marked blocked. Expand agent activity to
inspect the run; answer questions and approvals directly in the review. Stopping a pass preserves
completed results. Retry remaining checks, failed checks, or an individual check.

Your review verdict and notes stay separate from AI results. Refresh the review
to compare results with the current code; changes to code or check instructions
mark older results as needing a retest. Previous attempts and their evidence remain
available. **Draft fix request** adds failed checks to your composer for you to
review and send.
