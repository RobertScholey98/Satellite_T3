# Engineering managers

An engineering manager is a long-running agent thread that runs a project's
engineering work on your behalf. It plans, commissions implementation teams,
watches their progress, and brings decisions to you. You stay in charge: teams
work inside a file boundary you approve, PRs need your approval unless you grant
more autonomy, and every pause, grant, and approval can be undone.

Managers are available on web and desktop.

## Before you start

The project's environment needs:

- An authenticated Codex provider. Codex accounts stored only in a native keyring
  need file-backed Codex authentication first.
- A local Docker engine running Linux containers. Managed agents run only inside
  containers, without your Git credentials or the Docker socket. The first setup
  builds the runner image, which takes a few minutes.
- A Git repository of skills you own, pinned to an exact commit.

## Create a manager

Open **Project settings → Engineering manager** and choose **Create manager**.
Pick the model and the skills repository commit. Each project has one manager.

The manager first runs an onboarding investigation on a read-only copy of the
committed files (untracked files and credential paths are left out). Review its
report, then approve the project's execution boundary: which files teams may
edit, where they may create files, which files are protected controls, and which
checks must pass. Teams cannot change protected controls without a task you
authorize for that purpose.

If the project's controls change later, for example after you merge a rule
change, work waits with an explanation. Choose **Refresh baseline** in the
boundary dialog or the waiting assignment to adopt the current commit's
controls. Running teams keep the baseline they started with.

## Give work

Message the manager to ask for work. Each message authorizes one commission; ask
again for more. You can also use **Assign work** to set the task, completion
condition, and permitted files directly, or **Hand over thread** to give an
existing thread's work to a new team. A team's lead appears under the manager as
an ordinary thread you can open and message at any time.

To let the manager pick up tickets itself, connect a project board in **Delivery
settings → Project work scheduling** and set a concurrency limit. Only tickets
in the board's Ready column are eligible; agent-filed tickets wait in triage
until you move them. To have the manager prepare a ticket that isn't Ready, enter
its number under **Bring in a board ticket** in the project work queue, or ask
the manager. It prepares the scope and recommends whether the ticket is ready,
but the ticket starts only once it is Ready or you assign it.

## Stay in control

- **Controls** beside the manager pause the manager, or the manager and all its
  teams. Pausing preserves edited work, and **Resume** releases only that pause.
  If stopping a team fails, retry the stop or resume.
- Messages you send to a managed thread are guidance for its lead. If a message
  changes scope or priority, use **Send to manager** in the thread's controls so
  the manager decides too.
- **Take over thread** lets you work directly with any managed thread. **Hand
  back thread** returns it to its lead.
- **Cancel assignment** stops a team. You'll be asked for a reason for its
  retrospective.
- **Retire manager** stops the manager for good and cancels its unfinished
  teams. History stays readable, and you can create a new manager for the
  project afterwards.
- **Autonomy defaults** and each manager's autonomy settings control what
  managers may do without asking. Reducing a permission applies to running work
  immediately; increases apply to new work unless you extend them explicitly.

Forks of managed threads are ordinary threads. They are not managed and do not
run in the container.

After a server restart, interrupted leads continue on their own unless they are
paused, taken over, or waiting.

## Review and merge

Each team owns its PR, independent review, and required checks. Open
**Assignment details → Delivery and review** to see the exact head, evidence,
and anything still outstanding. Your approval applies to that exact head; new
commits need fresh approval, but main moving does not. To allow routine
autonomous merges, set a project merge rule and grant the manager delivery
autonomy. Both must allow the work.

UI changes pause for your approval of the proposed flow, and substantial UI work
gets an isolated preview with screenshots. Configure the preview entry point in
**Delivery settings** first. Previews run Node entry points only. Without an
approved preview, UI work comes to you marked "UX verification unavailable", so
check the change yourself before approving.

## Work across projects

Use **Project collaboration** to ask another project's manager for help. When
work spans projects, commission an integration team to test the combined change.
Member PRs then form a merge group: they wait for one combined review and merge
together. If a shared merge only partly succeeds, the integration lead
reconciles and retries within its limits, and escalates to you when it cannot.
A refused or rate-limited merge waits for a deliberate retry; each member gets
three submissions.

To let members merge on their own, stop the shared merge, then choose
**Release merge group** in the combined review. Each PR then needs its own
approval. **Group these PRs again** undoes a release while the integration is
active. Cancelling or concluding the integration releases its group.

A change to a request's agreed outcome, acceptance or compatibility is a plan
that both managers, or you, must approve before it replaces the recorded
commitments; the supporting work keeps running. When a manager asks to grant an
integration team more than its project's qualified test capability, the request
waits in the integration team's panel for you to approve or decline.

### Hold deployment until the whole group merges

Satellite labels each grouped PR `satellite-merge-group` as soon as the group
knows it, and sets a `satellite/merge-group` status on its merge commit. The
status stays `pending` while any member is unmerged, becomes `success` once
every merge is confirmed, and becomes `failure` if you stop the shared merge.
Only GitHub pull requests get this signal. The integration thread shows
**Deployment gate unavailable** until every member has published one.

To make a GitHub Actions deployment wait, copy
[`merge-group-gate.mjs`](../../scripts/factory/merge-group-gate.mjs) to
`.github/scripts/` in your repository and run it as its own job. The deploy job keeps its own environment,
approvals and credentials:

```yaml
jobs:
  merge-group-gate:
    runs-on: ubuntu-latest
    permissions: { contents: read, pull-requests: read, statuses: read }
    steps:
      - uses: actions/checkout@v4
      - run: node .github/scripts/merge-group-gate.mjs --timeout 1800
        env:
          GITHUB_TOKEN: ${{ github.token }}
  deploy:
    needs: merge-group-gate
    environment: production
    # your existing deploy steps
```

Ungrouped commits pass straight through, so removing the label from a PR
disarms the gate for it. Releasing a group removes the label from its unmerged
PRs. If the gate times out, the job fails with a message; re-run it once the
group has merged. To see why a group is waiting, check the
`satellite/merge-group` status on the commit in GitHub and the shared merge in
the merge group review.

### Block merges outside Satellite

While a group waits, each member PR's head commit carries a `pending`
`satellite/merge-group` status, which turns `success` while Satellite runs the
shared merge or after the group is released. To make GitHub refuse merges from
github.com in the meantime, add `satellite/merge-group` as a required status
check in the branch's protection rules. Required checks apply to every PR into
that branch, including PRs Satellite never grouped, so only require it where
that fits your workflow. Satellite never changes branch protection itself.

## Retrospectives and shared improvements

When work concludes, the team and then its manager write retrospectives. Read
them in **Assignment details → Completion and retrospective**. Follow-up tickets
go to the triage destination you configure in **Delivery settings**. The
assignment completes once each ticket the manager files reaches triage. If a
ticket can't be filed, waive it from the follow-up with a reason; **Retry ticket
publication** files it after all.

A **System manager** reviews retrospective findings across projects and
proposes changes to your shared skills. Escalations reach it promptly; without
one, they come to you. Escalations beyond the daily allowance in **Review
settings** wait for the next day, or until you choose **Review escalations
now**. You decide on every
proposal and on adopting each workflow release. A deferred proposal stays open
until you record another decision. **Workflow delivery** lets you adopt a release as the default
or for one manager, and reset that choice later. To replace the system manager,
use **Retire system manager…** in **Shared improvements → Manager controls**
and give a reason, then
**Create system manager** in the sidebar; the new one takes over your shared
repositories, pending evidence and unstarted work plans.

## Troubleshooting

- **Setup can't start**: check that Docker is running Linux containers and
  Codex is signed in with file-backed authentication.
- **Work is waiting on the execution boundary**: a protected control changed.
  Review the change, then use **Refresh baseline**.
- **A team stopped unexpectedly**: the manager opens a recovery incident and
  diagnoses it within a bounded allowance, then brings you a decision with a
  recommendation.
